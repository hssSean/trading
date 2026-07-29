export interface CalcProgressRatioParams {
  direction: 'LONG' | 'SHORT';
  stopLoss: number;
  tp2: number;
  current: number;
}

// Normalizes current price into a 0 (stop loss) → 1 (TP2) ratio along the
// risk→reward direction, so LONG and SHORT trades share the same visual
// scale regardless of which raw price is numerically larger.
export function calcProgressRatio({ direction, stopLoss, tp2, current }: CalcProgressRatioParams): number {
  const span = direction === 'LONG' ? tp2 - stopLoss : stopLoss - tp2;
  if (span === 0) return 0;
  const progressed = direction === 'LONG' ? current - stopLoss : stopLoss - current;
  const ratio = progressed / span;
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(1, Math.max(0, ratio));
}
