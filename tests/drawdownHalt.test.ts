import { describe, it, expect } from 'vitest';
import {
  evaluateDrawdownHalt, toEquityPoints, readMaxDrawdownR, DEFAULT_MAX_DRAWDOWN_R,
  type DrawdownTradeRow,
} from '../src/lib/drawdownHalt';

// 這支守的是「已經判定要停機了，還是把先前排隊的單送出去」。
//
// 2026-09-06 用知識圖比對兩條路徑的關卡，發現回撤停機只存在於 route.ts
// （產生訊號那側），live-runner（實際下單那側）完全沒有。訊號在停機**之前**
// 產生、停機**之後**才成交的話，那筆單照樣會被送出去——而排隊窗口實測可達三天。

const T = 1_800_000_000_000;
const H = 3600_000;
/** 進場 100、止損 90 → 止損距離 10%。pnl_percent 10 就是 +1R。 */
const row = (pnlPct: number, o: Partial<DrawdownTradeRow> = {}): DrawdownTradeRow =>
  ({ closed_at: T, pnl_percent: pnlPct, entry: 100, stop_loss: 90, tier: 'A', ...o });

describe('toEquityPoints', () => {
  it('pnl% ÷ 止損距離% = R', () => {
    expect(toEquityPoints([row(10)])[0].accountR).toBeCloseTo(1);
    expect(toEquityPoints([row(-10)])[0].accountR).toBeCloseTo(-1);
  });

  // B tier 是半倉，對帳戶的衝擊只有一半。口徑要跟 route.ts 的熔斷一致，
  // 不然兩道關卡會對同一批交易算出不同的回撤。
  it('B tier 權重 0.5', () => {
    expect(toEquityPoints([row(10, { tier: 'B' })])[0].accountR).toBeCloseTo(0.5);
  });

  it('依 closed_at 排序——權益曲線的順序決定回撤', () => {
    const pts = toEquityPoints([row(1, { closed_at: T + H }), row(2, { closed_at: T })]);
    expect(pts.map(p => p.closedAt)).toEqual([T, T + H]);
  });

  it.each([
    ['缺 pnl_percent', { pnl_percent: null }],
    ['缺 entry', { entry: null }],
    ['缺 stop_loss', { stop_loss: null }],
    ['缺 closed_at', { closed_at: null }],
    ['止損距離為 0', { entry: 100, stop_loss: 100 }],
  ])('%s 的列跳過，不產生 NaN/Infinity', (_label, patch) => {
    const pts = toEquityPoints([row(10, patch as Partial<DrawdownTradeRow>)]);
    expect(pts).toHaveLength(0);
  });
});

describe('evaluateDrawdownHalt — 門檻', () => {
  // 先賺 +5R 到高點，再連虧到 -8R：回撤 13R。
  const drawdownSeries = [
    row(50, { closed_at: T }),          // +5R，peak = 5
    row(-60, { closed_at: T + H }),     // -6R，current = -1
    row(-70, { closed_at: T + 2 * H }), // -7R，current = -8 → 回撤 13R
  ];

  it('回撤達門檻就擋，理由帶實際數字', () => {
    const r = evaluateDrawdownHalt(drawdownSeries, 12);
    expect(r.halted).toBe(true);
    expect(r.drawdownR).toBeCloseTo(13);
    expect(r.peakR).toBeCloseTo(5);
    expect(r.currentR).toBeCloseTo(-8);
    expect(r.reason).toContain('13.00');
    expect(r.reason).toContain('12');
  });

  it('門檻拉高到 18 就不擋', () => {
    expect(evaluateDrawdownHalt(drawdownSeries, 18).halted).toBe(false);
  });

  it('一路獲利不擋', () => {
    const r = evaluateDrawdownHalt([row(10), row(20, { closed_at: T + H })], 12);
    expect(r.halted).toBe(false);
    expect(r.drawdownR).toBeCloseTo(0);
  });
});

describe('evaluateDrawdownHalt — 停用與資料不足', () => {
  it.each([0, -1, NaN])('limitR=%s 視為停用', (lim) => {
    expect(evaluateDrawdownHalt([row(-500)], lim).halted).toBe(false);
  });

  // 跟日虧損上限的 fail-closed 相反，這裡刻意 fail-open：那道是「最後一道
  // 防線、寧可錯過單」，這道是「策略可能失效、停下來讓人檢查」——沒有資料
  // 就沒有失效的證據，擋下來只是把系統凍住而沒有任何依據。
  it('沒有可用資料時不擋（n=0）', () => {
    expect(evaluateDrawdownHalt([], 12)).toMatchObject({ halted: false, n: 0 });
    expect(evaluateDrawdownHalt([row(10, { entry: null })], 12)).toMatchObject({ halted: false, n: 0 });
  });

  it('回報實際納入計算的筆數', () => {
    expect(evaluateDrawdownHalt([row(10), row(-5, { closed_at: T + H }), row(1, { entry: null })], 12).n).toBe(2);
  });
});

describe('readMaxDrawdownR', () => {
  it('沒設用預設值', () => {
    expect(readMaxDrawdownR({})).toBe(DEFAULT_MAX_DRAWDOWN_R);
    expect(readMaxDrawdownR({ MAX_DRAWDOWN_R: '' })).toBe(DEFAULT_MAX_DRAWDOWN_R);
  });
  it('讀得到數字，0 代表停用', () => {
    expect(readMaxDrawdownR({ MAX_DRAWDOWN_R: '18' })).toBe(18);
    expect(readMaxDrawdownR({ MAX_DRAWDOWN_R: '0' })).toBe(0);
  });
  // 打錯字不該變成「停用風控」——那個方向的錯是危險的。
  it('無效值退回預設值，不是停用', () => {
    expect(readMaxDrawdownR({ MAX_DRAWDOWN_R: 'abc' })).toBe(DEFAULT_MAX_DRAWDOWN_R);
  });
});
