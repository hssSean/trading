// S3-A／S3-B／S1 的帳戶模擬（影子帳本）——三個獨立的 100 USDT 模擬帳戶，照文件 §2–§8。
//
// 每筆交易的結果一律用 rules.simulateTrade（已對文件 §10 參考交易驗收，誤差 < 1e-6）算 R，
// 帳戶損益 = R × 實際風險金額（數量依 stepSize 捨去後）；S3-B 另加加碼單的 R × 加碼風險金額。
// 損益在出場時入帳（與研究端的權益曲線同口徑）；新單用「當下錢包餘額（不含未實現）」算數量。
//
// 三個工作（由 /api/analyze 每天依序觸發，見 dueS3S1Job）：
//   prep：UTC 00:05 後。抓全部合約日線 → 幣池、市場廣度、BTC 條件、幣本身 EMA50、S3 候選 → 存 Redis。
//   s3  ：UTC 01:05 後（要等 00:00 那根 1H 收盤才知道進場價 E）。S3-A、S3-B 的出場結算＋新訊號。
//   s1  ：UTC 01:05 後處理 00:00 收盤的 12H、13:05 後處理 12:00 收盤的 12H。
// 第一次執行只記起點，不回補歷史。
import {
  DAY, H, H12, FUNDING_MAX, BREADTH_MAX, MIN_RISK_FRAC,
  dailyFeatures, h12Features, s3SignalAt, s1SignalAt, s3Score, btcOk, btcExt, breadthAt, universeOn,
  fundingAt, idxOf, simulateTrade, trimPartialFirstBar, isExcludedSymbol,
  type Bar, type FundingPoint, type DailyFeat, type TradeSim,
 S3_TH,} from './rules';

// ════════════════════════════════════════════════════════════════════
// 設定（文件 §3、§4、§5、§8）
// ════════════════════════════════════════════════════════════════════
export type AcctKey = 's3a' | 's3b' | 's1';
export const ACCTS: Record<AcctKey, {
  name: string; kind: 'S3' | 'S1'; f: number; heat: number; cap: number; addon: boolean; initial: number;
}> = {
  s3a: { name: 'S3-A｜唐奇安趨勢＋分數（主力）', kind: 'S3', f: 0.04, heat: 0.20, cap: 10, addon: false, initial: 100 },
  s3b: { name: 'S3-B｜唐奇安＋1R 加碼（對照組）', kind: 'S3', f: 0.03, heat: 0.20, cap: 10, addon: true, initial: 100 },
  s1:  { name: 'S1｜12H Keltner 短線（實驗性）', kind: 'S1', f: 0.01, heat: 0.20, cap: 20, addon: false, initial: 100 },
};
const ADDON_F = 0.03;
const MIN_QTY_RISK_MULT = 1.5;

export interface Store {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, opts?: { ex?: number }): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, unknown> | null>;
  hset(key: string, kv: Record<string, string>): Promise<unknown>;
  hdel(key: string, ...fields: string[]): Promise<unknown>;
  lpush(key: string, ...values: string[]): Promise<unknown>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
}

export interface SymbolFilter { stepSize: number; minQty: number; minNotional: number }
export interface Deps {
  /** 全部 USDT 本位永續（TRADING）與下單限制 */
  exchange(): Promise<Map<string, SymbolFilter>>;
  /** 已收盤 K 線，依時間排序；日線需帶 qv */
  klines(symbol: string, interval: '1h' | '12h' | '1d', limit: number, startTime?: number): Promise<Bar[]>;
  funding(symbol: string, startTime: number): Promise<FundingPoint[]>;
  /** 該幣第一根 1H 的開盤時間（上市時間） */
  listingHour(symbol: string): Promise<number>;
}

const parse = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
async function inChunks<T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < xs.length; i += n) out.push(...await Promise.all(xs.slice(i, i + n).map(fn)));
  return out;
}
// 數量對齊 stepSize。乘回去會有浮點誤差（11.2 → 11.200000000000001），用步長的小數位數四捨五入收掉；
// 1e-9 容差避免 16.24/0.01 = 1623.9999… 被削掉一格（CLAUDE.md「平倉數量取整不能留灰塵」）。
const stepDecimals = (step: number) => { const t = step.toString(); return t.includes('e-') ? +t.split('e-')[1] : (t.split('.')[1]?.length ?? 0); };
const fixStep = (q: number, step: number) => +q.toFixed(stepDecimals(step));
const floorStep = (q: number, step: number) => (step > 0 ? fixStep(Math.floor(q / step + 1e-9) * step, step) : q);
const ceilStep = (q: number, step: number) => (step > 0 ? fixStep(Math.ceil(q / step - 1e-9) * step, step) : q);

