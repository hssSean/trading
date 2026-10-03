// 紙上策略的每日執行器——四套策略（strategyA、videoA、videoB、videoC）分開記錄，**不下任何單**。
//
// 兩個工作，每天各跑一次（route.ts 在 UTC 00:20 之後的掃描裡依序觸發）：
//   strategyA：處理剛收盤日線的 Keltner 訊號；推進所有未結束的單（1H 判止損／1R、日線判 EMA20 出場）。
//   video    ：用近 ~20 天的 1H／4H／1D 產生 A/B/C 訂單，只收「生效時間 > 上次處理時間」的新訂單；
//              新舊未結束的訂單一起依序重新執行（executeSequence），結束的就凍結。
//
// 訂單一產生就凍結參數（價格／止損／止盈），之後不會因為重算指標的視窗不同而改變。
// 第一次執行只記起點，不回補歷史（回補就變回測了）。
//
// Redis（每個 key 每次最多一讀一寫）：
//   paper:<strat>:open   hash id → 未結束紀錄（route 讀寫，永遠很小）
//   paper:<strat>:done   hash id → 已結束（只寫；報表讀）
//   paper:meta           hash：<job>.lastT、<job>.lastRunDay、busy:<strat>:<symbol>（上一筆出場時間）
//   paper:univ           hash day → 當日幣池（稽核用）
import { btcRegime, keltnerSignals, simulateKeltner, vol30Before, type Bar, type FundingPoint, type KeltnerSignal } from './keltner';
import { buildFrames, stratA, stratB, stratC, executeSequence, type VideoOrder, type ExecResult } from './video';

const H = 3_600_000, D = 24 * H;

export type PaperStrat = 'strategyA' | 'videoA' | 'videoB' | 'videoC';
export type PaperJob = 'strategyA' | 'video';

export interface PaperStore {
  hgetall(key: string): Promise<Record<string, unknown> | null>;
  hset(key: string, kv: Record<string, string>): Promise<unknown>;
  hdel(key: string, ...fields: string[]): Promise<unknown>;
}

export interface PaperDeps {
  /** USDT 本位、PERPETUAL、TRADING 的合約與 24h 成交額 */
  tickers(): Promise<{ symbol: string; quoteVolume: number }[]>;
  /** 已收盤 K 線（依時間排序），日線需帶 qv */
  klines(symbol: string, interval: '1h' | '4h' | '1d', limit: number, startTime?: number): Promise<Bar[]>;
  funding(symbol: string, startTime: number): Promise<FundingPoint[]>;
}

// 規格 §4：非加密貨幣與穩定幣
const EXCLUDE = new Set(('AAPL AMZN AVGO BABA COIN CRCL EWJ EWY GOOGL HOOD INTC META MSFT MSTR MU NVDA PLTR QQQ SPY TSLA '
  + 'TSM SNDK XAU XAG XAUT XPD XPT PAXG CL BZ NATGAS COPPER USDC USDE FDUSD BTCDOM DEFI').split(' '));
export const isExcluded = (symbol: string) => EXCLUDE.has(symbol.replace(/USDT$/, ''));

const parse = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
async function inChunks<T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < xs.length; i += n) out.push(...await Promise.all(xs.slice(i, i + n).map(fn)));
  return out;
}

/** 某一天的幣池：近 30 根已收盤日線（不含當天）平均成交額前 N；需 ≥ 30 天歷史 */
export function universeFor(dayT: number, daily: Map<string, Bar[]>, topN: number): { symbol: string; vol30: number }[] {
  const rows: { symbol: string; vol30: number }[] = [];
  for (const [symbol, bars] of Array.from(daily.entries())) {
    const age = bars.filter(b => b.t < dayT).length;
    if (age < 30) continue;
    const v = vol30Before(bars, dayT);
    if (v != null) rows.push({ symbol, vol30: v });
  }
  return rows.sort((a, b) => b.vol30 - a.vol30).slice(0, topN);
}

// ════════════════════════════════════════════════════════════════════
// 紀錄格式
// ════════════════════════════════════════════════════════════════════
export interface StrategyARecord {
  id: string; strat: 'strategyA'; symbol: string;
  signalT: number; entryT: number; stop: number; vol30: number;
  status: 'pending' | 'open' | 'done' | 'skip';
  entry?: number; risk?: number; partial?: boolean;
  exitT?: number; exitPx?: number; exitReason?: string; grossR?: number; netR?: number; note?: string;
  updatedAt: number;
}

