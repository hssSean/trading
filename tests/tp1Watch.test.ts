import { describe, it, expect } from 'vitest';
import { pickTp1Hits } from '../src/lib/tp1Watch';
import type { TradeRecord } from '../src/types';

type Watchable = Pick<
  TradeRecord,
  'id' | 'symbol' | 'direction' | 'tp1' | 'result' | 'status' | 'statusConfirmed'
>;

function trade(over: Partial<Watchable> = {}): Watchable {
  return {
    id: 't1',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    tp1: 110,
    status: 'active',
    statusConfirmed: true,
    ...over,
  };
}

const at = (px: number) => () => px;

describe('pickTp1Hits', () => {
  it('marks a LONG whose price reached TP1', () => {
    expect(pickTp1Hits([trade()], at(110))).toEqual(['t1']);
    expect(pickTp1Hits([trade()], at(120))).toEqual(['t1']);
  });

  it('leaves a LONG below TP1 alone', () => {
    expect(pickTp1Hits([trade()], at(109.99))).toEqual([]);
  });

  it('marks a SHORT whose price fell to TP1', () => {
    const t = trade({ direction: 'SHORT', tp1: 90 });
    expect(pickTp1Hits([t], at(90))).toEqual(['t1']);
    expect(pickTp1Hits([t], at(80))).toEqual(['t1']);
    expect(pickTp1Hits([t], at(90.01))).toEqual([]);
  });

  // A limit order that hasn't filled holds no position — price touching TP1
  // means nothing, and marking it would invent a fill that never happened.
  it('skips waiting (unfilled limit) orders even past TP1', () => {
    expect(pickTp1Hits([trade({ status: 'waiting' })], at(999))).toEqual([]);
  });

  it('skips trades already marked tp1_hit', () => {
    expect(pickTp1Hits([trade({ status: 'tp1_hit' })], at(999))).toEqual([]);
  });

  it('skips closed trades', () => {
    expect(pickTp1Hits([trade({ result: 'WIN_TP2' })], at(999))).toEqual([]);
  });

  // status===undefined + !statusConfirmed means "server hasn't told us yet",
  // NOT "active". Its real status could still be waiting. See tradeSync.ts.
  it('skips unconfirmed-sync trades (status unknown, not confirmed active)', () => {
    const t = trade({ status: undefined, statusConfirmed: undefined });
    expect(pickTp1Hits([t], at(999))).toEqual([]);
  });

  it('accepts a trade whose undefined status was confirmed', () => {
    const t = trade({ status: undefined, statusConfirmed: true });
    expect(pickTp1Hits([t], at(999))).toEqual(['t1']);
  });

  it('skips symbols with no price yet (0)', () => {
    expect(pickTp1Hits([trade()], at(0))).toEqual([]);
  });

  it('looks up price per symbol, not globally', () => {
    const trades = [
      trade({ id: 'btc', symbol: 'BTCUSDT', tp1: 110 }),
      trade({ id: 'eth', symbol: 'ETHUSDT', tp1: 110 }),
    ];
    const priceOf = (s: string) => (s === 'BTCUSDT' ? 120 : 100);
    expect(pickTp1Hits(trades, priceOf)).toEqual(['btc']);
  });

  it('returns every hit when several trades qualify', () => {
    const trades = [
      trade({ id: 'a', tp1: 100 }),
      trade({ id: 'b', tp1: 105 }),
      trade({ id: 'c', tp1: 200 }),
    ];
    expect(pickTp1Hits(trades, at(110))).toEqual(['a', 'b']);
  });
});
