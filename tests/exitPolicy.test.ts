import { describe, it, expect } from 'vitest';
import { simulateExit, pairedCompare, type ExitPolicyConfig, type ExitBar } from '../src/lib/exitPolicy';

// LONG：進場 100、止損 95（風險 5）、TP1 105（+1R）、TP2 110（+2R）
const L = { entry: 100, stopLoss: 95, tp1: 105, tp2: 110, isLong: true };
const bar = (high: number, low: number, close: number): ExitBar => ({ high, low, close });
const atrOf = (n: number, v = 2) => Array(n).fill(v);

const NONE: ExitPolicyConfig = {
  name: 'none', tp1Fraction: 0, breakevenAtR: null, trailAtrMult: null,
  stallBars: null, stallBandR: 0.3, maxBars: null,
  tp1AtR: null, tp2AtR: null,
};
const p = (o: Partial<ExitPolicyConfig>): ExitPolicyConfig => ({ ...NONE, ...o });

describe('simulateExit 基本出場', () => {
  it('直接打到止損 → -1R', () => {
    const bars = [bar(101, 94, 96)];
    const r = simulateExit({ ...L, bars, atr: atrOf(1) }, NONE);
    expect(r.r).toBe(-1);
    expect(r.reason).toBe('stop');
  });

  it('直接打到 TP2 → +2R', () => {
    const bars = [bar(111, 100, 110)];
    const r = simulateExit({ ...L, bars, atr: atrOf(1) }, NONE);
    expect(r.r).toBe(2);
    expect(r.reason).toBe('tp2');
  });

  // 同根同時觸及 TP 和 SL：K線看不出誰先到，這裡固定判 SL（悲觀）。
  // walkTpSl 的預設是相反的（樂觀），那個假設會系統性高估——政策比較是
  // 成對的，用悲觀不會讓任何一個政策的好處被誇大。
  it('同根同時觸及 TP2 和 SL → 判止損', () => {
    const bars = [bar(111, 94, 100)];
    const r = simulateExit({ ...L, bars, atr: atrOf(1) }, NONE);
    expect(r.reason).toBe('stop');
    expect(r.r).toBe(-1);
  });

  it('止損距離為 0 → 判無效，不回 NaN/Infinity', () => {
    const r = simulateExit(
      { entry: 100, stopLoss: 100, tp1: 105, tp2: 110, isLong: true, bars: [bar(111, 90, 100)], atr: atrOf(1) },
      NONE,
    );
    expect(r.r).toBe(0);
    expect(r.reason).toBe('open');
  });

  it('K線用完還沒出場 → reason=open（呼叫端要排除）', () => {
    const bars = [bar(101, 99, 100), bar(102, 99, 101)];
    const r = simulateExit({ ...L, bars, atr: atrOf(2) }, NONE);
    expect(r.reason).toBe('open');
  });
});

describe('TP1 部分停利', () => {
  it('TP1 觸及後止損拉到進場價，回落時收在保本（含 TP1 那半）', () => {
    const bars = [bar(106, 100, 105), bar(104, 99, 100)];
    const r = simulateExit({ ...L, bars, atr: atrOf(2) }, p({ tp1Fraction: 0.5 }));
    // 0.5 × (+1R) + 0.5 × 0R = +0.5R
    expect(r.r).toBe(0.5);
    expect(r.tp1Hit).toBe(true);
  });

  it('不做部分停利時，同樣走勢只拿到 0R', () => {
    const bars = [bar(106, 100, 105), bar(104, 99, 100)];
    const r = simulateExit({ ...L, bars, atr: atrOf(2) }, p({ tp1Fraction: 0 }));
    expect(r.r).toBe(0);
  });
});

describe('保本觸發：好處與代價都要算到', () => {
  it('救到虧損單：曾達 +0.5R 後回落 → 收在 0R 而不是 -1R', () => {
    const bars = [bar(102.5, 100, 102), bar(101, 94, 95)];
    const withBe = simulateExit({ ...L, bars, atr: atrOf(2) }, p({ breakevenAtR: 0.5 }));
    const without = simulateExit({ ...L, bars, atr: atrOf(2) }, NONE);
    expect(withBe.r).toBe(0);
    expect(withBe.reason).toBe('breakeven');
    expect(without.r).toBe(-1);
  });

  // 這是整支模擬器存在的理由。用 MFE 做的反事實試算只會把虧損單改好，
  // 算不到這個代價——實際資料裡就有一筆 MFE 曾到 +1.81R、最後 -0.04R 的
  // 保本出場。沒有這個測試，模擬器會重蹈那個高估。
  it('砍掉大贏家：曾達 +0.5R 後回踩進場價、之後才噴到 TP2', () => {
    const bars = [
      bar(102.5, 100, 102),   // 到 +0.5R，保本啟動
      bar(103, 99.5, 100),    // 回踩 99.5 → 保本止損被掃掉
      bar(111, 100, 110),     // 之後才到 TP2
    ];
    const withBe = simulateExit({ ...L, bars, atr: atrOf(3) }, p({ breakevenAtR: 0.5 }));
    const without = simulateExit({ ...L, bars, atr: atrOf(3) }, NONE);
    expect(withBe.r).toBe(0);        // 保本出場，錯過整段
    expect(without.r).toBe(2);       // 不設保本反而吃到 +2R
    expect(withBe.mfeR).toBeGreaterThan(0);
  });
});

