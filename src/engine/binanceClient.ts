// Authenticated Binance Futures client. Unlike src/api/binance.ts (public market
// data, no auth), everything here signs requests with the account's API secret
// and can move real money. Read this whole file before wiring it into anything
// that runs unattended — see docs/TODO.md 自動化交易 section for the deployment
// prerequisites (isolated margin, kill switch, watchdog) this assumes exist.
//
// Credentials come from env vars only (BINANCE_API_KEY / BINANCE_API_SECRET or
// their _TESTNET variants) — never hardcode, never log the secret or a full
// signed query string (the signature alone isn't sensitive, but query strings
// can carry the key in some error paths).

import { createHmac } from 'crypto';
import axios, { AxiosInstance } from 'axios';

export interface BinanceClientConfig {
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
}

export function loadBinanceConfigFromEnv(testnet: boolean): BinanceClientConfig {
  const apiKey    = testnet ? process.env.BINANCE_TESTNET_API_KEY    : process.env.BINANCE_API_KEY;
  const apiSecret = testnet ? process.env.BINANCE_TESTNET_API_SECRET : process.env.BINANCE_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error(
      testnet
        ? 'BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET not set'
        : 'BINANCE_API_KEY / BINANCE_API_SECRET not set',
    );
  }
  return { apiKey, apiSecret, testnet };
}

// Pure — signs a pre-built query string. Split out from the request methods so
// the signing itself is unit-testable without any network mocking.
export function signQuery(queryString: string, secret: string): string {
  return createHmac('sha256', secret).update(queryString).digest('hex');
}

// Pure — builds the exact query string Binance expects (insertion order matters
// for readability/debugging but NOT for the signature itself, since HMAC covers
// the whole string as sent). Filters out undefined so optional params don't
// serialize as "key=undefined".
export function buildSignedQuery(
  params: Record<string, string | number | boolean | undefined>,
  secret: string,
  timestamp: number,
  recvWindow = 5000,
): string {
  const withMeta = { ...params, timestamp, recvWindow };
  const qs = Object.entries(withMeta)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  const signature = signQuery(qs, secret);
  return `${qs}&signature=${signature}`;
}

export type OrderSide = 'BUY' | 'SELL';
export type PositionSide = 'BOTH' | 'LONG' | 'SHORT'; // BOTH unless hedge mode is enabled

export interface PlaceOrderParams {
  symbol: string;
  side: OrderSide;
  type: 'LIMIT' | 'MARKET' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET' | 'STOP' | 'TAKE_PROFIT' | 'TRAILING_STOP_MARKET';
  quantity?: number;         // omit for closePosition orders
  price?: number;            // LIMIT / STOP / TAKE_PROFIT
  stopPrice?: number;        // STOP_MARKET / TAKE_PROFIT_MARKET / STOP / TAKE_PROFIT — mapped to triggerPrice for algo orders, see toAlgoOrderBody
  timeInForce?: 'GTC' | 'GTD' | 'IOC' | 'FOK';
  goodTillDate?: number;     // required when timeInForce=GTD, ms epoch
  closePosition?: boolean;   // true for SL/TP orders that flatten the whole position
  reduceOnly?: boolean;
  newClientOrderId?: string; // idempotency key — always set this from the caller
  activatePrice?: number;    // TRAILING_STOP_MARKET only
  callbackRate?: number;     // TRAILING_STOP_MARKET only, 0.1–10 (percent)
}

