// S3-A＋S3-B 在幣安 testnet 真的下單（docs/strategy-deploy-2026-10-06.md §3、§3.1、§3.2、§2.6、§8；
// 同帳戶合併部位的設計見 docs/superpowers/specs/2026-10-07-s3b-live-shared-account-design.md）。
// 由 scripts/live-runner.ts 每輪（15 秒）呼叫 runS3aLive；跟舊策略的管理完全分開
// （舊策略的單在 Supabase trades 表，這裡的單只在 Redis s3a-live:*）。
//
// S3-A 與 S3-B 的訊號與出場規則完全相同，差別只有每筆風險（4%／3%）、持倉上限與 B 的 +1R 加碼。
// 所以同一個幣在交易所只有一個部位、一張止損，內部記錄 A 份／B 份／加碼份（legs），出場時依成交紀錄分帳。
//
// 訊號一律用正式站行情（文件 §2.1）：共用 src/lib/s3s1 的規則與 prep 快照（幣池、BTC 條件、
// 市場廣度、S3 候選）。下單在 testnet，進場價 E 用 testnet 實際成交均價。
//
// 每天 UTC 00:00:30 之後的第一輪（只在 2 小時內開新倉）：
//   1. prep 快照不在就自己算（runPrep，與 Vercel 那邊同一支程式、寫同一個 key）
//   2. 先更新既有持倉的移動止損（LL10，只上移；保本後不低於 E）
//   3. 再處理新訊號：資金費、分數（E 用 testnet 現價估）、A／B 各自的上限與停用、最小下單量 → 市價買進
//      → 掛 STOP_MARKET（全部數量）＋ TAKE_PROFIT_MARKET（A、B 各 1/3，E＋1R）＋ B 的加碼 STOP_MARKET BUY（E＋1R）
// 每一輪：
//   - 部位歸零 → 撤剩下的條件單、從成交紀錄分帳算 R、記錄、推播
//   - 止盈／加碼成交 → 止損改到 max(目前止損, E)、數量改成目前部位
//   - 止損單不見了 → 價格已穿過就市價平倉，否則補掛；連續 3 輪補不上就平倉
//   - 止盈／加碼單不見了且部位沒變 → 等一輪，仍然如此才當成被拒絕（價格已過就市價補做，否則重掛）
import type { Bar, FundingPoint } from '../lib/s3s1/rules';
import { DAY, H, FUNDING_MAX, BREADTH_MAX, MIN_RISK_FRAC, S3_TH, dailyFeatures, fundingAt, idxOf, s3Score } from '../lib/s3s1/rules';
import type { PrepSnapshot } from '../lib/s3s1/engine';

export type Leg = 'A' | 'B';
export const LEG_KEYS: Leg[] = ['A', 'B'];
/** 兩個策略各自的參數（文件 §3.1、§3.2、§8）；meta 鍵 A 無前綴（沿用部署初期的鍵）、B 前綴 b. */
export const LEGS: Record<Leg, { name: string; F: number; HEAT: number; CAP: number; DD: number; STREAK: number; prefix: string }> = {
  A: { name: 'S3-A', F: 0.04, HEAT: 0.20, CAP: 10, DD: 0.35, STREAK: 7, prefix: '' },
  B: { name: 'S3-B', F: 0.03, HEAT: 0.20, CAP: 10, DD: 0.40, STREAK: 15, prefix: 'b.' },
};
/** 加碼風險：B 權益 × 3% ÷ 1R（文件 §3.2） */
export const ADDON_F = 0.03;

export const S3A = { F: LEGS.A.F, HEAT: LEGS.A.HEAT, CAP: LEGS.A.CAP, MIN_QTY_RISK_MULT: 1.5, MAX_LEV: 10,
  /** 只在 UTC 00:00 後這段時間內開新倉：回測的 E 是當天開盤價，晚好幾小時才進場就不是同一筆交易了 */
  ENTRY_WINDOW_MS: 2 * 3_600_000 } as const;

// ════════════════════════════════════════════════════════════════════
// 純函數（有單元測試：tests/s3aLive.test.ts、tests/s3Legs.test.ts）
// ════════════════════════════════════════════════════════════════════
export interface LegPos { qty0: number; tpQty: number; equityAtEntry: number; minQtyUsed: boolean }

export interface LivePos {
  symbol: string;
  signalDay: number;      // D
  entryDay: number;       // D+1（進場那根日線的開盤）
  entryAt: number;        // 實際成交時間
  entry: number;          // E（testnet 成交均價）
  stop0: number;          // 初始止損
  stop: number;           // 目前止損
  qty0: number;           // 原單總數量（A＋B）
  tpQty: number;          // 止盈單數量（A、B 各自 1/3 的和）
  partial: boolean;       // 止盈已成交
  stopAlgoId: number | null;
  tpAlgoId: number | null;
  /** 目前止損單的數量（部位數量變了就要換單） */
  stopQty?: number;
  trailDay: number;       // 最後一次套用移動止損的決策日
  stopFailures: number;
  /** A 份、B 份（沒有 legs 的舊紀錄 = 全部是 A） */
  legs?: Partial<Record<Leg, LegPos>>;
  /** B 的加碼單（E＋1R 的 STOP_MARKET BUY） */
  addQty?: number;
  addAlgoId?: number | null;
  addFilled?: boolean;
  /** 條件單不見、部位沒變的連續輪數（第二輪才當成被拒絕） */
  miss?: { tp?: number; add?: number };
  score: number; dist: number; btcExt: number; ret7: number; breadth: number; funding: number;
  /** 下單當下的參考價（testnet 最新成交價）；滑價 = entry − refPx（文件 §7.3） */
  refPx?: number;
  /** 止盈成交、加碼成交、每次止損移動、補單等事件（文件 §7.2） */
  events?: { t: number; kind: string; px?: number; qty?: number; note?: string }[];
}

