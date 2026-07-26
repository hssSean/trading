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
export function roundToStepSize(qty: number, stepSize: number): number {
  if (stepSize <= 0) return qty;
  const decimals = decimalsOf(stepSize);
  const floored = Math.floor(qty / stepSize) * stepSize;
  return parseFloat(floored.toFixed(decimals));
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
