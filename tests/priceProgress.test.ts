import { describe, it, expect } from 'vitest';
import { calcProgressRatio } from '../src/lib/priceProgress';

describe('calcProgressRatio', () => {
  it('LONG: 現價在止損位 → 0', () => {
    expect(calcProgressRatio({ direction: 'LONG', stopLoss: 100, tp2: 200, current: 100 })).toBe(0);
  });

  it('LONG: 現價在 TP2 → 1', () => {
    expect(calcProgressRatio({ direction: 'LONG', stopLoss: 100, tp2: 200, current: 200 })).toBe(1);
  });

  it('LONG: 現價在中點 → 0.5', () => {
    expect(calcProgressRatio({ direction: 'LONG', stopLoss: 100, tp2: 200, current: 150 })).toBe(0.5);
  });

  it('LONG: 現價跌破止損 → clamp 到 0', () => {
    expect(calcProgressRatio({ direction: 'LONG', stopLoss: 100, tp2: 200, current: 80 })).toBe(0);
  });

  it('LONG: 現價超過 TP2 → clamp 到 1', () => {
    expect(calcProgressRatio({ direction: 'LONG', stopLoss: 100, tp2: 200, current: 250 })).toBe(1);
  });

  it('SHORT: 現價在止損位（價格較高）→ 0', () => {
    expect(calcProgressRatio({ direction: 'SHORT', stopLoss: 200, tp2: 100, current: 200 })).toBe(0);
  });

  it('SHORT: 現價在 TP2（價格較低）→ 1', () => {
    expect(calcProgressRatio({ direction: 'SHORT', stopLoss: 200, tp2: 100, current: 100 })).toBe(1);
  });

  it('SHORT: 現價在中點 → 0.5', () => {
    expect(calcProgressRatio({ direction: 'SHORT', stopLoss: 200, tp2: 100, current: 150 })).toBe(0.5);
  });

  it('止損等於 TP2（分母為 0）不噴例外，回傳 0', () => {
    expect(calcProgressRatio({ direction: 'LONG', stopLoss: 100, tp2: 100, current: 100 })).toBe(0);
  });
});