/** testnet 上每個 S3 候選的決策紀錄（含被擋掉的，文件 §7.1）。legs：A／B 各自 'open' 或擋掉理由 */
export interface LiveSignal {
  symbol: string; signalDay: number; decision: 'open' | 'skip'; reason?: string; at: number;
  close: number; hh20: number; atr14: number; stop: number; ret7: number;
  btcOk: boolean; btcExt: number; breadth: number; funding?: number;
  refPx?: number; dist?: number; score?: number; scoreParts?: number[];
  legs?: Partial<Record<Leg, string>>;
}

export const legsOf = (p: Pick<LivePos, 'legs' | 'qty0' | 'tpQty'>): Partial<Record<Leg, LegPos>> =>
  p.legs ?? { A: { qty0: p.qty0, tpQty: p.tpQty, equityAtEntry: 0, minQtyUsed: false } };

/** 移動止損：決策日 X，用 D = X−1 的 LL10（只在 D ≥ 進場那根日線時）；只上移；止盈或加碼成交後不低於 E */
export function trailedStop(p: Pick<LivePos, 'stop' | 'entry' | 'partial' | 'entryDay'> & { addFilled?: boolean }, ll10D: number | null, D: number): number {
  let s = p.stop;
  if (ll10D != null && Number.isFinite(ll10D) && D >= p.entryDay) s = Math.max(s, ll10D);
  if (p.partial || p.addFilled) s = Math.max(s, p.entry);
  return s;
}

const decimals = (step: number) => { const t = step.toString(); return t.includes('e-') ? +t.split('e-')[1] : (t.split('.')[1]?.length ?? 0); };
export const floorTo = (q: number, step: number) => (step > 0 ? +(Math.floor(q / step + 1e-9) * step).toFixed(decimals(step)) : q);
export const ceilTo = (q: number, step: number) => (step > 0 ? +(Math.ceil(q / step - 1e-9) * step).toFixed(decimals(step)) : q);
export const roundTick = (p: number, tick: number) => (tick > 0 ? +(Math.round(p / tick) * tick).toFixed(decimals(tick)) : p);

/** 數量（文件 §2.6）：權益 × f ÷ (E − SL) 捨去；不足最小量時，最小量風險 ≤ 1.5f 才用最小量，否則不做 */
export function sizePosition(equity: number, f: number, entry: number, stop: number, flt: { stepSize: number; minQty: number; minNotional: number })
  : { qty: number; minQtyUsed: boolean } | { skip: string } {
  const budget = equity * f;
  const risk = entry - stop;
  if (!(risk > 0)) return { skip: '止損在進場價之上' };
  const qty = floorTo(budget / risk, flt.stepSize);
  if (qty >= flt.minQty && qty * entry >= flt.minNotional && qty > 0) return { qty, minQtyUsed: false };
  const qMin = Math.max(flt.minQty, ceilTo(flt.minNotional / entry, flt.stepSize), flt.stepSize);
  if (qMin * risk <= S3A.MIN_QTY_RISK_MULT * budget) return { qty: qMin, minQtyUsed: true };
  return { skip: `低於最小下單量（最小量風險 ${(qMin * risk).toFixed(2)} > 1.5×${budget.toFixed(2)}）` };
}

/** 逐倉槓桿：讓強平價明顯低於止損（強平 < SL × 0.9）。近似強平距離 ≈ 1/槓桿 − 維持保證金率 */
export function leverageFor(entry: number, stop: number, mmr = 0.01, maxLev: number = S3A.MAX_LEV): number {
  const need = 1 - (0.9 * stop) / entry + mmr; // 強平距離至少要這麼大
  return Math.max(1, Math.min(maxLev, Math.floor(1 / need)));
}

/** 這個策略還能不能開新倉（停用、持倉數與風險加總上限） */
export function legCanOpen(leg: Leg, openCount: number, halted: string | null): string | null {
  const L = LEGS[leg];
  if (halted) return `已停用：${halted}`;
  if (openCount >= L.CAP || (openCount + 1) * L.F > L.HEAT + 1e-9) return '已達持倉／風險上限';
  return null;
}

/** 一個策略在 s3a-live:meta 裡的帳 */
export function legMeta(meta: Record<string, unknown>, leg: Leg) {
  const k = (s: string) => meta[LEGS[leg].prefix + s];
  const base = Number(k('baseEquity') ?? 0), realized = Number(k('realized') ?? 0);
  return {
    base, realized, equity: base + realized,
    peak: Number(k('peakRealized') ?? 0),
    streak: Number(k('lossStreak') ?? 0),
    halted: k('halted') ? String(k('halted')) : null,
  };
}

/** 一筆結算後該策略的新帳（要寫進 meta 的鍵值）與是否觸發停用（文件 §8） */
export function legUpdate(meta: Record<string, unknown>, leg: Leg, net: number): { kv: Record<string, string>; halted: string | null } {
  const L = LEGS[leg], m = legMeta(meta, leg);
  const realized = m.realized + net;
  const peak = Math.max(m.peak, realized);
  const streak = net > 0 ? 0 : m.streak + 1;
  const dd = m.base > 0 ? (peak - realized) / (m.base + peak) : 0;
  const halted = m.halted ?? (dd > L.DD ? `回撤 ${(dd * 100).toFixed(0)}% > ${(L.DD * 100).toFixed(0)}%` : streak >= L.STREAK ? `連續虧損 ${streak} 筆` : null);
  const kv: Record<string, string> = {
    [`${L.prefix}realized`]: String(realized), [`${L.prefix}peakRealized`]: String(peak), [`${L.prefix}lossStreak`]: String(streak),
  };
  if (halted && !m.halted) kv[`${L.prefix}halted`] = halted;
  return { kv, halted };
}

export type PosCheck =
  | { kind: 'closed' }
  | { kind: 'fills'; tp: boolean; add: boolean; newStop: number }
  | { kind: 'stop_missing'; priceThrough: boolean }
  | { kind: 'stop_resize' }
  | { kind: 'wait'; which: 'tp' | 'add' }
  | { kind: 'tp_missing'; priceThrough: boolean }
  | { kind: 'add_missing'; priceThrough: boolean }
  | { kind: 'ok' };