// ════════════════════════════════════════════════════════════════════
// 紀錄格式
// ════════════════════════════════════════════════════════════════════
export interface Position {
  id: string; acct: AcctKey; symbol: string; kind: 'S3' | 'S1';
  signalT: number; entryT: number; stop: number; entry: number;
  f: number; equityAtEntry: number; qty: number; riskUsdt: number; minQtyUsed: boolean;
  vol: number; score?: number; dist: number; btcExt?: number; ret7?: number; breadth: number; funding: number;
  status: 'open' | 'done';
  exitT?: number; exitPx?: number; exitReason?: string; partial?: boolean;
  grossR?: number; netR?: number; addR?: number | null; addRiskUsdt?: number; pnlUsdt?: number; equityAfter?: number;
}

export interface SignalLog {
  acct: AcctKey; symbol: string; signalT: number; decision: 'open' | 'skip'; reason?: string;
  close: number; stop: number; entry?: number; dist?: number; score?: number; scoreParts?: number[];
  btcOk: boolean; breadth: number; funding?: number; ind: Record<string, number>; at: number;
}

export interface AcctState {
  equity: number; peak: number; trades: number; wins: number;
  lossStreak: number; recent: number[];      // 最近 50 筆的淨損益（S1 停用條件用）
  halted: string | null;
  lastExit: Record<string, number>;          // symbol → 最後一筆出場時間（同幣「出場在訊號 K 線期間」規則）
}
const newState = (k: AcctKey): AcctState => ({ equity: ACCTS[k].initial, peak: ACCTS[k].initial, trades: 0, wins: 0, lossStreak: 0, recent: [], halted: null, lastExit: {} });

export interface PrepSnapshot {
  X: number;                                  // 決策日（UTC 00:00）
  breadth: number;                            // X−1 收盤的市場廣度
  uni: Record<string, { symbol: string; vol: number }[]>;   // day(ms 字串) → 前 100
  up: Record<string, string[]>;               // day → 該日收盤 > EMA50 的幣（只存幣池內的）
  btcOk: Record<string, boolean>;             // 訊號日 D → BTC D−1 收盤 > EMA50
  btcExt: Record<string, number>;             // D → BTC 離 EMA50（ATR）
  s3: { symbol: string; close: number; hh20: number; atr14: number; stop: number; ret7: number; vol: number }[];
}

// ════════════════════════════════════════════════════════════════════
// 共用：帳戶結算
// ════════════════════════════════════════════════════════════════════
export function stopCheck(k: AcctKey, s: AcctState): string | null {
  const dd = s.peak > 0 ? 1 - s.equity / s.peak : 0;
  if (k === 's3a' && (dd > 0.35 || s.lossStreak >= 7)) return dd > 0.35 ? `回撤 ${(dd * 100).toFixed(0)}% > 35%` : `連續虧損 ${s.lossStreak} 筆`;
  if (k === 's3b' && (dd > 0.40 || s.lossStreak >= 15)) return dd > 0.40 ? `回撤 ${(dd * 100).toFixed(0)}% > 40%` : `連續虧損 ${s.lossStreak} 筆`;
  if (k === 's1') {
    if (dd > 0.60) return `回撤 ${(dd * 100).toFixed(0)}% > 60%`;
    if (s.recent.length >= 50 && s.recent.filter(x => x > 0).length / s.recent.length < 0.45) return '最近 50 筆勝率 < 45%';
  }
  return null;
}

function realize(k: AcctKey, s: AcctState, p: Position, sim: TradeSim): Position {
  const addR = ACCTS[k].addon ? (sim.addR ?? null) : null;
  const addRiskUsdt = addR != null ? p.equityAtEntry * ADDON_F : 0;
  const pnl = sim.netR * p.riskUsdt + (addR != null ? addR * addRiskUsdt : 0);
  s.equity += pnl;
  s.peak = Math.max(s.peak, s.equity);
  s.trades++;
  if (pnl > 0) { s.wins++; s.lossStreak = 0; } else s.lossStreak++;
  s.recent = [...s.recent, pnl].slice(-50);
  s.lastExit[p.symbol] = sim.exitT;
  if (!s.halted) s.halted = stopCheck(k, s);
  return { ...p, status: 'done', exitT: sim.exitT, exitPx: sim.exitPx, exitReason: sim.exitReason, partial: sim.partial,
    grossR: sim.grossR, netR: sim.netR, addR, addRiskUsdt, pnlUsdt: pnl, equityAfter: s.equity };
}