// 2026-08-08：幣安 2025-12 把條件單（STOP_MARKET/TAKE_PROFIT_MARKET/STOP/
// TAKE_PROFIT/TRAILING_STOP_MARKET）從 /fapi/v1/order 移到獨立的
// /fapi/v1/algoOrder（新增/查詢/取消都是，查詢全部未成交的是
// /fapi/v1/openAlgoOrders）。舊端點對這些 type 回 -4120。來源：
// developers.binance.com Futures(USDⓈ-M) REST API → Trade 分類，
// 2026-08-08 用瀏覽器直接讀頁面內容逐字核對過端點路徑跟參數（不是猜的、
// 也不是 WebSocket API 版本——那個是 wss://ws-fapi.binance.com，路徑不同）。
//
// 判斷＋參數轉換抽成純函數，讓 tests/engine/binanceClient.test.ts 能直接測，
// 不用真的發請求。
const ALGO_ORDER_TYPES = new Set<PlaceOrderParams['type']>([
  'STOP_MARKET', 'TAKE_PROFIT_MARKET', 'STOP', 'TAKE_PROFIT', 'TRAILING_STOP_MARKET',
]);

export function isAlgoOrderType(type: PlaceOrderParams['type']): boolean {
  return ALGO_ORDER_TYPES.has(type);
}

// stopPrice→triggerPrice、newClientOrderId→clientAlgoId 是新舊端點唯一的欄位
// 改名；其他欄位原樣照抄。algoType 固定 CONDITIONAL——文件裡這是目前唯一支援
// 的值。
export function toAlgoOrderBody(params: PlaceOrderParams): Record<string, string | number | boolean | undefined> {
  return {
    algoType: 'CONDITIONAL',
    symbol: params.symbol,
    side: params.side,
    type: params.type,
    quantity: params.quantity,
    price: params.price,
    triggerPrice: params.stopPrice,
    timeInForce: params.timeInForce,
    goodTillDate: params.goodTillDate,
    closePosition: params.closePosition,
    reduceOnly: params.reduceOnly,
    clientAlgoId: params.newClientOrderId,
    activatePrice: params.activatePrice,
    callbackRate: params.callbackRate,
  };
}

export interface PositionRisk {
  symbol: string;
  positionAmt: string;     // signed: positive = long, negative = short, "0" = flat
  entryPrice: string;
  liquidationPrice: string;
  leverage: string;
  marginType: 'isolated' | 'cross';
  isolatedMargin: string;
  unRealizedProfit: string;
}

export interface OpenOrder {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  side: OrderSide;
  type: string;
  status: string;
  origQty: string;
  executedQty: string;
  stopPrice: string;
  closePosition: boolean;
}

// GET /fapi/v1/openAlgoOrders 回傳的條件單快照——2025-12 遷移後，STOP_MARKET/
// TAKE_PROFIT_MARKET/STOP/TAKE_PROFIT/TRAILING_STOP_MARKET 都活在這裡，不會
// 出現在 getOpenOrders() 裡了。watchdog 判斷「有沒有保護單」要看這個，不是
// OpenOrder。
export interface AlgoOrder {
  algoId: number;
  clientAlgoId: string;
  symbol: string;
  side: OrderSide;
  orderType: string;      // STOP_MARKET / TAKE_PROFIT_MARKET / STOP / TAKE_PROFIT / TRAILING_STOP_MARKET
  algoStatus: string;
  triggerPrice: string;
  quantity: string;
  closePosition: boolean;
}

export class BinanceFuturesClient {
  private http: AxiosInstance;
  private secret: string;

  constructor(config: BinanceClientConfig) {
    this.secret = config.apiSecret;
    this.http = axios.create({
      // 2026-08-06：demo-fapi.binance.com is Binance's current documented USDS-M
      // futures testnet REST base (developers.binance.com/docs/derivatives/
      // usds-margined-futures/general-info) — it's the API side of the
      // "Demo Trading" product embedded in the main binance.com account (the
      // old separate testnet.binancefuture.com / GitHub-login flow is a
      // different, older product). Same path structure as production
      // (/fapi/v1/..., /fapi/v2/...), just a different host.
      baseURL: config.testnet ? 'https://demo-fapi.binance.com/fapi' : 'https://fapi.binance.com/fapi',
      timeout: 10_000,
      headers: { 'X-MBX-APIKEY': config.apiKey },
    });
  }