export interface VideoRecord extends VideoOrder {
  id: string;
  status: ExecResult['status'];
  reason?: string;
  fillT?: number; entry?: number; exitT?: number; exitPx?: number; exitKind?: string; grossR?: number; netR?: number;
  updatedAt: number;
}

const FINAL = new Set(['done', 'skip', 'nofill', 'busy']);

export interface JobSummary { job: PaperJob; initialized?: boolean; newRecords: number; finished: number; open: number; errors: number; notes: string[] }

// ════════════════════════════════════════════════════════════════════
// strategyA
// ════════════════════════════════════════════════════════════════════
export async function runStrategyA(store: PaperStore, deps: PaperDeps, now: number): Promise<JobSummary> {
  const sum: JobSummary = { job: 'strategyA', newRecords: 0, finished: 0, open: 0, errors: 0, notes: [] };
  const dayT = Math.floor(now / D) * D;
  const meta = (await store.hgetall('paper:meta')) ?? {};
  const openMap = new Map(Object.entries((await store.hgetall('paper:strategyA:open')) ?? {}).map(([k, v]) => [k, parse<StrategyARecord>(v)]));
  const lastSignalT = Number(meta['strategyA.lastT']);
  const metaW: Record<string, string> = { 'strategyA.lastRunDay': String(dayT) };
  const openW: Record<string, string> = {}, doneW: Record<string, string> = {}, openDel: string[] = [];

  // 候選：24h 成交額前 160（規格 §4 的預篩）＋ 有未結束紀錄的幣
  const tick = (await deps.tickers()).filter(t => !isExcluded(t.symbol)).sort((a, b) => b.quoteVolume - a.quoteVolume);
  const cands = new Set(tick.slice(0, 160).map(t => t.symbol));
  for (const r of Array.from(openMap.values())) cands.add(r.symbol);
  cands.add('BTCUSDT');
  const daily = new Map<string, Bar[]>();
  await inChunks(Array.from(cands), 8, async s => {
    try { daily.set(s, await deps.klines(s, '1d', 400)); } catch { sum.errors++; }
  });
  const btc = daily.get('BTCUSDT');
  if (!btc?.length) throw new Error('抓不到 BTCUSDT 日線');
  const regime = btcRegime(btc);

  if (!Number.isFinite(lastSignalT)) {
    // 第一次：只記起點（剛收盤那根日線之後的訊號才算）
    metaW['strategyA.lastT'] = String(dayT - D);
    metaW['trackStart.strategyA'] = String(now);
    sum.initialized = true;
  } else {
    // 新訊號：lastSignalT 之後、到剛收盤那根為止（漏跑幾天就補，最多補 7 天）
    const days: number[] = [];
    for (let t = Math.max(lastSignalT + D, dayT - 7 * D); t <= dayT - D; t += D) days.push(t);
    const univSnap: Record<string, string> = {};
    for (const sigDay of days) {
      const uni = universeFor(sigDay, daily, 100);
      univSnap[`A:${sigDay}`] = JSON.stringify(uni.map(u => u.symbol));
      const inUni = new Map(uni.map(u => [u.symbol, u.vol30]));
      for (const [symbol, bars] of Array.from(daily.entries())) {
        if (!inUni.has(symbol)) continue;
        const sig = keltnerSignals(symbol, bars, regime).find(s => s.signalT === sigDay);
        if (!sig) continue;
        // 同一幣同時只能一筆：還有未結束的、或上一筆在訊號那根日線（含）之後才出場 → 不收
        const hasOpen = Array.from(openMap.values()).some(r => r.symbol === symbol) || Object.keys(openW).some(k => k.startsWith(`${symbol}:`));
        const busy = Number(meta[`busy:strategyA:${symbol}`] ?? -Infinity);
        if (hasOpen || busy >= sigDay) continue;
        const rec: StrategyARecord = { id: `${symbol}:${sig.signalT}`, strat: 'strategyA', symbol, signalT: sig.signalT, entryT: sig.entryT,
          stop: sig.stop, vol30: inUni.get(symbol)!, status: 'pending', updatedAt: now };
        openMap.set(rec.id, rec);
        sum.newRecords++;
      }
    }
    if (days.length) {
      metaW['strategyA.lastT'] = String(days[days.length - 1]);
      await store.hset('paper:univ', univSnap);
    }
  }

  // 推進所有未結束的
  await inChunks(Array.from(openMap.values()), 4, async rec => {
    try {
      const bars = daily.get(rec.symbol) ?? await deps.klines(rec.symbol, '1d', 400);
      const hourly: Bar[] = [];
      for (let from = rec.entryT; from < now; ) {
        const page = await deps.klines(rec.symbol, '1h', 1000, from);
        if (!page.length) break;
        hourly.push(...page);
        from = page[page.length - 1].t + H;
        if (page.length < 1000) break;
      }
      const fund = await deps.funding(rec.symbol, rec.entryT - H);
      const sig: KeltnerSignal = { symbol: rec.symbol, signalT: rec.signalT, entryT: rec.entryT, stop: rec.stop };
      const o = simulateKeltner(sig, bars, hourly, fund);
      const next: StrategyARecord = { ...rec, updatedAt: now };
      if (o.status === 'skip') Object.assign(next, { status: 'skip', note: o.reason });
      else if (o.status === 'pending') next.status = 'pending';
      else if (o.status === 'open') Object.assign(next, { status: 'open', entry: o.entry, risk: o.risk, partial: o.partial });
      else Object.assign(next, { status: 'done', entry: o.entry, risk: o.risk, partial: o.partial, exitT: o.exitT, exitPx: o.exitPx,
        exitReason: o.exitReason, grossR: o.grossR, netR: o.netR });
      if (FINAL.has(next.status)) {
        doneW[next.id] = JSON.stringify(next);
        openDel.push(next.id);
        if (next.status === 'done') metaW[`busy:strategyA:${rec.symbol}`] = String(Math.floor(next.exitT! / D) * D);
        sum.finished++;
      } else {
        openW[next.id] = JSON.stringify(next);
        sum.open++;
      }
    } catch (e) { sum.errors++; sum.notes.push(`${rec.symbol}: ${String(e).slice(0, 80)}`); openW[rec.id] = JSON.stringify(rec); }
  });

  if (Object.keys(doneW).length) await store.hset('paper:strategyA:done', doneW);
  const toDel = openDel.filter(id => (openMap.has(id)));
  if (toDel.length) await store.hdel('paper:strategyA:open', ...toDel);
  if (Object.keys(openW).length) await store.hset('paper:strategyA:open', openW);
  await store.hset('paper:meta', metaW);
  return sum;
}