export interface Candidate {
  symbol: string; signalT: number; entryT: number; stop: number; close: number; vol: number;
  breadth: number; btcOk: boolean; ind: Record<string, number>;
  btcExtV?: number; ret7?: number;
  /** S1：該幣 D−1 日線收盤 > EMA50（文件 §4）；S3 不適用 */
  coinUp?: boolean;
}

/**
 * 一個帳戶在一組決策時點上推進：每個時點先把出場時間 ≤ 該時點的持倉結算入帳，再依序處理候選訊號。
 * sims：每個持倉（含本次新開的）用目前全部資料模擬的結果，由 simOf 提供（同一筆只算一次）。
 */
export async function stepAccount(k: AcctKey, s: AcctState, open: Map<string, Position>, decisions: { t: number; cands: Candidate[] }[],
  simOf: (p: Position) => Promise<TradeSim | null>, filters: Map<string, SymbolFilter>,
  fundOf: (symbol: string) => Promise<FundingPoint[]>, hourlyOf: (symbol: string) => Promise<Bar[]>, now: number,
): Promise<{ done: Position[]; logs: SignalLog[] }> {
  const cfg = ACCTS[k];
  const done: Position[] = [];
  const logs: SignalLog[] = [];
  const settle = async (upTo: number) => {
    const ready: { p: Position; sim: TradeSim }[] = [];
    for (const p of Array.from(open.values())) {
      const sim = await simOf(p);
      if (sim && sim.exitReason !== 'open' && Number.isFinite(sim.exitT) && sim.exitT <= upTo) ready.push({ p, sim });
    }
    ready.sort((a, b) => a.sim.exitT - b.sim.exitT);
    for (const { p, sim } of ready) { done.push(realize(k, s, p, sim)); open.delete(p.id); }
  };

  for (const { t, cands } of decisions.sort((a, b) => a.t - b.t)) {
    await settle(t);
    // 同一時點多個訊號：依幣池成交額排名由高到低（文件 §2.6）
    for (const c of cands.slice().sort((a, b) => b.vol - a.vol)) {
      const log: SignalLog = { acct: k, symbol: c.symbol, signalT: c.signalT, decision: 'skip', close: c.close, stop: c.stop,
        btcOk: c.btcOk, breadth: c.breadth, ind: c.ind, at: now };
      logs.push(log);
      const skip = (reason: string) => { log.reason = reason; };
      if (s.halted) { skip(`帳戶已停用：${s.halted}`); continue; }
      if (!c.btcOk) { skip('BTC 條件不成立'); continue; }
      if (!(c.breadth < BREADTH_MAX)) { skip(`市場過熱（廣度 ${c.breadth.toFixed(3)}）`); continue; }
      const fund = await fundOf(c.symbol);
      const fr = fundingAt(fund, c.entryT);
      log.funding = fr;
      if (!(fr < FUNDING_MAX)) { skip(`資金費擁擠（${fr}）`); continue; }
      if (c.coinUp === false) { skip('該幣 D−1 日線收盤 ≤ EMA50'); continue; }
      if (Array.from(open.values()).some(p => p.symbol === c.symbol)) { skip('持倉中'); continue; }
      if ((s.lastExit[c.symbol] ?? -Infinity) >= c.signalT) { skip('上一筆在訊號 K 線期間才出場'); continue; }
      const hourly = await hourlyOf(c.symbol);
      const hi = idxOf(hourly, c.entryT);
      if (hi < 0) { skip('缺進場那根 1H'); continue; }
      const E = hourly[hi].o;
      const dist = (E - c.stop) / E;
      log.entry = E; log.dist = dist;
      if (!(dist > MIN_RISK_FRAC)) { skip('止損距離 ≤ 0.2%'); continue; }
      if (cfg.kind === 'S3') {
        const parts = [dist <= S3_TH.risk ? 1 : 0, (c.btcExtV ?? NaN) >= S3_TH.btc ? 1 : 0, (c.ret7 ?? NaN) >= S3_TH.ret7 ? -1 : 0];
        const score = s3Score(dist, c.btcExtV ?? NaN, c.ret7 ?? NaN);
        log.score = score; log.scoreParts = parts;
        if (score !== 2) { skip(`分數 ${score}`); continue; }
      }
      const heat = Array.from(open.values()).reduce((a, p) => a + p.f, 0);
      if (open.size >= cfg.cap) { skip(`持倉上限 ${cfg.cap} 筆`); continue; }
      if (heat + cfg.f > cfg.heat + 1e-9) { skip(`風險加總上限 ${(cfg.heat * 100).toFixed(0)}%`); continue; }
      // 數量（文件 §2.6）
      const flt = filters.get(c.symbol) ?? { stepSize: 0, minQty: 0, minNotional: 0 };
      const riskBudget = s.equity * cfg.f;
      let qty = floorStep(riskBudget / (E - c.stop), flt.stepSize);
      let minQtyUsed = false;
      if (qty < flt.minQty || qty * E < flt.minNotional) {
        const qMin = Math.max(flt.minQty, ceilStep(flt.minNotional / E, flt.stepSize));
        if (qMin * (E - c.stop) <= MIN_QTY_RISK_MULT * riskBudget) { qty = qMin; minQtyUsed = true; }
        else { skip(`低於最小下單量（最小量風險 ${(qMin * (E - c.stop)).toFixed(2)} > 1.5×${riskBudget.toFixed(2)} USDT）`); continue; }
      }
      const p: Position = {
        id: `${c.symbol}:${c.signalT}`, acct: k, symbol: c.symbol, kind: cfg.kind, signalT: c.signalT, entryT: c.entryT,
        stop: c.stop, entry: E, f: cfg.f, equityAtEntry: s.equity, qty, riskUsdt: qty * (E - c.stop), minQtyUsed,
        vol: c.vol, score: log.score, dist, btcExt: c.btcExtV, ret7: c.ret7, breadth: c.breadth, funding: fr, status: 'open',
      };
      open.set(p.id, p);
      log.decision = 'open';
    }
  }
  await settle(now);
  return { done, logs };
}

