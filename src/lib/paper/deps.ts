// 紙上策略執行器的正式依賴（幣安公開 API）。單元測試用假的，這裡只在 route／腳本使用。
import { fetchClosedBars, fetchPerpTickers, fetchFundingHistory } from '@/api/binance';
import type { PaperDeps } from './runner';

async function retry<T>(fn: () => Promise<T>, n = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise(r => setTimeout(r, 600 * (i + 1))); }
  }
  throw last;
}

export const binancePaperDeps: PaperDeps = {
  tickers: () => retry(fetchPerpTickers),
  klines: (symbol, interval, limit, startTime) => retry(() => fetchClosedBars(symbol, interval, limit, startTime)),
  funding: (symbol, startTime) => retry(() => fetchFundingHistory(symbol, 1000, startTime)),
};