describe('TP1 後移動止損', () => {
  it('鎖住利潤：推進後回落收在移動止損而非保本', () => {
    const bars = [
      bar(106, 100, 105),   // TP1
      bar(109, 105, 108),   // 推進，trail = 108 - 2*1 = 106
      bar(108, 100, 101),   // 回落掃到 106
    ];
    const r = simulateExit({ ...L, bars, atr: atrOf(3, 1) }, p({ tp1Fraction: 0, trailAtrMult: 1 }));
    expect(r.reason).toBe('trail');
    expect(r.r).toBeGreaterThan(1);   // 收在 106 = +1.2R，比保本 0R 好
  });

  it('移動止損只進不退', () => {
    const bars = [
      bar(106, 100, 105),
      bar(109, 105, 108),   // trail 拉到 106
      bar(108, 106.5, 107), // close 較低但 trail 不可退回
      bar(107, 100, 101),
    ];
    const r = simulateExit({ ...L, bars, atr: atrOf(4, 1) }, p({ tp1Fraction: 0, trailAtrMult: 1 }));
    expect(r.r).toBeGreaterThanOrEqual(1.2);
  });
});

describe('時間止損', () => {
  // 盤整停滯照抄 engine/timeStop.ts 的線上定義：只在 TP1 之前、持有滿 N 根、
  // 且進度卡在 ±0.3R 之間才出場。早期版本我寫成「連續 N 根沒創新高」，那是
  // 另一條規則——基準線模型錯了整個政策比較就沒有意義。
  it('持有滿 N 根且進度卡在 ±0.3R → 停滯出場', () => {
    const bars = [bar(101, 99, 100.5), bar(101, 99, 100.5), bar(101, 99, 100.5)];
    const r = simulateExit({ ...L, bars, atr: atrOf(3) }, p({ stallBars: 2 }));
    expect(r.reason).toBe('stall');
  });

  it('已經推進超過 +0.3R 就不觸發 — 給它走到 TP1 的機會', () => {
    const bars = [bar(103, 99, 102.5), bar(103, 99, 102.5), bar(103, 99, 102.5)];
    const r = simulateExit({ ...L, bars, atr: atrOf(3) }, p({ stallBars: 2 }));
    expect(r.reason).not.toBe('stall');
  });

  it('已經接近止損（< -0.3R）就不觸發 — 讓原止損決定', () => {
    const bars = [bar(100, 97, 97.5), bar(100, 97, 97.5), bar(100, 97, 97.5)];
    const r = simulateExit({ ...L, bars, atr: atrOf(3) }, p({ stallBars: 2 }));
    expect(r.reason).not.toBe('stall');
  });

  it('TP1 之後不再觸發停滯', () => {
    const bars = [bar(106, 100, 105), bar(105, 100, 100.5), bar(105, 100, 100.5), bar(105, 100, 100.5)];
    const r = simulateExit({ ...L, bars, atr: atrOf(4) }, p({ tp1Fraction: 0, stallBars: 2 }));
    expect(r.reason).not.toBe('stall');
  });

  it('未滿 N 根不觸發', () => {
    const bars = [bar(101, 99, 100.5), bar(101, 99, 100.5)];
    const r = simulateExit({ ...L, bars, atr: atrOf(2) }, p({ stallBars: 5 }));
    expect(r.reason).not.toBe('stall');
  });

  it('maxBars 到期平倉', () => {
    const bars = [bar(103, 99, 102), bar(103, 99, 102), bar(103, 99, 102)];
    const r = simulateExit({ ...L, bars, atr: atrOf(3) }, p({ maxBars: 2 }));
    expect(r.reason).toBe('expiry');
    expect(r.barsHeld).toBe(2);
  });
});

describe('SHORT 方向對稱', () => {
  const S = { entry: 100, stopLoss: 105, tp1: 95, tp2: 90, isLong: false };
  it('做空打到 TP2 → +2R', () => {
    const r = simulateExit({ ...S, bars: [bar(100, 89, 90)], atr: atrOf(1) }, NONE);
    expect(r.r).toBe(2);
  });
  it('做空打到止損 → -1R', () => {
    const r = simulateExit({ ...S, bars: [bar(106, 99, 105)], atr: atrOf(1) }, NONE);
    expect(r.r).toBe(-1);
  });
  it('做空保本同樣運作', () => {
    const bars = [bar(100, 97.5, 98), bar(106, 99, 105)];
    const r = simulateExit({ ...S, bars, atr: atrOf(2) }, p({ breakevenAtR: 0.5 }));
    expect(r.r).toBe(0);
  });
});

