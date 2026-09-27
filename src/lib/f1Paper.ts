// F1「資金費率極端值反向」——規則與結算的唯一一份。
//
// 2026-09-27B（docs/ANALYSIS-2026-09-27B-結構性資訊候選.md）：回測裡 F1 是 14 種策略中
// 唯一帶有真實資訊的（費率極負時做多，2 批幣 10/10 個年度都贏過無條件做多），但沒過
// 錄取標準，第三批幣上扣成本後 −0.013R。所以它不上線交易，只做**前向紙上追蹤**：
// route.ts 記錄訊號、到期後照同一套規則結算，**不下任何單**。未來的資料不可能被事先
// 挑過，這是唯一真正的樣本外。
//
// scripts/structural-candidates.ts 的回測也 import 這裡——紙上追蹤跟回測必須是同一套
// 規則，否則前向結果跟回測就沒辦法比。
//
// ── 前向判準（2026-09-28 寫死，不看結果改）──
//   滿 6 個月且 n ≥ 300：淨 R 95% CI 下界 > 0 且月加總 t ≥ 2，才考慮接真倉。

export const F1 = {
  WINDOW: 90,          // 比較基準：該幣前 90 次結算（約 30 天）
  P_HI: 0.95,
  P_LO: 0.05,
  MIN_HI: 0.0005,      // 做空門檻至少 0.05%/8h（基準費率 0.01% 的 5 倍）
  MAX_LO: -0.0002,     // 做多門檻至多 −0.02%/8h
  HOLD_BARS: 18,       // 4H × 18 = 72 小時
  STOP_ATR: 3,
  ATR_N: 20,
} as const;

export const F1_TAKER = 0.0005;
export const F1_ENTRY_SLIP = 0.0003;
export const F1_STOP_SLIP = 0.0005;
const H4 = 4 * 3_600_000;

export interface Bar { openTime: number; open: number; high: number; low: number; close: number; closeTime: number }
export interface FundingPoint { t: number; rate: number }

/**
 * 這次結算的費率 fr 相對前 WINDOW 次結算（window，不含 fr 本身）算不算極端。
 * 1 = 做空太擁擠、反向做多；−1 = 做多太擁擠、反向做空；0 = 不做。
 */
export function f1Direction(window: number[], fr: number): 1 | -1 | 0 {
  if (window.length < F1.WINDOW) return 0;
  const w = window.slice(-F1.WINDOW).sort((a, b) => a - b);
  const hi = w[Math.min(w.length - 1, Math.floor(w.length * F1.P_HI))];
  const lo = w[Math.floor(w.length * F1.P_LO)];
  if (fr >= Math.max(hi, F1.MIN_HI)) return -1;
  if (fr <= Math.min(lo, F1.MAX_LO)) return 1;
  return 0;
}

/** 結算之後第一根 4H K 棒的開盤時間（結算剛好落在 4H 邊界時就是那一根） */
export function f1EntryTime(settlementT: number): number {
  return Math.ceil(settlementT / H4) * H4;
}

