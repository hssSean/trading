// Binance Futures exchangeInfo precision handling. Without this, orders reject with
// -1111 (precision over the maximum) or -4164 (notional must be >= 5).

export interface SymbolFilters {
  stepSize: number;   // LOT_SIZE — quantity must be a multiple of this
  tickSize: number;   // PRICE_FILTER — price must be a multiple of this
  minNotional: number; // MIN_NOTIONAL — quantity * price must be >= this
}

interface RawFilter {
  filterType: string;
  stepSize?: string;
  tickSize?: string;
  notional?: string;
  minNotional?: string;
}

interface RawSymbolInfo {
  symbol: string;
  filters: RawFilter[];
}

// Parses the /fapi/v1/exchangeInfo response into a symbol → filters lookup.
export function parseSymbolFilters(exchangeInfo: { symbols: RawSymbolInfo[] }): Map<string, SymbolFilters> {
  const out = new Map<string, SymbolFilters>();
  for (const s of exchangeInfo.symbols) {
    const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
    const price = s.filters.find(f => f.filterType === 'PRICE_FILTER');
    // Binance renamed MIN_NOTIONAL's field from minNotional to notional at some point —
    // accept either so this doesn't silently break on an API version difference.
    const notional = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
    if (!lot?.stepSize || !price?.tickSize) continue;
    out.set(s.symbol, {
      stepSize: parseFloat(lot.stepSize),
      tickSize: parseFloat(price.tickSize),
      minNotional: parseFloat(notional?.notional ?? notional?.minNotional ?? '5'),
    });
  }
  return out;
}

// Counts decimal places in a step/tick value (e.g. 0.001 -> 3) for exact rounding.
// Floating point division (qty / step) accumulates error; string-based decimal
// counting avoids it.
function decimalsOf(step: number): number {
  const s = step.toString();
  if (s.includes('e-')) return parseInt(s.split('e-')[1], 10);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

// Rounds DOWN to the nearest multiple of stepSize. Always floors (never rounds up)
// because a quantity rounded up could exceed the risk budget the caller computed.
//
// 2026-09-08：`Math.floor(qty / stepSize)` 單獨用會削掉一整格。`16.24 / 0.01`
// 在二進位浮點下是 1623.9999999999998，floor 之後變 1623 → 16.23。這不是邊
// 緣情況：1..1000 之間 step 0.01 有 9.1%、step 0.001 有 12.9% 的合法數量會中。
//
// 代價不是「少賣一格」而已——平倉單少平一格會留下灰塵部位，部位永遠不歸零：
// SOLUSDT trade-1788765628400-wb2hq 進場 16.24、保本止損平掉 16.23，剩下的
// 0.01 讓 live-runner 判定「部位變小了 = TP1 發生」，推播了假的 TP1 通知，
// 那 0.01 又帶著原始止損跑了 13 小時，最後把一筆保本出場記成完整 −1R 的 LOSS。
//
// 修法是在 floor 之前補一個相對容差：只有當 qty 已經落在下一格的 1e-9 格以內
// （＝浮點雜訊，不是真的差一格）才會被推上去。真的介於兩格之間仍然往下取——
// 這裡絕不能改成 Math.round，往上取就是「平掉比部位還多的量」，那正是
// 2026-09-06 UNI 翻倉事故的形狀。
const STEP_EPSILON = 1e-9;

export function roundToStepSize(qty: number, stepSize: number): number {
  if (stepSize <= 0) return qty;
  const decimals = decimalsOf(stepSize);
  const units = Math.floor(qty / stepSize + STEP_EPSILON);
  return parseFloat((units * stepSize).toFixed(decimals));
}

// Rounds to the NEAREST multiple of tickSize (price can round either direction —
// unlike quantity, rounding a limit price slightly doesn't change risk exposure).
export function roundToTickSize(price: number, tickSize: number): number {
  if (tickSize <= 0) return price;
  const decimals = decimalsOf(tickSize);
  const rounded = Math.round(price / tickSize) * tickSize;
  return parseFloat(rounded.toFixed(decimals));
}

export function meetsMinNotional(qty: number, price: number, minNotional: number): boolean {
  return qty * price >= minNotional;
}