// ════════════════════════════════════════════════════════════════════
// prep：全市場日線 → 當天的快照
// ════════════════════════════════════════════════════════════════════
async function trimmed(deps: Deps, store: Store, symbol: string, bars: Bar[], tf: number, requested: number, listingCache: Record<string, number>, newListing: Record<string, string>): Promise<Bar[]> {
  if (bars.length >= requested) return bars; // 資料不是從上市開始，不用處理
  let lh = listingCache[symbol];
  if (lh == null) { lh = await deps.listingHour(symbol); newListing[symbol] = String(lh); listingCache[symbol] = lh; }
  return trimPartialFirstBar(bars, lh, tf);
}

/** 決策日 X 的快照（只用 X 之前已收盤的日線） */
export function buildSnapshot(X: number, raw: Map<string, Bar[]>, feats: Map<string, DailyFeat>, btc: DailyFeat): PrepSnapshot {
  const D = X - DAY;
  const uniD = universeOn(raw, D, 100), uniX = universeOn(raw, X, 100);
  const inUni = new Set([...uniD, ...uniX].map(u => u.symbol));
  const upOn = (day: number) => Array.from(inUni).filter(s => { const f = feats.get(s); const i = f ? idxOf(f.bars, day) : -1; return i >= 0 && f!.bars[i].c > f!.ema50[i]; });
  const s3: PrepSnapshot['s3'] = [];
  for (const u of uniD.slice(0, 20)) {
    const f = feats.get(u.symbol);
    const sig = f ? s3SignalAt(u.symbol, f, D) : null;
    if (sig) s3.push({ symbol: u.symbol, close: sig.close, hh20: sig.hh20, atr14: sig.atr14, stop: sig.stop, ret7: sig.ret7, vol: u.vol });
  }
  return {
    X, breadth: breadthAt(feats, X),
    uni: { [String(D)]: uniD, [String(X)]: uniX },
    up: { [String(D)]: upOn(D), [String(D - DAY)]: upOn(D - DAY) },
    btcOk: { [String(D)]: btcOk(btc, D), [String(X)]: btcOk(btc, X) },
    btcExt: { [String(D)]: btcExt(btc, D) },
    s3,
  };
}