// 2026-09-03：TP 位置是唯一沒被量測過的參數家族。先前 10 個變體全部只動出場
// 管理，而位置直接決定勝率——目標越遠越難達到，而實測缺的正是勝率
// （26.3% vs 兩平所需 30.8%）。
describe('TP 位置覆寫（tp1AtR / tp2AtR）', () => {
  it('把 TP1 拉近到 +0.5R，原本構不到 +1R 的走勢也能觸及', () => {
    const bars = [bar(103, 99, 102)]; // 最高 103 = +0.6R，構不到原本的 TP1(105)
    expect(simulateExit({ ...L, bars, atr: atrOf(1) }, NONE).tp1Hit).toBe(false);
    expect(simulateExit({ ...L, bars, atr: atrOf(1) },
      p({ tp1AtR: 0.5, tp1Fraction: 1 })).tp1Hit).toBe(true);
  });

  it('把 TP2 推遠到 +3R，原本會在 +2R 結案的單改成繼續持有', () => {
    const bars = [bar(111, 100, 110)]; // 觸及原 TP2(110) 但構不到 +3R(115)
    expect(simulateExit({ ...L, bars, atr: atrOf(1) }, NONE).reason).toBe('tp2');
    expect(simulateExit({ ...L, bars, atr: atrOf(1) }, p({ tp2AtR: 3 })).reason).not.toBe('tp2');
  });

  // 覆寫用 entry ± risk × 倍數算，做空要往下算。方向寫反會讓其中一邊的目標
  // 落在虧損側，整批比較直接失去意義。
  it('做空方向對稱', () => {
    const S = { entry: 100, stopLoss: 105, tp1: 95, tp2: 90, isLong: false };
    const bars = [bar(100, 97, 97.5)]; // 跌到 97 = +0.6R
    expect(simulateExit({ ...S, bars, atr: atrOf(1) }, p({ tp1AtR: 0.5, tp1Fraction: 1 })).tp1Hit).toBe(true);
    expect(simulateExit({ ...S, bars, atr: atrOf(1) }, p({ tp1AtR: 1.5, tp1Fraction: 1 })).tp1Hit).toBe(false);
  });

  it('null 時完全沿用訊號自帶的價位', () => {
    const bars = [bar(106, 100, 105)];
    const a = simulateExit({ ...L, bars, atr: atrOf(1) }, p({ tp1Fraction: 1 }));
    const b = simulateExit({ ...L, bars, atr: atrOf(1) }, p({ tp1Fraction: 1, tp1AtR: null, tp2AtR: null }));
    expect(a).toEqual(b);
  });

  // 拉近 TP1 的**代價**：觸及率上升但單筆實現的 R 變小。這個 trade-off 才是
  // 整組測試的重點——沒有它就只會看到「更常獲利」而誤判成改善。
  it('拉近 TP1 提高觸及率，但單筆實現的 R 變小', () => {
    const bars = [bar(106, 100, 105), bar(104, 99, 100)];
    const far  = simulateExit({ ...L, bars, atr: atrOf(2) }, p({ tp1Fraction: 1 }));
    const near = simulateExit({ ...L, bars, atr: atrOf(2) }, p({ tp1Fraction: 1, tp1AtR: 0.5 }));
    expect(near.tp1Hit).toBe(true);
    expect(near.r).toBeLessThan(far.r);
  });
});

describe('pairedCompare', () => {
  it('每筆都改善固定值 → t 極大、顯著', () => {
    const a = [0, -1, 1, -1, 0.5];
    const b = a.map(v => v + 0.5);
    const r = pairedCompare(a, b);
    expect(r.meanDiff).toBe(0.5);
    expect(r.significant).toBe(true);
  });

  it('完全相同 → 差異 0、不顯著', () => {
    const a = [1, -1, 0.5, 2];
    const r = pairedCompare(a, a);
    expect(r.meanDiff).toBe(0);
    expect(r.significant).toBe(false);
  });

  // 核心防線：有正有負、平均接近 0 的雜訊不能被判成顯著。
  it('隨機互有輸贏 → 不顯著', () => {
    const a = [1, -1, 0.5, -0.5, 2, -2, 0.3, -0.3];
    const b = [-1, 1, -0.5, 0.5, -2, 2, -0.3, 0.3];
    expect(pairedCompare(a, b).significant).toBe(false);
  });

  it('樣本 < 2 → 不假裝算得出檢定', () => {
    expect(pairedCompare([1], [2]).significant).toBe(false);
    expect(pairedCompare([], []).n).toBe(0);
  });
});

describe('pairedCompare 差異完全一致的退化情況', () => {
  // 早期版本這裡回 t=0「不顯著」，把「每筆都穩定改善」判反了。
  it('差異一致且非零 → 顯著（t 無限大）', () => {
    const r = pairedCompare([0, -1, 1], [0.5, -0.5, 1.5]);
    expect(r.significant).toBe(true);
    expect(r.t).toBe(Infinity);
  });

  it('差異一致且為零 → 不顯著', () => {
    const r = pairedCompare([1, 2, 3], [1, 2, 3]);
    expect(r.significant).toBe(false);
    expect(r.t).toBe(0);
  });

  it('一致變差 → 顯著且方向為負', () => {
    const r = pairedCompare([1, 2, 3], [0.5, 1.5, 2.5]);
    expect(r.significant).toBe(true);
    expect(r.t).toBe(-Infinity);
  });
});