export function atrSeries(c: Bar[], n: number = F1.ATR_N): number[] {
  const tr = c.map((x, i) => i === 0 ? x.high - x.low
    : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)));
  const out = new Array(c.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < c.length; i++) {
    s += tr[i];
    if (i >= n) s -= tr[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

export interface HoldResult { grossR: number; netR: number; exitIdx: number; stopped: boolean }

/**
 * entryIdx 那根開盤進場（加滑價），止損 stopDist，最多持有 holdBars 根、最後一根收盤出場。
 * 跳空越過止損用開盤價出場；進場那根就碰到止損判止損（悲觀）。
 * 淨 R 扣進出兩邊 Taker 手續費與持倉期間的資金費率（滑價已含在進出場價）。
 * 資料不夠走完回 null。
 */
export function simulateHold(
  c: Bar[], entryIdx: number, dir: 1 | -1, stopDist: number, holdBars: number, fund: FundingPoint[],
): HoldResult | null {
  if (entryIdx < 0 || entryIdx >= c.length || !(stopDist > 0)) return null;
  const last = entryIdx + holdBars - 1;
  if (last >= c.length) return null;
  const entry = c[entryIdx].open * (1 + dir * F1_ENTRY_SLIP);
  const stop = entry - dir * stopDist;
  let exitIdx = -1, exitPx = 0, stopped = false;
  for (let k = entryIdx; k <= last; k++) {
    const b = c[k];
    if (k > entryIdx && (dir === 1 ? b.open <= stop : b.open >= stop)) { exitIdx = k; exitPx = b.open * (1 - dir * F1_STOP_SLIP); stopped = true; break; }
    if (dir === 1 ? b.low <= stop : b.high >= stop) { exitIdx = k; exitPx = stop * (1 - dir * F1_STOP_SLIP); stopped = true; break; }
  }
  if (exitIdx < 0) { exitIdx = last; exitPx = c[last].close * (1 - dir * F1_ENTRY_SLIP); }
  const risk = Math.abs(entry - stop);
  const riskPct = risk / entry;
  const grossR = dir * (exitPx - entry) / risk;
  let fr = 0;
  for (const x of fund) if (x.t > c[entryIdx].openTime && x.t <= c[exitIdx].closeTime) fr += x.rate;
  const netR = grossR - (2 * F1_TAKER) / riskPct - dir * fr / riskPct;
  return { grossR, netR, exitIdx, stopped };
}

// ── 紙上追蹤的紀錄 ─────────────────────────────────────────────────
export interface F1PaperTrade {
  id: string;            // `${symbol}:${settlementT}`
  symbol: string;
  dir: 1 | -1;
  settlementT: number;
  fundingRate: number;
  entryT: number;        // 進場那根 4H 的開盤時間
  status: 'open' | 'done' | 'void';
  grossR?: number;
  netR?: number;
  exitT?: number;
  stopped?: boolean;
  resolvedAt?: number;
  note?: string;
}

/** 最早什麼時候可以結算：最後一根持有的 4H 收盤之後 */
export function f1ResolvableAt(t: Pick<F1PaperTrade, 'entryT'>): number {
  return t.entryT + F1.HOLD_BARS * H4;
}

/**
 * 結算一筆紙上單。candles 必須是 4H、依時間排序，且涵蓋 entryT 之前至少 ATR_N 根
 * 到 entryT 之後 HOLD_BARS 根；不夠就回 null（下次再試）。
 * 止損距離用「進場前一根」的 ATR——跟回測一致，進場當下看得到的資訊。
 */
export function resolveF1Trade(t: F1PaperTrade, candles: Bar[], fund: FundingPoint[], now: number): F1PaperTrade | null {
  const i = candles.findIndex(c => c.openTime === t.entryT);
  if (i < F1.ATR_N) return null;
  const a = atrSeries(candles)[i - 1];
  if (!(a > 0)) return { ...t, status: 'void', note: 'ATR 無效', resolvedAt: now };
  const r = simulateHold(candles, i, t.dir, F1.STOP_ATR * a, F1.HOLD_BARS, fund);
  if (!r) return null;
  return {
    ...t, status: 'done', grossR: r.grossR, netR: r.netR, stopped: r.stopped,
    exitT: candles[r.exitIdx].closeTime, resolvedAt: now,
  };
}

/**
 * 從一檔幣的費率歷史（依時間排序）找出 lastProcessedT 之後的新訊號。
 * busyUntil：這檔幣前一筆紙上單的（預估）出場時間；在那之前的訊號不收（同一時間一檔一筆，
 * 跟回測一致）。回傳新訊號，呼叫端負責更新 busyUntil。
 */
export function detectF1Signals(
  symbol: string, fund: FundingPoint[], lastProcessedT: number, busyUntil: number,
): F1PaperTrade[] {
  const out: F1PaperTrade[] = [];
  let busy = busyUntil;
  for (let k = F1.WINDOW; k < fund.length; k++) {
    const { t, rate } = fund[k];
    if (t <= lastProcessedT) continue;
    const dir = f1Direction(fund.slice(k - F1.WINDOW, k).map(x => x.rate), rate);
    if (!dir) continue;
    const entryT = f1EntryTime(t);
    if (entryT < busy) continue;
    out.push({ id: `${symbol}:${t}`, symbol, dir, settlementT: t, fundingRate: rate, entryT, status: 'open' });
    busy = f1ResolvableAt({ entryT });
  }
  return out;
}

/** 前向追蹤的幣種：回測第一批 29 檔 + 第三批 25 檔（兩批都用過，前向資料才是新的） */
export const F1_UNIVERSE = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'BNBUSDT', 'LTCUSDT',
  'LINKUSDT', 'AVAXUSDT', 'DOTUSDT', 'BCHUSDT', 'TRXUSDT', 'ETCUSDT', 'ATOMUSDT',
  'FILUSDT', 'NEARUSDT', 'ALGOUSDT', 'XLMUSDT', 'UNIUSDT', 'AAVEUSDT', 'SANDUSDT', 'MANAUSDT',
  'AXSUSDT', 'THETAUSDT', 'VETUSDT', 'XTZUSDT', 'ZECUSDT', 'EGLDUSDT',
  'OPUSDT', 'ARBUSDT', 'APTUSDT', 'SUIUSDT', 'INJUSDT', 'LDOUSDT', 'APEUSDT', 'GMTUSDT',
  'GALAUSDT', 'CRVUSDT', 'DYDXUSDT', 'IMXUSDT', 'BLURUSDT', '1000PEPEUSDT', 'WLDUSDT', 'SEIUSDT',
  'TIAUSDT', 'STXUSDT', 'RUNEUSDT', 'CFXUSDT', 'FETUSDT', 'ORDIUSDT', 'JUPUSDT', '1000SHIBUSDT', 'ENSUSDT',
];