export async function runPrep(store: Store, deps: Deps, now: number): Promise<{ X: number; days: number; symbols: number; s3: number; errors: number }> {
  const X = Math.floor(now / DAY) * DAY;
  const filters = await deps.exchange();
  const listingCache = Object.fromEntries(Object.entries((await store.hgetall('s3s1:listing')) ?? {}).map(([k, v]) => [k, Number(v)]));
  const newListing: Record<string, string> = {};
  const raw = new Map<string, Bar[]>();
  let errors = 0;
  const syms = Array.from(filters.keys()).filter(s => !isExcludedSymbol(s));
  await inChunks(syms, 8, async s => {
    try {
      const b = await deps.klines(s, '1d', 499);
      raw.set(s, await trimmed(deps, store, s, b, DAY, 499, listingCache, newListing));
    } catch { errors++; }
  });
  if (Object.keys(newListing).length) await store.hset('s3s1:listing', newListing);
  const feats = new Map<string, DailyFeat>();
  for (const [s, b] of Array.from(raw.entries())) feats.set(s, dailyFeatures(b));
  const btc = feats.get('BTCUSDT');
  if (!btc) throw new Error('抓不到 BTCUSDT 日線');

  // 今天＋前 7 天裡還沒有快照的（漏跑時補；同一份日線就算得出來）
  const days: number[] = [];
  for (let d = X - 7 * DAY; d <= X; d += DAY) if (d === X || !(await store.get(`s3s1:prep:${d}`))) days.push(d);
  let s3count = 0;
  for (const Xd of days) {
    const snap = buildSnapshot(Xd, raw, feats, btc);
    s3count += snap.s3.length;
    await store.set(`s3s1:prep:${Xd}`, JSON.stringify(snap), { ex: 14 * 86_400 });
  }
  await store.hset('s3s1:meta', { 'prep.lastDay': String(X) });
  return { X, days: days.length, symbols: raw.size, s3: s3count, errors };
}

// ════════════════════════════════════════════════════════════════════
// 帳戶狀態讀寫
// ════════════════════════════════════════════════════════════════════
async function loadAcct(store: Store, k: AcctKey) {
  const meta = (await store.hgetall('s3s1:meta')) ?? {};
  const state = meta[`acct.${k}`] ? parse<AcctState>(meta[`acct.${k}`]) : newState(k);
  const open = new Map(Object.entries((await store.hgetall(`s3s1:${k}:open`)) ?? {}).map(([id, v]) => [id, parse<Position>(v)]));
  return { meta, state, open };
}
async function saveAcct(store: Store, k: AcctKey, state: AcctState, before: Set<string>, open: Map<string, Position>, done: Position[], logs: SignalLog[]) {
  if (done.length) await store.hset(`s3s1:${k}:done`, Object.fromEntries(done.map(p => [p.id, JSON.stringify(p)])));
  const gone = Array.from(before).filter(id => !open.has(id));
  if (gone.length) await store.hdel(`s3s1:${k}:open`, ...gone);
  if (open.size) await store.hset(`s3s1:${k}:open`, Object.fromEntries(Array.from(open.values()).map(p => [p.id, JSON.stringify(p)])));
  if (logs.length) { await store.lpush('s3s1:signals', ...logs.map(l => JSON.stringify(l))); await store.ltrim('s3s1:signals', 0, 4999); }
  await store.hset('s3s1:meta', { [`acct.${k}`]: JSON.stringify(state) });
}

/** 從 entryT 抓到現在的 1H（多頁） */
async function hourlyFrom(deps: Deps, symbol: string, from: number, now: number): Promise<Bar[]> {
  const out: Bar[] = [];
  for (let t = from; t < now; ) {
    const page = await deps.klines(symbol, '1h', 1000, t);
    if (!page.length) break;
    out.push(...page);
    t = page[page.length - 1].t + H;
    if (page.length < 1000) break;
  }
  return out;
}

function memo<T>(fn: (s: string) => Promise<T>): (s: string) => Promise<T> {
  const m = new Map<string, Promise<T>>();
  return s => { if (!m.has(s)) m.set(s, fn(s)); return m.get(s)!; };
}

