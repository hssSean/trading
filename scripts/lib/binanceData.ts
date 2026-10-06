/**
 * 幣安永續合約歷史資料（K 線、資金費率），帶磁碟快取——重跑不必再打幣安。
 * verify-strategy.ts 與 strategy-candidates.ts 共用。
 */
import axios from 'axios';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Candle } from '../../src/types';

export const CACHE_DIR = join(tmpdir(), 'verify-strategy-cache');
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

const api = axios.create({ baseURL: 'https://fapi.binance.com/fapi/v1', timeout: 20_000 });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function getJson<T>(path: string, params: Record<string, unknown>): Promise<T> {
  for (let a = 0; a < 4; a++) {
    try { return (await api.get(path, { params })).data as T; }
    catch (e) { if (a === 3) throw e; await sleep(1000 * (a + 1)); }
  }
  throw new Error('unreachable');
}

export type KlineInterval = '1h' | '4h' | '1d';
const STEP: Record<KlineInterval, number> = { '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };

/** 只回傳 endMs 之前已收盤的 K 棒 */
export async function fetchKlines(symbol: string, interval: KlineInterval, startMs: number, endMs: number): Promise<Candle[]> {
  const day = Math.floor(endMs / 86_400_000);
  const file = join(CACHE_DIR, `${symbol}-${interval}-${startMs}-${day}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf-8'));
  const out: Candle[] = [];
  let from = startMs;
  while (from < endMs) {
    const rows = await getJson<unknown[][]>('/klines', { symbol, interval, startTime: from, limit: 1500 });
    if (!rows.length) break;
    for (const k of rows) {
      const c: Candle = {
        openTime: k[0] as number, open: +(k[1] as string), high: +(k[2] as string), low: +(k[3] as string),
        close: +(k[4] as string), volume: +(k[5] as string), closeTime: k[6] as number,
      };
      if (c.closeTime < endMs) out.push(c);
    }
    from = (rows[rows.length - 1][0] as number) + STEP[interval];
    if (rows.length < 1500) break;
    await sleep(200);
  }
  const seen = new Set<number>();
  const dedup = out.filter(c => (seen.has(c.openTime) ? false : (seen.add(c.openTime), true)));
  writeFileSync(file, JSON.stringify(dedup), { encoding: 'utf-8' });
  return dedup;
}

export interface QvBar { t: number; o: number; h: number; l: number; c: number; qv: number }

/** 跟 fetchKlines 一樣但帶成交額 qv（幣池排名要用）；另外的快取檔，不影響既有快取。 */
export async function fetchBars(symbol: string, interval: '1h' | '12h' | '1d', startMs: number, endMs: number): Promise<QvBar[]> {
  const day = Math.floor(endMs / 86_400_000);
  const file = join(CACHE_DIR, `bars-${symbol}-${interval}-${startMs}-${endMs}-${day}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf-8'));
  const step = interval === '1h' ? 3_600_000 : interval === '12h' ? 43_200_000 : 86_400_000;
  const out: QvBar[] = [];
  let from = startMs;
  while (from < endMs) {
    const rows = await getJson<unknown[][]>('/klines', { symbol, interval, startTime: from, limit: 1000 });
    if (!rows.length) break;
    for (const k of rows) {
      if ((k[6] as number) >= endMs) continue;
      out.push({ t: k[0] as number, o: +(k[1] as string), h: +(k[2] as string), l: +(k[3] as string), c: +(k[4] as string), qv: +(k[7] as string) });
    }
    from = (rows[rows.length - 1][0] as number) + step;
    if (rows.length < 1000) break;
    await sleep(250);
  }
  writeFileSync(file, JSON.stringify(out), { encoding: 'utf-8' });
  return out;
}

export interface Funding { t: number; rate: number }
export async function fetchFunding(symbol: string, startMs: number, endMs: number): Promise<Funding[]> {
  const day = Math.floor(endMs / 86_400_000);
  const file = join(CACHE_DIR, `${symbol}-funding-${startMs}-${day}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf-8'));
  const out: Funding[] = [];
  let from = startMs;
  while (from < endMs) {
    const rows = await getJson<{ fundingTime: number; fundingRate: string }[]>('/fundingRate', { symbol, startTime: from, limit: 1000 });
    if (!rows.length) break;
    for (const r of rows) out.push({ t: r.fundingTime, rate: +r.fundingRate });
    from = rows[rows.length - 1].fundingTime + 1;
    if (rows.length < 1000) break;
    await sleep(200);
  }
  writeFileSync(file, JSON.stringify(out), { encoding: 'utf-8' });
  return out;
}

/** (a, b] 之間結算的資金費率合計。f 須依時間排序。 */
export function fundingBetween(f: Funding[], a: number, b: number): number {
  let s = 0;
  for (const x of f) { if (x.t > b) break; if (x.t > a) s += x.rate; }
  return s;
}

export async function topSymbols(n: number): Promise<string[]> {
  const [info, tick] = await Promise.all([
    getJson<{ symbols: { symbol: string; status: string; contractType: string }[] }>('/exchangeInfo', {}),
    getJson<{ symbol: string; quoteVolume: string }[]>('/ticker/24hr', {}),
  ]);
  const perp = new Set(info.symbols
    .filter(s => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.symbol.endsWith('USDT'))
    .map(s => s.symbol));
  const EX = /^(USDC|BUSD|TUSD|USDP|FDUSD|DAI|EUR|GBP|AUD|BVOL|IBVOL|BEAR|BULL|UP|DOWN|3L|3S)/;
  return tick
    .filter(t => perp.has(t.symbol) && !EX.test(t.symbol.replace('USDT', '')))
    .sort((a, b) => +b.quoteVolume - +a.quoteVolume)
    .slice(0, n).map(t => t.symbol);
}
