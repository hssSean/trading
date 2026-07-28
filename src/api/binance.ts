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

// Parallel price fetch for a symbol list. Replaces the old per-page
// `for (sym of syms) { await fetch; await sleep(100) }` pattern, which cost
// ~N × (roundtrip + 100ms) per round — 15 coins took 4-5s to refresh one cycle.
// Here the whole set costs one roundtrip. Weight is 1/symbol, same as before.
//
// Not using the no-symbol batch endpoint (`/ticker/price` with no params):
// it returns all ~500 perpetuals (~25KB) per call, which at a 3s interval is
// ~500KB/min of mobile data for 15 coins' worth of information.
//
// Partial failures are dropped, not thrown — one bad symbol must not blank out
// the rest. A rate limit is the exception: it means back off entirely.
export async function fetchPricesFor(symbols: string[]): Promise<Map<string, number>> {
  const settled = await Promise.allSettled(
    symbols.map(s => client.get('/ticker/price', { params: { symbol: s } })),
  );
  const out = new Map<string, number>();
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === 'fulfilled') {
      const px = parseFloat(r.value.data.price);
      if (Number.isFinite(px) && px > 0) out.set(symbols[i], px);
    } else if (isRateLimit(r.reason)) {
      throw new RateLimitedError();
    }
  }
  return out;
}

export interface Ticker24h {
  price: number;
  priceChange: number;
  priceChangePercent: number;
}

// Same parallel shape as fetchPricesFor, for the slower 24h-change refresh.
export async function fetchTickers24hFor(symbols: string[]): Promise<Map<string, Ticker24h>> {
  const settled = await Promise.allSettled(
    symbols.map(s => client.get('/ticker/24hr', { params: { symbol: s } })),
  );
  const out = new Map<string, Ticker24h>();
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === 'fulfilled') {
      const price = parseFloat(r.value.data.lastPrice);
      if (Number.isFinite(price) && price > 0) {
        out.set(symbols[i], {
          price,
          priceChange:        parseFloat(r.value.data.priceChange),
          priceChangePercent: parseFloat(r.value.data.priceChangePercent),
        });
      }
    } else if (isRateLimit(r.reason)) {
      throw new RateLimitedError();
    }
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