// ════════════════════════════════════════════════════════════════════
// s3：S3-A、S3-B
// ════════════════════════════════════════════════════════════════════
export async function runS3(store: Store, deps: Deps, now: number): Promise<Record<string, unknown>> {
  const X = Math.floor(now / DAY) * DAY;
  const meta = (await store.hgetall('s3s1:meta')) ?? {};
  const last = Number(meta['s3.lastDay']);
  if (!Number.isFinite(last)) {
    await store.hset('s3s1:meta', { 's3.lastDay': String(X), 'trackStart.s3': String(now) });
    return { initialized: true };
  }
  // 要處理的決策日：上次之後到今天（需要 X 00:00 那根 1H 已收盤），最多補 7 天
  const days: number[] = [];
  for (let d = Math.max(last + DAY, X - 7 * DAY); d <= X && d + H <= now; d += DAY) days.push(d);
  const snaps = new Map<number, PrepSnapshot>();
  for (const d of days) { const v = await store.get(`s3s1:prep:${d}`); if (v) snaps.set(d, parse<PrepSnapshot>(v)); }

  const filters = await deps.exchange();
  const firstEntry = Math.min(X, ...days);
  const dailyOf = memo(async s => dailyFeatures(await deps.klines(s, '1d', 499)));
  const fundOf = memo(async s => deps.funding(s, firstEntry - 2 * DAY));
  const hourlyOf = memo(async s => hourlyFrom(deps, s, firstEntry, now)); // 只用來取進場那根的開盤價
  const out: Record<string, unknown> = {};
  for (const k of ['s3a', 's3b'] as const) {
    const { state, open } = await loadAcct(store, k);
    const before = new Set(open.keys());
    const sims = new Map<string, TradeSim | null>();
    const simOf = async (p: Position) => {
      if (!sims.has(p.id)) {
        const hourly = await hourlyFrom(deps, p.symbol, p.entryT, now);
        sims.set(p.id, simulateTrade({ kind: 'S3', entryT: p.entryT, stop: p.stop, hourly, daily: await dailyOf(p.symbol),
          fund: await deps.funding(p.symbol, p.entryT - DAY), withAddon: ACCTS[k].addon }));
      }
      return sims.get(p.id)!;
    };
    const decisions = days.map(d => {
      const sn = snaps.get(d);
      const D = d - DAY;
      const cands: Candidate[] = (sn?.s3 ?? []).map(c => ({
        symbol: c.symbol, signalT: D, entryT: d, stop: c.stop, close: c.close, vol: c.vol,
        breadth: sn!.breadth, btcOk: !!sn!.btcOk[String(D)], btcExtV: sn!.btcExt[String(D)], ret7: c.ret7,
        ind: { hh20: c.hh20, atr14: c.atr14, ret7: c.ret7, btcExt: sn!.btcExt[String(D)] },
      }));
      return { t: d, cands };
    });
    const r = await stepAccount(k, state, open, decisions, simOf, filters, fundOf, hourlyOf, now);
    await saveAcct(store, k, state, before, open, r.done, r.logs);
    out[k] = { opened: r.logs.filter(l => l.decision === 'open').length, signals: r.logs.length, closed: r.done.length, equity: state.equity, open: open.size };
  }
  await store.hset('s3s1:meta', { 's3.lastDay': String(days.length ? days[days.length - 1] : last), 's3.lastRunDay': String(X) });
  return { days: days.length, missingPrep: days.filter(d => !snaps.has(d)).length, ...out };
}

