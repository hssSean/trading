import axios from 'axios';
import { Candle, Timeframe } from '../types';

// All data comes from the Futures API — perpetual contracts only
const client = axios.create({ baseURL: 'https://fapi.binance.com/fapi/v1', timeout: 10000 });

const INTERVAL_MAP: Record<Timeframe, string> = {
  '15m': '15m',
  '1h':  '1h',
  '4h':  '4h',
  '1d':  '1d',
};

export async function fetchCandles(
  symbol: string,
  timeframe: Timeframe,
  limit = 200,
): Promise<Candle[]> {
  const res = await client.get('/klines', {
    params: { symbol, interval: INTERVAL_MAP[timeframe], limit },
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
