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

/**
 * 已結算的資金費率歷史（依時間排序）。S3／S1 資金費過濾用（src/lib/s3s1/）。
 * 跟上面 fetchFundingRate 不同：那個回「最近一次」的單一值、失敗回 0；這個失敗就丟錯，
 * 讓呼叫端跳過這檔幣——拿 0 冒充歷史會讓百分位判斷整個錯掉。
 */
export async function fetchFundingHistory(
  symbol: string, limit = 100, startTime?: number,
): Promise<{ t: number; rate: number }[]> {
  const res = await client.get('/fundingRate', {
    params: { symbol, limit, ...(startTime !== undefined ? { startTime } : {}) },
  });
  return (res.data as { fundingTime: number; fundingRate: string }[])
    .map(x => ({ t: x.fundingTime, rate: parseFloat(x.fundingRate) }))
    .sort((a, b) => a.t - b.t);
}

/**
 * 已收盤 K 線（含成交額 qv）。S3／S1 幣池排名用（src/lib/s3s1/）。
 * 跟 fetchCandles 不同：會丟掉還在跑的最後一根——紙上策略的所有規則都只吃已收盤 K 棒。
 */
export async function fetchClosedBars(
  symbol: string, interval: '1h' | '4h' | '12h' | '1d', limit: number, startTime?: number,
): Promise<{ t: number; o: number; h: number; l: number; c: number; qv: number }[]> {
  const res = await client.get('/klines', {
    params: { symbol, interval, limit, ...(startTime !== undefined ? { startTime } : {}) },
  });
  const now = Date.now();
  return (res.data as unknown[][])
    .filter(k => (k[6] as number) < now)
    .map(k => ({ t: k[0] as number, o: +(k[1] as string), h: +(k[2] as string), l: +(k[3] as string), c: +(k[4] as string), qv: +(k[7] as string) }));
}

/** USDT 本位、PERPETUAL、TRADING 的合約與 24h 成交額 */
export async function fetchPerpTickers(): Promise<{ symbol: string; quoteVolume: number }[]> {
  const [info, tick] = await Promise.all([client.get('/exchangeInfo'), client.get('/ticker/24hr')]);
  const perp = new Set((info.data.symbols as { symbol: string; status: string; contractType: string; quoteAsset: string }[])
    .filter(s => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT')
    .map(s => s.symbol));
  return (tick.data as { symbol: string; quoteVolume: string }[])
    .filter(t => perp.has(t.symbol))
    .map(t => ({ symbol: t.symbol, quoteVolume: +t.quoteVolume }));
}

// ── Open Interest change ─────────────────────────────────────
// 2026-08-10：拒絕漏斗診斷後續清單 #7——未平倉合約(OI)變化率，用來輔助
// 判斷「新資金進場」還是「空頭回補」。先做顯示（訊號分析依據多一條
// 資訊），不做硬性擋單——還沒有拒絕漏斗歷史數據驗證這個指標對這個策略
// 有沒有用，貿然拿來擋單風險高（CLAUDE.md 調參紀律：先看數據再決定）。
//
// 用 /futures/data/openInterestHist——不在 /fapi/v1 base path 下，這裡
// 用絕對 URL 覆蓋 client 的 baseURL（axios 對絕對 URL 會忽略 baseURL，
// 不用另外建一個 axios instance）。只能查最近 30 天資料；period 用 1h
// 跟其他指標的時間粒度一致。抓 lookbackHours+1 筆，用最舊/最新兩筆算
// 變化率——不自己維護歷史狀態（Redis/DB），每次直接跟交易所要，簡單可靠。
const _oiCache = new Map<string, { changePct: number; at: number }>();
const OI_TTL_MS = 10 * 60 * 1000; // 跟 funding rate 同樣的 TTL

export async function fetchOpenInterestChange(symbol: string, lookbackHours = 4): Promise<number | null> {
  const cached = _oiCache.get(symbol);
  if (cached && Date.now() - cached.at < OI_TTL_MS) return cached.changePct;

  try {
    const res = await client.get('https://fapi.binance.com/futures/data/openInterestHist', {
      params: { symbol, period: '1h', limit: lookbackHours + 1 },
    });
    const rows: Array<{ sumOpenInterest: string }> = res.data;
    if (!Array.isArray(rows) || rows.length < 2) return null;
    const oldest = parseFloat(rows[0].sumOpenInterest);
    const latest = parseFloat(rows[rows.length - 1].sumOpenInterest);
    if (!(oldest > 0)) return null;
    const changePct = ((latest - oldest) / oldest) * 100;
    _oiCache.set(symbol, { changePct, at: Date.now() });
    return changePct;
  } catch {
    // API 失敗回傳 null（不是 0）——0 代表「沒變化」是一個具體的判斷結果，
    // null 才是「不知道」，呼叫端要能區分兩者，不然會誤判成「OI 真的沒變」。
    return null;
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

/** 全部 USDT 本位永續（TRADING）與下單限制（S3／S1 帳戶模擬算數量用） */
export async function fetchPerpFilters(): Promise<Map<string, { stepSize: number; minQty: number; minNotional: number }>> {
  const res = await client.get('/exchangeInfo');
  const out = new Map<string, { stepSize: number; minQty: number; minNotional: number }>();
  for (const s of res.data.symbols as { symbol: string; status: string; contractType: string; quoteAsset: string; filters: { filterType: string; stepSize?: string; minQty?: string; notional?: string }[] }[]) {
    if (s.status !== 'TRADING' || s.contractType !== 'PERPETUAL' || s.quoteAsset !== 'USDT') continue;
    const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
    const mn = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
    out.set(s.symbol, { stepSize: +(lot?.stepSize ?? 0), minQty: +(lot?.minQty ?? 0), minNotional: +(mn?.notional ?? 0) });
  }
  return out;
}

/** 第一根 1H 的開盤時間（≈ 上市時間） */
export async function fetchListingHour(symbol: string): Promise<number> {
  const res = await client.get('/klines', { params: { symbol, interval: '1h', startTime: 0, limit: 1 } });
  const k = res.data as unknown[][];
  return k.length ? (k[0][0] as number) : 0;
}
