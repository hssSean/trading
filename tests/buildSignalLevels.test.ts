import { describe, it, expect } from 'vitest';
import { buildSignalLevels } from '../src/analysis/signals';
import type { SRLevel } from '../src/types';

// 2026-08-18：buildSignalLevels 是從 generateSignals 的 LONG/SHORT 兩個
// 「分數過關」分支裡原樣抽出來的（為了讓被分數擋掉的候選也能算價位，跑
// score_gate 影子模擬，見該函數註解）。這個檔案的重點不是「算式對不對」
// ——算式本來就在跑正式站——而是「抽出來之後跟原本完全等價」。
//
// 做法：把重構前那兩段 inline 算式原封不動抄成參照實作，用大量隨機輸入
// 比對兩者。這比手寫幾個 case 更有把握，也永久留著當回歸防護：以後有人
// 改 buildSignalLevels 卻沒意識到它是策略核心，這裡會紅。
const MIN_RR_INTRADAY = 1.2;
const MIN_RR_SWING    = 2.0;

// ── 參照實作：重構前的 LONG 分支，逐行照抄 ──────────────────────
function refLong(
  longEntry: number, longOB: { low: number } | null, longSR: { price: number } | null,
  slBuffer: number, resistance: { price: number } | null, srLevels: SRLevel[],
  intraday: boolean, MIN_RR: number,
) {
  const sl   = longOB  ? Math.min(longOB.low  * 0.995, longEntry - slBuffer)
             : longSR  ? Math.min(longSR.price * 0.995, longEntry - slBuffer)
             : longEntry - slBuffer;
  const risk = Math.max(longEntry - sl, 1e-6);
  const tp1Max = intraday ? longEntry + risk * 1.5 : longEntry + risk * 2.0;
  const tp1Raw = resistance ? Math.min(resistance.price, tp1Max) : tp1Max;
  const tp1    = Math.max(tp1Raw, longEntry + risk * MIN_RR);
  const tp2Cap = intraday ? longEntry + risk * 2.0 : longEntry + risk * 3.5;
  const nextR  = srLevels.find(l => l.type === 'resistance' && l.price > tp1 * 1.003 && l.price <= tp2Cap);
  const tp2    = nextR ? Math.min(nextR.price, tp2Cap) : tp2Cap;
  const rr     = parseFloat(((tp1 - longEntry) / risk).toFixed(2));
  return { sl, tp1, tp2, rr, risk };
}

// ── 參照實作：重構前的 SHORT 分支，逐行照抄 ─────────────────────
function refShort(
  shortEntry: number, shortOB: { high: number } | null, shortSR: { price: number } | null,
  slBuffer: number, support: { price: number } | null, srLevels: SRLevel[],
  intraday: boolean, MIN_RR: number,
) {
  const sl   = shortOB ? Math.max(shortOB.high * 1.005, shortEntry + slBuffer)
             : shortSR ? Math.max(shortSR.price * 1.005, shortEntry + slBuffer)
             : shortEntry + slBuffer;
  const risk = Math.max(sl - shortEntry, 1e-6);
  const tp1Max = intraday ? shortEntry - risk * 1.5 : shortEntry - risk * 2.0;
  const tp1Raw = support ? Math.max(support.price, tp1Max) : tp1Max;
  const tp1    = Math.min(tp1Raw, shortEntry - risk * MIN_RR);
  const tp2Cap = intraday ? shortEntry - risk * 2.0 : shortEntry - risk * 3.5;
  const nextS  = srLevels.find(l => l.type === 'support' && l.price < tp1 * 0.997 && l.price >= tp2Cap);
  const tp2    = nextS ? Math.max(nextS.price, tp2Cap) : tp2Cap;
  const rr     = parseFloat(((shortEntry - tp1) / risk).toFixed(2));
  return { sl, tp1, tp2, rr, risk };
}

// 決定性偽亂數，讓失敗可以重現（不用 Math.random）
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSrLevels(rand: () => number, price: number): SRLevel[] {
  const n = Math.floor(rand() * 6);
  const out: SRLevel[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      price: price * (0.85 + rand() * 0.3),
      type: rand() < 0.5 ? 'support' : 'resistance',
      strength: rand() * 5,
      lastTouchTime: 0,
      touchCount: Math.floor(rand() * 5),
    });
  }
  return out;
}