/**
 * 每輪檢查一個持倉：qtyNow = 交易所部位數量；algoIds = 目前還掛著的條件單 id；price = 最新成交價。
 * 部位數量變了，只有「不見的條件單」能解釋時才當成成交（CLAUDE.md：部位變小不等於止盈成交）。
 */
export function checkPosition(p: LivePos, qtyNow: number, algoIds: Set<number>, price: number): PosCheck {
  if (qtyNow <= 0) return { kind: 'closed' };
  const addQty = p.addQty ?? 0;
  const expected = p.qty0 - (p.partial ? p.tpQty : 0) + (p.addFilled ? addQty : 0);
  const tol = 1e-6 * Math.max(1, p.qty0);
  const gone = (id: number | null | undefined) => id == null || !algoIds.has(id);
  const tpGone = !p.partial && p.tpQty > 0 && gone(p.tpAlgoId);
  const addGone = !p.addFilled && addQty > 0 && gone(p.addAlgoId);
  if (Math.abs(qtyNow - expected) > tol) {
    for (const tp of tpGone ? [true, false] : [false]) {
      for (const add of addGone ? [true, false] : [false]) {
        if (!tp && !add) continue;
        if (Math.abs(expected - (tp ? p.tpQty : 0) + (add ? addQty : 0) - qtyNow) <= tol) {
          return { kind: 'fills', tp, add, newStop: Math.max(p.stop, p.entry) };
        }
      }
    }
  }
  if (gone(p.stopAlgoId)) return { kind: 'stop_missing', priceThrough: price <= p.stop };
  if (p.stopQty != null && Math.abs(p.stopQty - qtyNow) > tol) return { kind: 'stop_resize' };
  // 不見了但部位沒變：可能剛觸發、市價單還沒成交，也可能被交易所拒絕（CLAUDE.md「條件單觸發不等於成交」）
  const lvl = p.entry + (p.entry - p.stop0);
  if (tpGone) return (p.miss?.tp ?? 0) >= 1 ? { kind: 'tp_missing', priceThrough: price >= lvl } : { kind: 'wait', which: 'tp' };
  if (addGone) return (p.miss?.add ?? 0) >= 1 ? { kind: 'add_missing', priceThrough: price >= lvl } : { kind: 'wait', which: 'add' };
  return { kind: 'ok' };
}

export interface Fill { side: string; price: string; qty: string; realizedPnl: string; commission: string; time: number }

export interface LegResult { qty0: number; net: number; R: number; addNet?: number }
export interface SplitResult {
  gross: number; fee: number; funding: number; net: number; exitAt: number; exitAvg: number | null;
  addQty: number; addEntry: number | null; legRes: Partial<Record<Leg, LegResult>>;
}

/**
 * 平倉後依成交紀錄分帳（設計文件「分帳」）。總損益以交易所的 realizedPnl 加總為準；
 * 加碼份 = 加碼成交量 × (最後出場賣單均價 − 加碼均價)，其餘依 A、B 原單數量比例分。
 * 賣單手續費與資金費依數量比例分（近似）；加碼買單手續費全歸加碼份。
 */
export function splitResult(p: LivePos, fills: Fill[], funding: number): SplitResult {
  const legs = legsOf(p);
  const q = (f: Fill) => +f.qty;
  const gross = fills.reduce((a, f) => a + +f.realizedPnl, 0);
  const addBuys = fills.filter(f => f.side === 'BUY' && f.time > p.entryAt + 60_000);
  const addQty = addBuys.reduce((a, f) => a + q(f), 0);
  const addEntry = addQty > 0 ? addBuys.reduce((a, f) => a + q(f) * +f.price, 0) / addQty : null;
  // 最後出場的那一段：時間倒序累加到 (原單 − 已止盈 + 加碼) 的數量
  const finalQty = p.qty0 - (p.partial ? p.tpQty : 0) + addQty;
  const sells = fills.filter(f => f.side === 'SELL').sort((a, b) => b.time - a.time);
  let left = finalQty, val = 0, got = 0, finalFee = 0, exitAt = p.entryAt;
  for (const f of sells) {
    exitAt = Math.max(exitAt, f.time);
    if (left <= 1e-12) continue;
    const take = Math.min(q(f), left), share = take / q(f);
    val += take * +f.price; got += take; finalFee += +f.commission * share; left -= take;
  }
  const exitAvg = got > 0 ? val / got : null;
  const fee = fills.reduce((a, f) => a + +f.commission, 0);
  const addFee = addBuys.reduce((a, f) => a + +f.commission, 0) + (finalQty > 0 ? finalFee * addQty / finalQty : 0);
  const addFund = funding * (addQty / (p.qty0 + addQty));
  const addNet = addQty > 0 && addEntry != null && exitAvg != null ? addQty * (exitAvg - addEntry) - addFee + addFund : 0;
  const net = gross - fee + funding;
  const origNet = net - addNet;
  const r1 = p.entry - p.stop0;
  const legRes: Partial<Record<Leg, LegResult>> = {};
  const totalOrig = LEG_KEYS.reduce((a, k) => a + (legs[k]?.qty0 ?? 0), 0);
  for (const k of LEG_KEYS) {
    const l = legs[k];
    if (!l || !(l.qty0 > 0)) continue;
    const share = totalOrig > 0 ? l.qty0 / totalOrig : 0;
    const legNet = origNet * share + (k === 'B' ? addNet : 0);
    legRes[k] = { qty0: l.qty0, net: legNet, R: r1 > 0 ? legNet / (l.qty0 * r1) : NaN, ...(k === 'B' ? { addNet } : {}) };
  }
  return { gross, fee, funding, net, exitAt, exitAvg, addQty, addEntry, legRes };
}

