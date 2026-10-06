// S3／S1 帳戶模擬的正式依賴（幣安正式站公開行情——文件 §2.1：訊號一律用正式站算）。
import { fetchClosedBars, fetchFundingHistory, fetchPerpFilters, fetchListingHour } from '@/api/binance';
import type { Deps } from './engine';

async function retry<T>(fn: () => Promise<T>, n = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise(r => setTimeout(r, 700 * (i + 1))); }
  }
  throw last;
}

export const binanceS3S1Deps: Deps = {
  exchange: () => retry(fetchPerpFilters),
  klines: (symbol, interval, limit, startTime) => retry(() => fetchClosedBars(symbol, interval, limit, startTime)),
  funding: (symbol, startTime) => retry(() => fetchFundingHistory(symbol, 1000, startTime)),
  listingHour: symbol => retry(() => fetchListingHour(symbol)),
};