// ════════════════════════════════════════════════════════════════════
// video（A/B/C 共用同一份資料）
// ════════════════════════════════════════════════════════════════════
const VIDEO_STRATS = ['videoA', 'videoB', 'videoC'] as const;
/**
 * 最後一根已收盤 1H 的開盤時間。參考實作的迴圈不在最後一根（n−1）產生訂單，所以這次產生的訂單
 * 生效時間都 ≤ 這個值；下次只收 > 這個值的，就不會漏也不會重複。
 */
const lastClosedHour = (now: number) => Math.floor(now / H) * H - H;
const GEN = { videoA: stratA, videoB: stratB, videoC: stratC };

export async function runVideo(store: PaperStore, deps: PaperDeps, now: number): Promise<JobSummary> {
  const sum: JobSummary = { job: 'video', newRecords: 0, finished: 0, open: 0, errors: 0, notes: [] };
  const dayT = Math.floor(now / D) * D;
  const meta = (await store.hgetall('paper:meta')) ?? {};
  const lastT = Number(meta['video.lastT']);
  const metaW: Record<string, string> = { 'video.lastRunDay': String(dayT) };
  const opens = new Map<string, Map<string, VideoRecord>>();
  for (const s of VIDEO_STRATS) {
    opens.set(s, new Map(Object.entries((await store.hgetall(`paper:${s}:open`)) ?? {}).map(([k, v]) => [k, parse<VideoRecord>(v)])));
  }

  if (!Number.isFinite(lastT)) {
    await store.hset('paper:meta', { ...metaW, 'video.lastT': String(lastClosedHour(now)), 'trackStart.video': String(now) });
    return { ...sum, initialized: true };
  }

  // 幣池：昨天與今天的前 50（新訂單的生效日落在這兩天），加上有未結束訂單的幣
  const tick = (await deps.tickers()).filter(t => !isExcluded(t.symbol)).sort((a, b) => b.quoteVolume - a.quoteVolume);
  const pre = tick.slice(0, 100).map(t => t.symbol);
  const dailyAll = new Map<string, Bar[]>();
  await inChunks(pre, 8, async s => { try { dailyAll.set(s, await deps.klines(s, '1d', 300)); } catch { sum.errors++; } });
  const uniByDay = new Map<number, Set<string>>();
  const univSnap: Record<string, string> = {};
  for (let d = Math.floor(lastT / D) * D; d <= dayT; d += D) {
    const u = universeFor(d, dailyAll, 50).map(x => x.symbol);
    uniByDay.set(d, new Set(u));
    univSnap[`V:${d}`] = JSON.stringify(u);
  }
  const syms = new Set<string>();
  for (const s of Array.from(uniByDay.values())) for (const x of Array.from(s)) syms.add(x);
  for (const m of Array.from(opens.values())) for (const r of Array.from(m.values())) syms.add(r.symbol);

  const W: Record<string, { open: Record<string, string>; done: Record<string, string>; del: string[] }> = {};
  for (const s of VIDEO_STRATS) W[s] = { open: {}, done: {}, del: [] };

  await inChunks(Array.from(syms), 6, async symbol => {
    try {
      const G = await deps.klines(symbol, '1h', 499);
      const F = await deps.klines(symbol, '4h', 499);
      const Dd = dailyAll.get(symbol) ?? await deps.klines(symbol, '1d', 300);
      const fund = await deps.funding(symbol, now - 8 * D);
      if (G.length < 100) return;
      const fr = buildFrames(G, F, Dd);
      for (const strat of VIDEO_STRATS) {
        const existing = Array.from(opens.get(strat)!.values()).filter(r => r.symbol === symbol);
        const fresh = GEN[strat](symbol, fr).filter(o => o.startT > lastT && o.startT <= now
          && uniByDay.get(Math.floor(o.startT / D) * D)?.has(symbol));
        const byId = new Map<string, VideoOrder>();
        for (const r of existing) byId.set(`${r.startT}:${r.side}`, r);
        for (const o of fresh) {
          const id = `${o.startT}:${o.side}`;
          if (!byId.has(id)) { byId.set(id, o); sum.newRecords++; }
        }
        if (!byId.size) continue;
        const ids = Array.from(byId.keys());
        const orders = ids.map(id => byId.get(id)!);
        const busy = Number(meta[`busy:${strat}:${symbol}`] ?? -Infinity);
        const res = executeSequence(orders, G, fund, busy);
        ids.forEach((id, k) => {
          const r = res[k];
          const rec: VideoRecord = { ...orders[k], id: `${symbol}:${id}`, status: r.status, updatedAt: now };
          if (r.status === 'nofill') rec.reason = r.reason;
          if (r.status === 'open') Object.assign(rec, { fillT: r.fillT, entry: r.entry });
          if (r.status === 'done') {
            Object.assign(rec, { fillT: r.fillT, entry: r.entry, exitT: r.exitT, exitPx: r.exitPx, exitKind: r.exitKind, grossR: r.grossR, netR: r.netR });
            const prev = Number(metaW[`busy:${strat}:${symbol}`] ?? meta[`busy:${strat}:${symbol}`] ?? -Infinity);
            if (r.exitT - H > prev) metaW[`busy:${strat}:${symbol}`] = String(r.exitT - H);
          }
          const key = rec.id;
          if (FINAL.has(r.status)) {
            W[strat].done[key] = JSON.stringify(rec);
            if (opens.get(strat)!.has(key)) W[strat].del.push(key);
            sum.finished++;
          } else {
            W[strat].open[key] = JSON.stringify(rec);
            sum.open++;
          }
        });
      }
    } catch (e) { sum.errors++; sum.notes.push(`${symbol}: ${String(e).slice(0, 80)}`); }
  });

  for (const s of VIDEO_STRATS) {
    if (Object.keys(W[s].done).length) await store.hset(`paper:${s}:done`, W[s].done);
    if (W[s].del.length) await store.hdel(`paper:${s}:open`, ...W[s].del);
    if (Object.keys(W[s].open).length) await store.hset(`paper:${s}:open`, W[s].open);
  }
  await store.hset('paper:univ', univSnap);
  await store.hset('paper:meta', { ...metaW, 'video.lastT': String(lastClosedHour(now)) });
  return sum;
}

/** 今天該跑哪個工作（UTC 00:20 之後，策略 A 先、影片後；都跑過就 null） */
export function dueJob(meta: Record<string, unknown>, now: number): PaperJob | null {
  const dayT = Math.floor(now / D) * D;
  if (now < dayT + 20 * 60_000) return null;
  if (Number(meta['strategyA.lastRunDay'] ?? 0) < dayT) return 'strategyA';
  if (Number(meta['video.lastRunDay'] ?? 0) < dayT) return 'video';
  return null;
}