// ════════════════════════════════════════════════════════════════════
// 執行
// ════════════════════════════════════════════════════════════════════
export interface S3aClient {
  getBalance(): Promise<Array<{ asset: string; balance: string; availableBalance: string }>>;
  getPositionRisk(symbol?: string): Promise<Array<{ symbol: string; positionAmt: string; entryPrice: string }>>;
  getOpenOrders(symbol?: string): Promise<Array<{ symbol: string; orderId: number }>>;
  getOpenAlgoOrders(symbol?: string): Promise<Array<{ algoId: number; symbol: string; orderType: string }>>;
  getUserTrades(symbol: string, params?: { startTime?: number; limit?: number }): Promise<Fill[]>;
  getIncome(params: { symbol?: string; incomeType?: string; startTime?: number; limit?: number }): Promise<Array<{ incomeType: string; income: string; time: number }>>;
  setLeverage(symbol: string, leverage: number): Promise<unknown>;
  setMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED'): Promise<unknown>;
  placeOrder(p: { symbol: string; side: 'BUY' | 'SELL'; type: 'MARKET' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET'; quantity?: number; stopPrice?: number; reduceOnly?: boolean; newClientOrderId?: string }): Promise<{ orderId: number }>;
  cancelOrder(symbol: string, orderId: number, isAlgo?: boolean): Promise<unknown>;
  tickerPrice(symbol: string): Promise<number>;
}

export interface S3aStore {
  get(key: string): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, unknown> | null>;
  hset(key: string, kv: Record<string, string>): Promise<unknown>;
  hdel(key: string, ...f: string[]): Promise<unknown>;
  lpush(key: string, ...values: string[]): Promise<unknown>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
}

export interface S3aCtx {
  client: S3aClient;
  store: S3aStore;
  /** testnet 下單限制 */
  filters: Map<string, { stepSize: number; tickSize: number; minNotional: number; minQty?: number }>;
  /** 正式站：日線（LL10 用）與資金費率 */
  mainnetDaily(symbol: string): Promise<Bar[]>;
  mainnetFunding(symbol: string, startTime: number): Promise<FundingPoint[]>;
  /** prep 快照不存在時呼叫（與 Vercel 同一支 runPrep） */
  ensurePrep(now: number): Promise<void>;
  notify(title: string, body: string): Promise<void>;
  log(msg: string): void;
  dryRun: boolean;
  killSwitch: boolean;
  now: number;
}

const parse = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
const ev = (p: LivePos, kind: string, x: { px?: number; qty?: number; note?: string } = {}) => { (p.events ??= []).push({ t: Date.now(), kind, ...x }); };
const fmt = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(2) : x.toPrecision(5));
const coin = (s: string) => s.replace(/USDT$/, '');
/** 推播標題用：這個部位屬於哪些策略 */
const legTag = (p: Pick<LivePos, 'legs' | 'qty0' | 'tpQty'>) => LEG_KEYS.filter(k => legsOf(p)[k]).map(k => LEGS[k].name).join('＋');
const cid = (kind: string, sym: string, t: number) => `s3a-${kind}-${sym}-${Math.floor(t / 1000)}`.slice(0, 36);

async function place(ctx: S3aCtx, p: Parameters<S3aClient['placeOrder']>[0]): Promise<number | null> {
  if (ctx.dryRun) { ctx.log(`   [DRY] ${p.type} ${p.side} ${p.symbol} qty=${p.quantity ?? '-'} trigger=${p.stopPrice ?? '-'}${p.reduceOnly ? '' : '（非 reduceOnly）'}`); return -1; }
  const r = await ctx.client.placeOrder(p);
  return r.orderId;
}
async function cancelAlgo(ctx: S3aCtx, symbol: string, id: number | null | undefined) {
  if (id == null || id < 0) return;
  if (ctx.dryRun) { ctx.log(`   [DRY] 撤條件單 ${symbol} ${id}`); return; }
  try { await ctx.client.cancelOrder(symbol, id, true); } catch { /* 已觸發或已撤掉 */ }
}

async function placeStop(ctx: S3aCtx, p: LivePos, qty: number, stop: number): Promise<number | null> {
  const tick = ctx.filters.get(p.symbol)?.tickSize ?? 0;
  return place(ctx, { symbol: p.symbol, side: 'SELL', type: 'STOP_MARKET', quantity: qty, stopPrice: roundTick(stop, tick), reduceOnly: true,
    newClientOrderId: cid('sl', p.symbol, ctx.now) });
}
/** 換止損：先掛新的、再撤舊的——任何時刻都有止損 */
async function replaceStop(ctx: S3aCtx, p: LivePos, qty: number, stop: number) {
  const id = await placeStop(ctx, p, qty, stop);
  await cancelAlgo(ctx, p.symbol, p.stopAlgoId);
  Object.assign(p, { stop, stopAlgoId: id, stopQty: qty, stopFailures: 0 });
}
async function placeTp(ctx: S3aCtx, p: LivePos): Promise<number | null> {
  const tick = ctx.filters.get(p.symbol)?.tickSize ?? 0;
  return place(ctx, { symbol: p.symbol, side: 'SELL', type: 'TAKE_PROFIT_MARKET', quantity: p.tpQty,
    stopPrice: roundTick(p.entry + (p.entry - p.stop0), tick), reduceOnly: true, newClientOrderId: cid('tp', p.symbol, ctx.now) });
}
async function placeAddon(ctx: S3aCtx, p: LivePos): Promise<number | null> {
  const tick = ctx.filters.get(p.symbol)?.tickSize ?? 0;
  return place(ctx, { symbol: p.symbol, side: 'BUY', type: 'STOP_MARKET', quantity: p.addQty,
    stopPrice: roundTick(p.entry + (p.entry - p.stop0), tick), newClientOrderId: cid('add', p.symbol, ctx.now) });
}

/** 平掉剩餘部位（reduceOnly 市價） */
async function closeAll(ctx: S3aCtx, p: LivePos, qty: number, why: string) {
  ctx.log(`   ⚠ ${p.symbol} 市價平倉 ${qty}（${why}）`);
  await place(ctx, { symbol: p.symbol, side: 'SELL', type: 'MARKET', quantity: qty, reduceOnly: true, newClientOrderId: cid('x', p.symbol, ctx.now) });
}

/** testnet 錢包餘額與模式寫進 s3a-live:meta（給 App 看）。dryRun 也寫：s3a-dryrun 用的是記憶體 store */
async function writeWallet(ctx: S3aCtx): Promise<void> {
  try {
    const bal = (await ctx.client.getBalance()).find(b => b.asset === 'USDT');
    await ctx.store.hset('s3a-live:meta', { wallet: String(bal ? +bal.balance : 0), walletAt: String(ctx.now), mode: ctx.dryRun ? 'dry' : 'live' });
  } catch (e) { ctx.log(`   S3：讀錢包餘額失敗（下小時再試）：${String(e).slice(0, 100)}`); }
}

/** 已平倉：從成交紀錄與資金費流水分帳，更新 A／B 各自的帳與停用狀態 */
async function finalize(ctx: S3aCtx, p: LivePos) {
  let fills: Fill[] = [];
  try { fills = await ctx.client.getUserTrades(p.symbol, { startTime: p.entryAt - 60_000, limit: 1000 }); }
  catch (e) { ctx.log(`   ${p.symbol} 讀成交紀錄失敗：${String(e).slice(0, 100)}`); }
  let funding = 0;
  try {
    const inc = await ctx.client.getIncome({ symbol: p.symbol, incomeType: 'FUNDING_FEE', startTime: p.entryAt, limit: 1000 });
    funding = inc.reduce((a, x) => a + +x.income, 0);
  } catch { /* 拿不到就當 0 */ }
  const s = splitResult(p, fills, funding);
  const risk0 = p.qty0 * (p.entry - p.stop0);
  const R = risk0 > 0 ? s.net / risk0 : NaN;
  const rec = { ...p, status: 'done', exitAt: s.exitAt, exitAvg: s.exitAvg, realizedPnl: s.gross, fee: s.fee, fundingFee: funding, netPnl: s.net, R,
    addQtyFilled: s.addQty, addEntry: s.addEntry, legRes: s.legRes };
  await ctx.store.hset('s3a-live:done', { [`${p.symbol}:${p.entryDay}`]: JSON.stringify(rec) });
  await ctx.store.hdel('s3a-live:pos', p.symbol);
  const meta = (await ctx.store.hgetall('s3a-live:meta')) ?? {};
  const kv: Record<string, string> = { [`lastExit:${p.symbol}`]: String(s.exitAt) };
  const lines: string[] = [];
  for (const k of LEG_KEYS) {
    const lr = s.legRes[k];
    if (!lr) continue;
    const u = legUpdate(meta, k, lr.net);
    Object.assign(kv, u.kv);
    lines.push(`${LEGS[k].name} ${lr.net >= 0 ? '+' : ''}${lr.net.toFixed(2)}U（${Number.isFinite(lr.R) ? `${lr.R >= 0 ? '+' : ''}${lr.R.toFixed(2)}R` : '—'}）${u.halted && !legMeta(meta, k).halted ? `⛔ 停用：${u.halted}` : ''}`);
  }
  await ctx.store.hset('s3a-live:meta', kv);
  await writeWallet(ctx);
  ctx.log(`   ✅ ${p.symbol} 平倉：${lines.join('；')}`);
  await ctx.notify(`${legTag(p)} 出場 ${coin(p.symbol)}`, lines.join('｜'));
}

export async function runS3aLive(ctx: S3aCtx): Promise<void> {
  const { client, store, now } = ctx;
  const X = Math.floor(now / DAY) * DAY;
  const posMap = new Map(Object.entries((await store.hgetall('s3a-live:pos')) ?? {}).map(([k, v]) => [k, parse<LivePos>(v)]));
  const meta = (await store.hgetall('s3a-live:meta')) ?? {};
  const daily = now - X >= 30_000 && Number(meta.lastDay ?? 0) < X;
  // App 首頁顯示 testnet 錢包權益與模式：每小時寫一次（進出場後另外再寫）；放在早退之前，沒持倉時也會更新
  if (now - Number(meta.walletAt ?? 0) >= 3_600_000) await writeWallet(ctx);
  if (!posMap.size && !daily) return;

  const risks = await client.getPositionRisk();
  const qtyOf = new Map(risks.map(r => [r.symbol, +r.positionAmt]));
  const algos = posMap.size ? await client.getOpenAlgoOrders() : [];
  const algoIds = new Set(algos.map(a => a.algoId));

  // ── 每輪：管理既有持倉 ──
  for (const p of Array.from(posMap.values())) {
    try {
      const qtyNow = qtyOf.get(p.symbol) ?? 0;
      const price = qtyNow > 0 ? await client.tickerPrice(p.symbol) : 0;
      const c = checkPosition(p, qtyNow, algoIds, price);
      const tag = `${legTag(p)} ${coin(p.symbol)}`;
      if (c.kind !== 'wait' && c.kind !== 'tp_missing' && c.kind !== 'add_missing') p.miss = {};
      if (c.kind === 'closed') {
        for (const a of algos.filter(a => a.symbol === p.symbol)) await cancelAlgo(ctx, p.symbol, a.algoId);
        if (!ctx.dryRun) await finalize(ctx, p);
        posMap.delete(p.symbol);
        continue;
      }
      if (c.kind === 'fills') {
        if (c.tp) { p.partial = true; p.tpAlgoId = null; ev(p, 'tp1', { qty: p.tpQty }); }
        if (c.add) { p.addFilled = true; p.addAlgoId = null; ev(p, 'addon', { qty: p.addQty }); }
        await replaceStop(ctx, p, qtyNow, c.newStop);
        ev(p, 'stop', { px: c.newStop, qty: qtyNow, note: '止盈／加碼成交後移到保本' });
        const what = [c.tp ? `止盈 1/3（${p.tpQty}）` : '', c.add ? `加碼（${p.addQty}）` : ''].filter(Boolean).join('、');
        ctx.log(`   🎯 ${p.symbol} ${what}成交，止損移到 ${fmt(c.newStop)}（部位 ${qtyNow}）`);
        await ctx.notify(`${tag} ${what}成交`, `部位 ${qtyNow}，止損移到保本 ${fmt(c.newStop)}`);
      } else if (c.kind === 'stop_resize') {
        await replaceStop(ctx, p, qtyNow, p.stop);
        ctx.log(`   🛡 ${p.symbol} 部位數量變成 ${qtyNow}，止損單改成同數量`); ev(p, 'stop_resize', { qty: qtyNow, px: p.stop });
      } else if (c.kind === 'wait') {
        p.miss = { ...(p.miss ?? {}), [c.which]: (p.miss?.[c.which] ?? 0) + 1 };
      } else if (c.kind === 'tp_missing') {
        p.miss = { ...(p.miss ?? {}), tp: 0 };
        if (c.priceThrough) {
          // 已經越過 +1R：直接市價平掉止盈數量，等同止盈成交；下一輪會走 fills 把止損移到保本
          ctx.log(`   🎯 ${p.symbol} 止盈單不見了且價格已過 +1R，市價平 ${p.tpQty}`);
          ev(p, 'tp_market', { qty: p.tpQty, px: price, note: '止盈單不見、價格已過 +1R' });
          await place(ctx, { symbol: p.symbol, side: 'SELL', type: 'MARKET', quantity: p.tpQty, reduceOnly: true, newClientOrderId: cid('tpm', p.symbol, ctx.now) });
          p.tpAlgoId = null;
        } else {
          p.tpAlgoId = await placeTp(ctx, p);
          ctx.log(`   🎯 ${p.symbol} 補掛止盈單`); ev(p, 'tp_replace');
        }
      } else if (c.kind === 'add_missing') {
        p.miss = { ...(p.miss ?? {}), add: 0 };
        if (c.priceThrough) {
          ctx.log(`   ➕ ${p.symbol} 加碼單不見了且價格已過 +1R，市價加碼 ${p.addQty}`);
          ev(p, 'add_market', { qty: p.addQty, px: price, note: '加碼單不見、價格已過 +1R' });
          await place(ctx, { symbol: p.symbol, side: 'BUY', type: 'MARKET', quantity: p.addQty, newClientOrderId: cid('addm', p.symbol, ctx.now) });
          p.addAlgoId = null;
        } else {
          p.addAlgoId = await placeAddon(ctx, p);
          ctx.log(`   ➕ ${p.symbol} 補掛加碼單`); ev(p, 'add_replace');
        }
      } else if (c.kind === 'stop_missing') {
        if (c.priceThrough || p.stopFailures >= 3) {
          const why = c.priceThrough ? '止損單不見了且價格已穿過止損' : '止損單連續 3 輪補不上';
          ev(p, 'close_market', { qty: qtyNow, px: price, note: why });
          await closeAll(ctx, p, qtyNow, why);
        } else {
          try {
            p.stopAlgoId = await placeStop(ctx, p, qtyNow, p.stop);
            p.stopQty = qtyNow; p.stopFailures = 0;
            ctx.log(`   🛡 ${p.symbol} 補掛止損 ${fmt(p.stop)}`); ev(p, 'stop_replace', { px: p.stop });
          } catch (e) {
            p.stopFailures++;
            ctx.log(`   ❌ ${p.symbol} 補掛止損失敗（第 ${p.stopFailures} 次）：${String(e).slice(0, 120)}`);
            await ctx.notify(`${tag} ⚠ 沒有止損單`, `補掛失敗第 ${p.stopFailures} 次，第 3 次會直接市價平倉`);
          }
        }
      }
      if (!ctx.dryRun) await store.hset('s3a-live:pos', { [p.symbol]: JSON.stringify(p) });
    } catch (e) { ctx.log(`   ❌ ${p.symbol} 管理失敗：${String(e).slice(0, 150)}`); }
  }
  if (!daily) return;

  // ── 每天一次（00:00:30 後）──
  await ctx.ensurePrep(now);
  const snapRaw = await store.get(`s3s1:prep:${X}`);
  if (!snapRaw) { ctx.log('   S3：今天的 prep 快照還沒好，下一輪再試'); return; }
  const snap = parse<PrepSnapshot>(snapRaw);
  const D = X - DAY;

  // 1. 先更新移動止損（文件 §6：先處理出場、再處理進場）
  for (const p of Array.from(posMap.values())) {
    if (p.trailDay >= X) continue;
    try {
      const f = dailyFeatures(await ctx.mainnetDaily(p.symbol));
      const i = idxOf(f.bars, D);
      const ns = trailedStop(p, i >= 0 ? f.ll10[i] : null, D);
      p.trailDay = X;
      const tick = ctx.filters.get(p.symbol)?.tickSize ?? 0;
      if (roundTick(ns, tick) > roundTick(p.stop, tick)) {
        const old = p.stop;
        await replaceStop(ctx, p, qtyOf.get(p.symbol) ?? 0, ns);
        ctx.log(`   ↗ ${p.symbol} 移動止損 ${fmt(old)} → ${fmt(ns)}`);
        ev(p, 'stop', { px: ns, note: `LL10 移動（原 ${fmt(old)}）` });
      }
      if (!ctx.dryRun) await store.hset('s3a-live:pos', { [p.symbol]: JSON.stringify(p) });
    } catch (e) { ctx.log(`   ❌ ${p.symbol} 移動止損失敗（下一輪再試）：${String(e).slice(0, 150)}`); }
  }

  // 2. 新訊號
  const done = async () => { if (!ctx.dryRun) await store.hset('s3a-live:meta', { lastDay: String(X) }); };
  const sigOf = (c: PrepSnapshot['s3'][number], reason?: string): LiveSignal => ({
    symbol: c.symbol, signalDay: D, decision: 'skip', reason, at: now, close: c.close, hh20: c.hh20, atr14: c.atr14, stop: c.stop,
    ret7: c.ret7, btcOk: !!snap.btcOk[String(D)], btcExt: snap.btcExt[String(D)], breadth: snap.breadth });
  // 整天不開新倉時，當天的候選也要記下來（文件 §7.1：被擋掉的訊號一定要記錄）
  const skipAll = async (reason: string) => {
    if (snap.s3.length && !ctx.dryRun) {
      await store.lpush('s3a-live:signals', ...snap.s3.map(c => JSON.stringify(sigOf(c, reason))));
      await store.ltrim('s3a-live:signals', 0, 1999);
    }
    return done();
  };
  const lm = { A: legMeta(meta, 'A'), B: legMeta(meta, 'B') };
  if (now - X > S3A.ENTRY_WINDOW_MS) { ctx.log(`   S3：已超過進場時間窗（UTC 00:00 後 ${S3A.ENTRY_WINDOW_MS / 3_600_000} 小時），今天不開新倉`); return skipAll('超過進場時間窗'); }
  if (ctx.killSwitch) { ctx.log('   S3：kill switch 啟動中，不開新倉'); return skipAll('kill switch'); }
  if (lm.A.halted && lm.B.halted) { ctx.log('   S3：S3-A、S3-B 都已停用，不開新倉'); return skipAll(`兩個策略都已停用（A：${lm.A.halted}；B：${lm.B.halted}）`); }
  if (!snap.btcOk[String(D)]) { ctx.log('   S3：BTC 條件不成立，今天不開新倉'); return skipAll('BTC 條件不成立'); }
  if (!(snap.breadth < BREADTH_MAX)) { ctx.log(`   S3：市場過熱（廣度 ${snap.breadth.toFixed(3)}），今天不開新倉`); return skipAll(`市場過熱（廣度 ${snap.breadth.toFixed(3)}）`); }
  // 起始權益：第一次每日決策時，A、B 各取錢包的一半（設計文件「分帳」）
  if (!(lm.A.base > 0) || !(lm.B.base > 0)) {
    const bal = (await client.getBalance()).find(b => b.asset === 'USDT');
    const half = (bal ? +bal.balance : 0) / 2;
    const kv: Record<string, string> = {};
    if (!(lm.A.base > 0)) { kv.baseEquity = String(half); lm.A = { ...lm.A, base: half, equity: half + lm.A.realized }; }
    if (!(lm.B.base > 0)) { kv['b.baseEquity'] = String(half); lm.B = { ...lm.B, base: half, equity: half + lm.B.realized }; }
    if (!ctx.dryRun) await store.hset('s3a-live:meta', kv);
  }
  ctx.log(`   S3：今天候選 ${snap.s3.length} 個（BTC 條件成立、廣度 ${(snap.breadth * 100).toFixed(0)}%）`);
  const openOrders = await client.getOpenOrders();
  const legCount = (k: Leg) => Array.from(posMap.values()).filter(p => legsOf(p)[k]).length;
  const sigs: LiveSignal[] = [];
  for (const c of snap.s3.slice().sort((a, b) => b.vol - a.vol)) {
    const tag = `   S3 ${c.symbol}`;
    const sig = sigOf(c);
    sigs.push(sig);
    const log = (m: string) => { ctx.log(m); sig.reason = m.replace(tag + '：', '').replace(/，略過$|，不做$/, ''); };
    try {
      if (posMap.has(c.symbol)) { log(`${tag}：持倉中，略過`); continue; }
      if ((qtyOf.get(c.symbol) ?? 0) !== 0 || openOrders.some(o => o.symbol === c.symbol)) { log(`${tag}：帳戶上已有其他策略的持倉或掛單，略過`); continue; }
      if (Number(meta[`lastExit:${c.symbol}`] ?? 0) >= D) { log(`${tag}：上一筆在訊號 K 線期間才出場，略過`); continue; }
      const fr = fundingAt(await ctx.mainnetFunding(c.symbol, X - 2 * DAY), X);
      if (!(fr < FUNDING_MAX)) { log(`${tag}：資金費擁擠 ${fr}，略過`); continue; }
      sig.funding = fr;
      const px = await client.tickerPrice(c.symbol);
      const dist = (px - c.stop) / px;
      sig.refPx = px; sig.dist = dist;
      if (!(dist > MIN_RISK_FRAC)) { log(`${tag}：止損距離 ${(dist * 100).toFixed(2)}% 太小或價格已在止損下，略過`); continue; }
      const be = snap.btcExt[String(D)];
      const score = s3Score(dist, be, c.ret7);
      sig.score = score; sig.scoreParts = [dist <= S3_TH.risk ? 1 : 0, be >= S3_TH.btc ? 1 : 0, c.ret7 >= S3_TH.ret7 ? -1 : 0];
      if (score !== 2) { log(`${tag}：分數 ${score}（止損距離 ${dist.toFixed(4)}/${S3_TH.risk.toFixed(4)}、BTC ${be.toFixed(2)}/${S3_TH.btc.toFixed(2)}、7日 ${c.ret7.toFixed(3)}/${S3_TH.ret7.toFixed(3)}），不做`); continue; }
      const flt = ctx.filters.get(c.symbol);
      if (!flt) { log(`${tag}：testnet 沒有這個合約，略過`); continue; }
      const fl = { stepSize: flt.stepSize, minQty: flt.minQty ?? flt.stepSize, minNotional: flt.minNotional };
      // A、B 各自決定要不要開、開多少
      const legs: Partial<Record<Leg, LegPos>> = {};
      sig.legs = {};
      for (const k of LEG_KEYS) {
        const why = legCanOpen(k, legCount(k), lm[k].halted);
        if (why) { sig.legs[k] = why; continue; }
        const sz = sizePosition(lm[k].equity, LEGS[k].F, px, c.stop, fl);
        if ('skip' in sz) { sig.legs[k] = sz.skip; continue; }
        legs[k] = { qty0: sz.qty, tpQty: floorTo(sz.qty / 3, flt.stepSize), equityAtEntry: lm[k].equity, minQtyUsed: sz.minQtyUsed };
        sig.legs[k] = 'open';
      }
      if (!legs.A && !legs.B) { log(`${tag}：A：${sig.legs.A}；B：${sig.legs.B}`); continue; }
      const total = +((legs.A?.qty0 ?? 0) + (legs.B?.qty0 ?? 0)).toFixed(decimals(flt.stepSize));
      const lev = leverageFor(px, c.stop);
      if (!ctx.dryRun) {
        try { await client.setMarginType(c.symbol, 'ISOLATED'); } catch { /* 已經是逐倉 */ }
        await client.setLeverage(c.symbol, lev);
      }
      const who = LEG_KEYS.filter(k => legs[k]).map(k => `${LEGS[k].name} ${legs[k]!.qty0}`).join('＋');
      ctx.log(`${tag}：市價買進 ${total}（${who}；槓桿 ${lev}x、止損 ${fmt(c.stop)}、分數 2）`);
      await place(ctx, { symbol: c.symbol, side: 'BUY', type: 'MARKET', quantity: total, newClientOrderId: `s3a-in-${c.symbol}-${X / 1000}`.slice(0, 36) });
      let E = px, qty0 = total;
      if (!ctx.dryRun) {
        const pr = (await client.getPositionRisk(c.symbol)).find(r => r.symbol === c.symbol);
        if (!pr || +pr.positionAmt <= 0) { log(`${tag}：市價單送出但沒有持倉，略過`); continue; }
        E = +pr.entryPrice; qty0 = +pr.positionAmt;
      }
      const R1 = E - c.stop;
      const tpQty = +((legs.A?.tpQty ?? 0) + (legs.B?.tpQty ?? 0)).toFixed(decimals(flt.stepSize));
      // 加碼數量 = B 權益 × 3% ÷ 1R（文件 §3.2，以觸發價 E＋1R 估）；不足最小下單量就不掛
      let addQty = 0;
      if (legs.B && R1 > 0) {
        const q = floorTo(legs.B.equityAtEntry * ADDON_F / R1, flt.stepSize);
        if (q >= fl.minQty && q * (E + R1) >= fl.minNotional) addQty = q;
        else ctx.log(`${tag}：加碼數量 ${q} 低於最小下單量，不掛加碼`);
      }
      const p: LivePos = {
        symbol: c.symbol, signalDay: D, entryDay: X, entryAt: Date.now(), entry: E, stop0: c.stop, stop: c.stop, qty0,
        tpQty, partial: false, stopAlgoId: null, tpAlgoId: null, stopQty: qty0, trailDay: X, stopFailures: 0,
        legs, addQty, addAlgoId: null, addFilled: false, miss: {},
        score, dist: (E - c.stop) / E, btcExt: be, ret7: c.ret7, breadth: snap.breadth, funding: fr, refPx: px, events: [],
      };
      ev(p, 'entry', { px: E, qty: qty0, note: `${who}；參考價 ${fmt(px)}，滑價 ${((E / px - 1) * 1e4).toFixed(1)} bp` });
      sig.decision = 'open'; sig.reason = undefined;
      // 成交後先存檔再掛單：掛止損失敗時，下一輪的管理迴圈會看到「止損單不見了」並補掛／平倉，不會變成沒人管的孤兒
      posMap.set(c.symbol, p);
      const save = async () => { if (!ctx.dryRun) await store.hset('s3a-live:pos', { [c.symbol]: JSON.stringify(p) }); };
      await save();
      if (E <= c.stop) { ev(p, 'close_market', { qty: qty0, note: '成交價已在止損之下' }); await closeAll(ctx, p, qty0, '成交價已在止損之下'); await save(); continue; }
      try { p.stopAlgoId = await placeStop(ctx, p, qty0, c.stop); }
      catch (e) { ctx.log(`${tag}：掛止損失敗，下一輪補掛：${String(e).slice(0, 150)}`); }
      if (p.tpQty > 0 && p.tpQty * E >= flt.minNotional) {
        try { p.tpAlgoId = await placeTp(ctx, p); }
        catch (e) { ctx.log(`${tag}：掛止盈失敗，下一輪補掛：${String(e).slice(0, 150)}`); p.tpAlgoId = -2; }
      } else { ctx.log(`${tag}：1/3 數量低於最小下單量，不掛分批止盈`); p.tpQty = 0; }
      if (addQty > 0) {
        try { p.addAlgoId = await placeAddon(ctx, p); }
        catch (e) { ctx.log(`${tag}：掛加碼單失敗，下一輪補掛：${String(e).slice(0, 150)}`); p.addAlgoId = -2; }
      }
      await save();
      await writeWallet(ctx);
      await ctx.notify(`${legTag(p)} 進場 ${coin(c.symbol)}`,
        `買進 ${qty0}（${who}）@ ${fmt(E)}｜止損 ${fmt(c.stop)}｜+1R @ ${fmt(E + R1)} 平 1/3${addQty > 0 ? `、B 加碼 ${addQty}` : ''}`);
    } catch (e) {
      log(`${tag}：下單失敗：${String(e).slice(0, 200)}`);
      await ctx.notify(`S3 ⚠ ${coin(c.symbol)} 下單失敗`, String(e).slice(0, 120));
    }
  }
  if (sigs.length && !ctx.dryRun) { await store.lpush('s3a-live:signals', ...sigs.map(x => JSON.stringify(x))); await store.ltrim('s3a-live:signals', 0, 1999); }
  await done();
  void H;
}
