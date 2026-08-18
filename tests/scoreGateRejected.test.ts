import { describe, it, expect } from 'vitest';
import { generateSignals } from '../src/analysis/signals';
import type { RejectedCandidate } from '../src/analysis/signals';
import type { Candle } from '../src/types';

// 2026-08-18（docs/TODO.md P2 #7）：score_gate 影子模擬的資料來源測試。
//
// generateSignals 現在會在「只差分數沒過關」時，把那個候選的完整價位放進
// debugOut.rejected，route.ts 拿它建影子模擬候選。這裡驗證兩件事：
//  1. 分數不夠時真的有帶出價位（不然影子模擬永遠拿不到東西，等於沒做）
//  2. 分數夠、訊號有發出來時不帶（那筆會走正常路徑，帶了會重複計算）
//
// 合成 K 線的手法跟 entryQualityMetrics.test.ts 一致，時間軸釘在「最後一根
// 已收盤」，避免踩到 lastClosedCandles 把尾巴那根當進行中棒砍掉。
function buildCandles(n: number, opts: { growth: number; osc: number; volSurge: boolean }): Candle[] {
  const barMs = 3_600_000;
  const hourStart = Math.floor(Date.now() / barMs) * barMs;
  const lastOpen = hourStart - barMs; // 最後一根已收盤
  const startOpen = lastOpen - barMs * (n - 1);
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    price = price * opts.growth;
    const mid = price * (1 + opts.osc * Math.sin(i / 6));
    const open = mid * (1 - 0.0015);
    const close = mid;
    const openTime = startOpen + i * barMs;
    out.push({
      openTime,
      open,
      high: Math.max(open, close) * 1.004,
      low: Math.min(open, close) * 0.996,
      close,
      volume: opts.volSurge && i >= n - 3 ? 5000 : 1000 + (i % 7) * 100,
      closeTime: openTime + barMs - 1,
    });
  }
  return out;
}

describe('score_gate 被擋候選會帶出可模擬的價位', () => {
  it('分數夠、訊號有發出來時，不帶 rejected（避免跟正常路徑重複計算）', () => {
    const candles = buildCandles(260, { growth: 1.002, osc: 0.02, volSurge: true });
    const dbg: { long?: number; short?: number; rejected?: RejectedCandidate } = {};
    const signals = generateSignals('BTCUSDT', '1h', candles, 'LONG', 'trending', dbg);

    expect(signals.length).toBeGreaterThan(0); // sanity：這組確實會出訊號
    expect(dbg.rejected).toBeUndefined();
  });

  it('分數不夠沒出訊號時，帶出完整且方向正確的價位', () => {
    // 拿掉放量（成交量組拿不到分）讓分數掉到門檻以下——entryQualityMetrics
    // 那支測試的註解就寫過：沒有放量分數時原始分只有 54，不會出訊號。
    const candles = buildCandles(260, { growth: 1.002, osc: 0.02, volSurge: false });
    const dbg: { long?: number; short?: number; rejected?: RejectedCandidate } = {};
    const signals = generateSignals('BTCUSDT', '1h', candles, 'LONG', 'trending', dbg);

    expect(signals.length).toBe(0); // sanity：這組確實被擋
    // 沒被分數擋（而是方向沒贏/型態沒過/距離太遠）時 rejected 會是 undefined，
    // 那種情況這個測試沒有意義——先確認我們真的落在「分數擋的」那條路徑。
    expect(dbg.rejected, '這組合成資料應該要落在 score_gate，不是其他關卡').toBeDefined();
    const r = dbg.rejected!;

    expect(r.direction).toBe('LONG');
    expect(r.score).toBeGreaterThan(0);
    // 價位要能真的拿去模擬：四個數字都是有限值，且多單的止損在進場之下、
    // 兩個止盈在進場之上並依序遞增。
    for (const v of [r.entry, r.stopLoss, r.tp1, r.tp2, r.signalPrice]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
    expect(r.stopLoss).toBeLessThan(r.entry);
    expect(r.tp1).toBeGreaterThan(r.entry);
    expect(r.tp2).toBeGreaterThanOrEqual(r.tp1);
  });
});