// ════════════════════════════════════════════════════════════════════
// s1：12H Keltner
// ════════════════════════════════════════════════════════════════════
export async function runS1(store: Store, deps: Deps, now: number): Promise<Record<string, unknown>> {
  const meta = (await store.hgetall('s3s1:meta')) ?? {};
  const last = Number(meta['s1.lastT']); // 最後處理的決策時點（12H 收盤）
  const latest = Math.floor((now - H) / H12) * H12; // 需要決策時點那根 1H 已收盤
  if (!Number.isFinite(last)) {
    await store.hset('s3s1:meta', { 's1.lastT': String(latest), 'trackStart.s1': String(now) });
    return { initialized: true };
  }
  const times: number[] = [];
  for (let t = Math.max(last + H12, latest - 14 * H12); t <= latest; t += H12) times.push(t);
  if (!times.length) return { times: 0 };

  const snapOf = memo(async (x: string) => { const v = await store.get(`s3s1:prep:${x}`); return v ? parse<PrepSnapshot>(v) : null; });
  const filters = await deps.exchange();
  const firstT = times[0];
  const h12Of = memo(async s => h12Features(await deps.klines(s, '12h', 499)));
  const fundOf = memo(async s => deps.funding(s, firstT - 2 * DAY));
  const hourlyOf = memo(async s => hourlyFrom(deps, s, firstT, now)); // 只用來取進場那根的開盤價

  // 每個決策時點的候選：訊號 K（開盤 B = t − 12H）所在的日 D 的幣池前 100
  const decisions: { t: number; cands: Candidate[] }[] = [];
  let missing = 0;
  for (const t of times) {
    const B = t - H12, D = Math.floor(B / DAY) * DAY;
    // D 的幣池存在「決策日為 D 或 D+1」的快照裡；廣度 = t 時最新一根已收盤日線的
    const sn = (await snapOf(String(D))) ?? (await snapOf(String(D + DAY)));
    const snT = await snapOf(String(Math.floor(t / DAY) * DAY));
    if (!sn || !snT) { missing++; decisions.push({ t, cands: [] }); continue; }
    const uni = sn.uni[String(D)] ?? [];
    const upPrev = new Set(sn.up[String(D - DAY)] ?? snT.up[String(D - DAY)] ?? []);
    const okBtc = sn.btcOk[String(D)] ?? snT.btcOk[String(D)] ?? false;
    const cands: Candidate[] = [];
    await inChunks(uni, 8, async u => {
      try {
        const f = await h12Of(u.symbol);
        const sig = s1SignalAt(u.symbol, f, B);
        if (!sig) return;
        const i = idxOf(f.bars, B);
        const c: Candidate = { symbol: u.symbol, signalT: B, entryT: t, stop: sig.stop, close: sig.close, vol: u.vol,
          breadth: snT.breadth, btcOk: okBtc,
          ind: { ema20: sig.ema20, atr10: sig.atr10, upper: sig.upper, prevClose: f.bars[i - 1].c, prevUpper: f.upper[i - 1] } };
        c.coinUp = upPrev.has(u.symbol);
        cands.push(c);
      } catch { /* 單一幣失敗不影響其他 */ }
    });
    decisions.push({ t, cands });
  }

  const { state, open } = await loadAcct(store, 's1');
  const before = new Set(open.keys());
  const sims = new Map<string, TradeSim | null>();
  const simOf = async (p: Position) => {
    if (!sims.has(p.id)) {
      const hourly = await hourlyFrom(deps, p.symbol, p.entryT, now);
      sims.set(p.id, simulateTrade({ kind: 'S1', entryT: p.entryT, stop: p.stop, hourly, h12: await h12Of(p.symbol),
        fund: await deps.funding(p.symbol, p.entryT - DAY) }));
    }
    return sims.get(p.id)!;
  };
  const r = await stepAccount('s1', state, open, decisions, simOf, filters, fundOf, hourlyOf, now);
  await saveAcct(store, 's1', state, before, open, r.done, r.logs);
  await store.hset('s3s1:meta', { 's1.lastT': String(times[times.length - 1]), 's1.lastRunT': String(now) });
  return { times: times.length, missingPrep: missing, opened: r.logs.filter(l => l.decision === 'open').length, signals: r.logs.length, closed: r.done.length, equity: state.equity, open: open.size };
}

// ════════════════════════════════════════════════════════════════════
// 排程
// ════════════════════════════════════════════════════════════════════
export type S3S1Job = 'prep' | 's3' | 's1';
/** 依時間與 meta 決定這次掃描該跑哪個工作（一次只跑一個，分散負擔）；都不用跑回 null */
export function dueS3S1Job(meta: Record<string, unknown>, now: number): S3S1Job | null {
  const X = Math.floor(now / DAY) * DAY;
  const since = now - X;
  if (since >= 5 * 60_000 && Number(meta['prep.lastDay'] ?? 0) < X) return 'prep';
  if (since >= H + 5 * 60_000 && Number(meta['prep.lastDay'] ?? 0) >= X && Number(meta['s3.lastRunDay'] ?? 0) < X) return 's3';
  const latest = Math.floor((now - H - 5 * 60_000) / H12) * H12;
  if (Number(meta['prep.lastDay'] ?? 0) >= Math.floor(latest / DAY) * DAY && Number(meta['s1.lastT'] ?? 0) < latest) return 's1';
  return null;
}
