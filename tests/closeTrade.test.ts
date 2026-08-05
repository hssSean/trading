import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/store/useStore';
import { blendTp1PartialPnl } from '../src/lib/monitorMath';
import type { TradeRecord } from '../src/types';

function trade(over: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: 't1',
    signalId: 's1',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    timeframe: '1h',
    strength: 'MODERATE',
    score: 70,
    entry: 100,
    stopLoss: 90,
    tp1: 110,
    tp2: 120,
    reasons: [],
    openedAt: Date.now(),
    ...over,
  };
}

beforeEach(() => {
  useStore.setState({ trades: [] });
});

describe('closeTrade', () => {
  it('manually closes a tp1-watching trade (result already WIN_TP1, no closedAt)', () => {
    useStore.setState({
      trades: [trade({ status: 'tp1_hit', result: 'WIN_TP1', exitPrice: 110, pnlPercent: 10 })],
    });

    useStore.getState().closeTrade('t1', 'WIN_TP2', 115);

    const t = useStore.getState().trades[0];
    expect(t.result).toBe('WIN_TP2');
    expect(t.exitPrice).toBe(115);
    expect(t.closedAt).toBeTypeOf('number');
    expect(t.closeReason).toBe('manual');
    // blend formula, not naive 100%-at-exitPrice
    const expected = blendTp1PartialPnl(100, 110, 115, true);
    expect(t.pnlPercent).toBeCloseTo(parseFloat(expected.toFixed(2)), 6);
    expect(t.pnlPercent).not.toBeCloseTo(15, 6); // naive (exit-entry)/entry*100 would be wrong
  });

  it('skips a trade that is already truly closed (has closedAt)', () => {
    useStore.setState({
      trades: [trade({ result: 'WIN_TP1', exitPrice: 110, pnlPercent: 10, closedAt: 12345 })],
    });

    useStore.getState().closeTrade('t1', 'WIN_TP2', 115);

    const t = useStore.getState().trades[0];
    expect(t.closedAt).toBe(12345); // untouched
    expect(t.exitPrice).toBe(110);
  });

  it('closes a plain active trade (no tp1 hit) using simple pnl', () => {
    useStore.setState({ trades: [trade({ status: 'active' })] });

    useStore.getState().closeTrade('t1', 'LOSS', 95);

    const t = useStore.getState().trades[0];
    expect(t.result).toBe('LOSS');
    expect(t.pnlPercent).toBeCloseTo(-5, 6);
    expect(t.closedAt).toBeTypeOf('number');
  });
});
