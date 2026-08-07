import axios from 'axios';
import { Candle, Timeframe } from '../types';

// All data comes from the Futures API — perpetual contracts only
const client = axios.create({ baseURL: 'https://fapi.binance.com/fapi/v1', timeout: 10000 });

const INTERVAL_MAP: Record<Timeframe, string> = {
  '5m':  '5m',
  '15m': '15m',
  '1h':  '1h',
  '4h':  '4h',
  '1d':  '1d',
};

export async function fetchCandles(
  symbol: string,
  timeframe: Timeframe,
  limit = 200,
  retries = 3,
  startTime?: number,
): Promise<Candle[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await client.get('/klines', {
        params: {
          symbol,
          interval: INTERVAL_MAP[timeframe],
          limit,
          ...(startTime !== undefined ? { startTime } : {}),
        },
      });
      return res.data.map((k: unknown[]) => ({
        openTime:  k[0] as number,
        open:      parseFloat(k[1] as string),
        high:      parseFloat(k[2] as string),
        low:       parseFloat(k[3] as string),
        close:     parseFloat(k[4] as string),
        volume:    parseFloat(k[5] as string),
        closeTime: k[6] as number,
      }));
    } catch (err) {
      lastErr = err;
      if (attempt < retries - 1) await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export async function fetchTicker24h(symbol: string): Promise<{
  price: number;
  priceChange: number;
  priceChangePercent: number;
}> {
  const res = await client.get('/ticker/24hr', { params: { symbol } });
  return {
    price:               parseFloat(res.data.lastPrice),
    priceChange:         parseFloat(res.data.priceChange),
    priceChangePercent:  parseFloat(res.data.priceChangePercent),
  };
}

export async function fetchCurrentPrice(symbol: string): Promise<number> {
  const res = await client.get('/ticker/price', { params: { symbol } });
  return parseFloat(res.data.price);
}

// Thrown when Binance rate-limits us (429/418). Callers back off instead of
// hammering — a banned IP takes minutes to clear and kills every other request.
export class RateLimitedError extends Error {
  constructor() { super('binance rate limited'); this.name = 'RateLimitedError'; }
}

function isRateLimit(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  if (status === 429 || status === 418) return true;
  const msg = String(err).toLowerCase();
  return msg.includes('429') || msg.includes('418') || msg.includes('too many');
}

// 2026-08-07：這裡原本是「每個 symbol 各發一個獨立請求，Promise.allSettled
// 全部同時打」——當初的假設是監控清單只有 15 個幣種（見下面保留的舊註解）。
// 監控清單漲到 100 個之後，這個假設早就不成立：fast loop 每 3 秒同時發出
// 100 個併發請求，遠超瀏覽器對同一 host 的連線數上限，大部分請求排隊甚至
// 逾時——正式站實測首頁現價欄位持續顯示「—」，用瀏覽器連線工具查到的就是
// 這個模式（跟 saveToSupabase 併發過多同一種 bug，只是這裡是每 3 秒發生
// 一次，頻率高得多）。
//
// 改回批次端點，一次請求拿全市場約 500 個永續合約價格再篩選出要的——
// 不管監控幾個幣種，每輪固定只有 1 個 HTTP 請求。舊註解擔心的「500 個
// symbol 換 15 個要的資料，浪費」在監控清單只有 15 個時成立，100 個之後
// 100 個獨立請求（含各自的 TLS/HTTP overhead、還會撞連線數上限被迫排隊）
// 比 1 個 25KB 的批次請求還糟，前提變了決策就該跟著變。
//
// 錯誤處理維持原樣：rate limit 讓呼叫端知道要整體退避，其他錯誤（離線/
// 逾時）原樣往上拋，呼叫端（PriceFeed.tsx）本來就靜默處理、等下一輪重試。
export async function fetchPricesFor(symbols: string[]): Promise<Map<string, number>> {
  const wanted = new Set(symbols);
  const out = new Map<string, number>();
  try {
    const res = await client.get('/ticker/price');
    for (const t of res.data as { symbol: string; price: string }[]) {
      if (!wanted.has(t.symbol)) continue;
      const px = parseFloat(t.price);
      if (Number.isFinite(px) && px > 0) out.set(t.symbol, px);
    }
  } catch (err) {
    if (isRateLimit(err)) throw new RateLimitedError();
    throw err;
  }
  return out;
}

export interface Ticker24h {
  price: number;
  priceChange: number;
  priceChangePercent: number;
}

// 同一批次改法，同一個理由（見 fetchPricesFor 上面的說明）——這個是慢迴圈
// （60 秒一次），併發量沒有 fast loop 那麼致命，但同樣不該隨監控幣種數線性
// 成長，一次批次請求解決。
export async function fetchTickers24hFor(symbols: string[]): Promise<Map<string, Ticker24h>> {
  const wanted = new Set(symbols);
  const out = new Map<string, Ticker24h>();
  try {
    const res = await client.get('/ticker/24hr');
    for (const t of res.data as { symbol: string; lastPrice: string; priceChange: string; priceChangePercent: string }[]) {
      if (!wanted.has(t.symbol)) continue;
      const price = parseFloat(t.lastPrice);
      if (Number.isFinite(price) && price > 0) {
        out.set(t.symbol, {
          price,
          priceChange:        parseFloat(t.priceChange),
          priceChangePercent: parseFloat(t.priceChangePercent),
        });
      }
    }
  } catch (err) {
    if (isRateLimit(err)) throw new RateLimitedError();
    throw err;
  }
  return out;
}

export async function validateSymbol(symbol: string): Promise<boolean> {
  try {
    await client.get('/ticker/price', { params: { symbol } });
    return true;
  } catch {
    return false;
  }
}

export async function searchSymbols(query: string): Promise<string[]> {
  const res = await client.get('/exchangeInfo');
  return (res.data.symbols as { symbol: string; status: string; contractType: string }[])
    .filter(
      (s) =>
        s.status === 'TRADING' &&
        s.contractType === 'PERPETUAL' &&
        s.symbol.endsWith('USDT') &&
        s.symbol.toLowerCase().includes(query.toLowerCase()),
    )
    .map((s) => s.symbol)
    .slice(0, 20);
}

// Stablecoin / leveraged token patterns to exclude
const EXCLUDE = /^(USDC|BUSD|TUSD|USDP|FDUSD|DAI|EUR|GBP|AUD|BVOL|IBVOL|BEAR|BULL|UP|DOWN|3L|3S)/;

// ── Funding Rate ─────────────────────────────────────────────
// Uses /fapi/v1/premiumIndex — public, no API key required.
// Returns the latest funding rate as a decimal (e.g. 0.001 = 0.1%).
// In-process cache: funding rates update every 8h so 10min TTL is fine.
const _frCache = new Map<string, { rate: number; at: number }>();
const FR_TTL_MS = 10 * 60 * 1000;

export async function fetchFundingRate(symbol: string): Promise<number> {
  const cached = _frCache.get(symbol);
  if (cached && Date.now() - cached.at < FR_TTL_MS) return cached.rate;

  try {
    const res = await client.get('/premiumIndex', { params: { symbol } });
    const rate = parseFloat(res.data.lastFundingRate ?? '0');
    _frCache.set(symbol, { rate, at: Date.now() });
    return rate;
  } catch {
    // If API fails return 0 (neutral — no distortion to scoring)
    return 0;
  }
}

export async function fetchTopCoinsByVolume(limit = 10): Promise<string[]> {
  // Use exchangeInfo to get only PERPETUAL symbols, then sort by volume
  const [infoRes, tickerRes] = await Promise.all([
    client.get('/exchangeInfo'),
    client.get('/ticker/24hr'),
  ]);

  const perpetuals = new Set<string>(
    (infoRes.data.symbols as { symbol: string; status: string; contractType: string }[])
      .filter((s) => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.symbol.endsWith('USDT'))
      .map((s) => s.symbol),
  );

  return (tickerRes.data as { symbol: string; quoteVolume: string }[])
    .filter(
      (t) =>
        perpetuals.has(t.symbol) &&
        !EXCLUDE.test(t.symbol.replace('USDT', '')),
    )
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, limit)
    .map((t) => t.symbol);
}