describe('buildSignalLevels 跟重構前的 inline 算式完全等價', () => {
  it('LONG：500 組隨機輸入全部一致', () => {
    const rand = mulberry32(20260818);
    for (let i = 0; i < 500; i++) {
      // 幣價尺度刻意跨好幾個數量級（BTC 六萬 vs COTI 0.01），確保沒有隱含的
      // 尺度假設——本輪 clientOrderId 那個 bug 就是只在低價幣才炸。
      const entry = Math.pow(10, rand() * 6 - 2);
      const slBuffer = entry * (0.002 + rand() * 0.05);
      const intraday = rand() < 0.5;
      const minRr = intraday ? MIN_RR_INTRADAY : MIN_RR_SWING;
      const ob   = rand() < 0.4 ? { low: entry * (0.9 + rand() * 0.12) } : null;
      const sr   = rand() < 0.4 ? { price: entry * (0.9 + rand() * 0.12) } : null;
      const res  = rand() < 0.5 ? { price: entry * (1 + rand() * 0.3) } : null;
      const srLevels = makeSrLevels(rand, entry);

      const got = buildSignalLevels({
        isLong: true, entry,
        obEdge: ob ? ob.low : null,
        srPrice: sr ? sr.price : null,
        slBuffer, tpClampPrice: res ? res.price : null,
        srLevels, intraday, minRr,
      });
      const want = refLong(entry, ob, sr, slBuffer, res, srLevels, intraday, minRr);
      expect(got, `LONG case #${i} entry=${entry}`).toEqual(want);
    }
  });

  it('SHORT：500 組隨機輸入全部一致', () => {
    const rand = mulberry32(987654);
    for (let i = 0; i < 500; i++) {
      const entry = Math.pow(10, rand() * 6 - 2);
      const slBuffer = entry * (0.002 + rand() * 0.05);
      const intraday = rand() < 0.5;
      const minRr = intraday ? MIN_RR_INTRADAY : MIN_RR_SWING;
      const ob   = rand() < 0.4 ? { high: entry * (0.98 + rand() * 0.12) } : null;
      const sr   = rand() < 0.4 ? { price: entry * (0.98 + rand() * 0.12) } : null;
      const sup  = rand() < 0.5 ? { price: entry * (0.7 + rand() * 0.3) } : null;
      const srLevels = makeSrLevels(rand, entry);

      const got = buildSignalLevels({
        isLong: false, entry,
        obEdge: ob ? ob.high : null,
        srPrice: sr ? sr.price : null,
        slBuffer, tpClampPrice: sup ? sup.price : null,
        srLevels, intraday, minRr,
      });
      const want = refShort(entry, ob, sr, slBuffer, sup, srLevels, intraday, minRr);
      expect(got, `SHORT case #${i} entry=${entry}`).toEqual(want);
    }
  });

  it('OB 優先於 SR（兩者都有時只看 OB）——原本的三元串接順序不能被改掉', () => {
    const srLevels: SRLevel[] = [];
    const withBoth = buildSignalLevels({
      isLong: true, entry: 100, obEdge: 95, srPrice: 80,
      slBuffer: 2, tpClampPrice: null, srLevels, intraday: false, minRr: MIN_RR_SWING,
    });
    const obOnly = buildSignalLevels({
      isLong: true, entry: 100, obEdge: 95, srPrice: null,
      slBuffer: 2, tpClampPrice: null, srLevels, intraday: false, minRr: MIN_RR_SWING,
    });
    expect(withBoth.sl).toBe(obOnly.sl);
  });

  it('LONG 的 sl 永遠低於 entry、SHORT 永遠高於 entry（方向不能寫反）', () => {
    const srLevels: SRLevel[] = [];
    const l = buildSignalLevels({
      isLong: true, entry: 100, obEdge: null, srPrice: null,
      slBuffer: 3, tpClampPrice: null, srLevels, intraday: false, minRr: MIN_RR_SWING,
    });
    const s = buildSignalLevels({
      isLong: false, entry: 100, obEdge: null, srPrice: null,
      slBuffer: 3, tpClampPrice: null, srLevels, intraday: false, minRr: MIN_RR_SWING,
    });
    expect(l.sl).toBeLessThan(100);
    expect(l.tp1).toBeGreaterThan(100);
    expect(s.sl).toBeGreaterThan(100);
    expect(s.tp1).toBeLessThan(100);
  });
});