  private async signedRequest<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): Promise<T> {
    const qs = buildSignedQuery(params, this.secret, Date.now());
    const res = await this.http.request<T>({ method, url: `${path}?${qs}` });
    return res.data;
  }

  // ── Read-only — safe to call freely, no money movement ──────────────────

  async getBalance(): Promise<Array<{ asset: string; balance: string; availableBalance: string }>> {
    return this.signedRequest('GET', '/v2/balance');
  }

  async getPositionRisk(symbol?: string): Promise<PositionRisk[]> {
    return this.signedRequest('GET', '/v2/positionRisk', { symbol });
  }

  async getOpenOrders(symbol?: string): Promise<OpenOrder[]> {
    return this.signedRequest('GET', '/v1/openOrders', { symbol });
  }

  // 條件單專用查詢——見 AlgoOrder 註解，2025-12 遷移後止損/止盈單只會出現
  // 在這裡，getOpenOrders() 查不到。
  async getOpenAlgoOrders(symbol?: string): Promise<AlgoOrder[]> {
    return this.signedRequest('GET', '/v1/openAlgoOrders', { symbol });
  }

  async getExchangeInfo(): Promise<{ symbols: unknown[] }> {
    // Public endpoint but routed through the same base URL (testnet has its own
    // exchangeInfo with potentially different filters than mainnet).
    const res = await this.http.get('/v1/exchangeInfo');
    return res.data;
  }

  async getLeverageBrackets(symbol?: string): Promise<Array<{ symbol: string; brackets: Array<{ notionalCap: number; maintMarginRatio: number }> }>> {
    return this.signedRequest('GET', '/v1/leverageBracket', { symbol });
  }

  // ── State-changing — every call here can move real money ────────────────

  async setLeverage(symbol: string, leverage: number): Promise<{ leverage: number; symbol: string }> {
    return this.signedRequest('POST', '/v1/leverage', { symbol, leverage });
  }

  // Binance rejects this with -4046 if there's an open position on the symbol —
  // callers must set margin type BEFORE placing the first order, not after.
  async setMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED'): Promise<{ code: number; msg: string }> {
    return this.signedRequest('POST', '/v1/marginType', { symbol, marginType });
  }

  async placeOrder(params: PlaceOrderParams): Promise<{ orderId: number; clientOrderId: string; status: string }> {
    if (isAlgoOrderType(params.type)) {
      const res = await this.signedRequest<{ algoId: number; clientAlgoId: string; algoStatus: string }>(
        'POST', '/v1/algoOrder', toAlgoOrderBody(params),
      );
      return { orderId: res.algoId, clientOrderId: res.clientAlgoId, status: res.algoStatus };
    }
    return this.signedRequest('POST', '/v1/order', {
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      quantity: params.quantity,
      price: params.price,
      stopPrice: params.stopPrice,
      timeInForce: params.timeInForce,
      goodTillDate: params.goodTillDate,
      closePosition: params.closePosition,
      reduceOnly: params.reduceOnly,
      newClientOrderId: params.newClientOrderId,
    });
  }

  // isAlgoOrder：呼叫端必須自己知道要取消的是條件單還是一般單（一個 orderId
  // 沒辦法從數字本身分辨是 orderId 還是 algoId 的命名空間，猜錯會撤錯單）。
  // runner.ts 的兩個呼叫點各自清楚知道自己在撤哪一種，見 runner.ts attemptCancel。
  async cancelOrder(symbol: string, orderId: number, isAlgoOrder = false): Promise<{ orderId: number; status: string }> {
    if (isAlgoOrder) {
      const res = await this.signedRequest<{ algoId: number; algoStatus: string }>(
        'DELETE', '/v1/algoOrder', { symbol, algoId: orderId },
      );
      return { orderId: res.algoId, status: res.algoStatus };
    }
    return this.signedRequest('DELETE', '/v1/order', { symbol, orderId });
  }

  async cancelAllOpenOrders(symbol: string): Promise<{ code: number; msg: string }> {
    return this.signedRequest('DELETE', '/v1/allOpenOrders', { symbol });
  }
}
