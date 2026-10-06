// S3-A 在幣安 testnet 真的下單（docs/strategy-deploy-2026-10-06.md §3、§3.1、§2.6、§8）。
// 由 scripts/live-runner.ts 每輪（15 秒）呼叫 runS3aLive；跟舊策略的管理完全分開
// （舊策略的單在 Supabase trades 表，這裡的單只在 Redis s3a-live:*）。
//
// 訊號一律用正式站行情（文件 §2.1）：共用 src/lib/s3s1 的規則與 prep 快照（幣池、BTC 條件、
// 市場廣度、S3 候選）。下單在 testnet，進場價 E 用 testnet 實際成交均價。
//
// 每天 UTC 00:00:30 之後的第一輪：
//   1. prep 快照不在就自己算（runPrep，與 Vercel 那邊同一支程式、寫同一個 key）
//   2. 先更新既有持倉的移動止損（LL10，只上移；保本後不低於 E）
//   3. 再處理新訊號：資金費、分數（E 用 testnet 現價估）、上限、同幣、最小下單量 → 市價買進
//      → 立刻掛 STOP_MARKET（全部數量）＋ TAKE_PROFIT_MARKET（1/3，E＋1R）
// 每一輪：
//   - 部位歸零 → 撤剩下的條件單、從成交紀錄算 R、記錄、推播
//   - 1/3 止盈成交 → 止損改到 max(目前止損, E)、數量改成剩餘部位
//   - 止損單不見了 → 價格已穿過就市價平倉，否則補掛；連續 3 輪補不上就平倉
import type { Bar, FundingPoint } from '../lib/s3s1/rules';
import { DAY, H, FUNDING_MAX, BREADTH_MAX, MIN_RISK_FRAC, S3_TH, dailyFeatures, fundingAt, idxOf, s3Score } from '../lib/s3s1/rules';
import type { PrepSnapshot } from '../lib/s3s1/engine';

export const S3A = { F: 0.04, HEAT: 0.20, CAP: 10, MIN_QTY_RISK_MULT: 1.5, MAX_LEV: 10,
  /** 只在 UTC 00:00 後這段時間內開新倉：回測的 E 是當天開盤價，晚好幾小時才進場就不是同一筆交易了 */
  ENTRY_WINDOW_MS: 2 * 3_600_000 } as const;

// ════════════════════════════════════════════════════════════════════
// 純函數（有單元測試）
// ════════════════════════════════════════════════════════════════════
export interface LivePos {
  symbol: string;
  signalDay: number;      // D
  entryDay: number;       // D+1（進場那根日線的開盤）
  entryAt: number;        // 實際成交時間
  entry: number;          // E（testnet 成交均價）
  stop0: number;          // 初始止損
  stop: number;           // 目前止損
  qty0: number;
  tpQty: number;
  partial: boolean;
  stopAlgoId: number | null;
  tpAlgoId: number | null;
  trailDay: number;       // 最後一次套用移動止損的決策日
  stopFailures: number;
  score: number; dist: number; btcExt: number; ret7: number; breadth: number; funding: number;
  /** 下單當下的參考價（testnet 最新成交價）；滑價 = entry − refPx（文件 §7.3） */
  refPx?: number;
  /** 止盈成交、每次止損移動、補單等事件（文件 §7.2） */
  events?: { t: number; kind: string; px?: number; qty?: number; note?: string }[];
}

/** testnet 上每個 S3 候選的決策紀錄（含被擋掉的，文件 §7.1） */
export interface LiveSignal {
  symbol: string; signalDay: number; decision: 'open' | 'skip'; reason?: string; at: number;
  close: number; hh20: number; atr14: number; stop: number; ret7: number;
  btcOk: boolean; btcExt: number; breadth: number; funding?: number;
  refPx?: number; dist?: number; score?: number; scoreParts?: number[];
}

/** 移動止損：決策日 X，用 D = X−1 的 LL10（只在 D ≥ 進場那根日線時）；只上移；保本後不低於 E */
export function trailedStop(p: Pick<LivePos, 'stop' | 'entry' | 'partial' | 'entryDay'>, ll10D: number | null, D: number): number {
  let s = p.stop;
  if (ll10D != null && Number.isFinite(ll10D) && D >= p.entryDay) s = Math.max(s, ll10D);
  if (p.partial) s = Math.max(s, p.entry);
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

export type PosCheck =
  | { kind: 'closed' }
  | { kind: 'partial_filled'; remaining: number; newStop: number }
  | { kind: 'stop_missing'; priceThrough: boolean }
  | { kind: 'tp_missing'; priceThrough: boolean }
  | { kind: 'ok' };

/** 每輪檢查一個持倉：qtyNow = 交易所部位數量；algoIds = 目前還掛著的條件單 id；price = 最新成交價 */
export function checkPosition(p: LivePos, qtyNow: number, algoIds: Set<number>, price: number): PosCheck {
  if (qtyNow <= 0) return { kind: 'closed' };
  // 部位變小不等於止盈成交（手動平倉、ADL…，CLAUDE.md）：止盈單還掛著就不算
  const tpGone = p.tpAlgoId == null || !algoIds.has(p.tpAlgoId);
  if (!p.partial && p.tpQty > 0 && tpGone && qtyNow <= p.qty0 - p.tpQty * 0.9) {
    return { kind: 'partial_filled', remaining: qtyNow, newStop: Math.max(p.stop, p.entry) };
  }
  if (p.stopAlgoId == null || !algoIds.has(p.stopAlgoId)) return { kind: 'stop_missing', priceThrough: price <= p.stop };
  // 止盈單不見了但部位沒變小 = 被交易所拒絕或失效（CLAUDE.md「條件單觸發不等於成交」）
  if (!p.partial && p.tpAlgoId != null && !algoIds.has(p.tpAlgoId)) return { kind: 'tp_missing', priceThrough: price >= p.entry + (p.entry - p.stop0) };
  return { kind: 'ok' };
}

// ════════════════════════════════════════════════════════════════════
// 執行
// ════════════════════════════════════════════════════════════════════
export interface S3aClient {
  getBalance(): Promise<Array<{ asset: string; balance: string; availableBalance: string }>>;
  getPositionRisk(symbol?: string): Promise<Array<{ symbol: string; positionAmt: string; entryPrice: string }>>;
  getOpenOrders(symbol?: string): Promise<Array<{ symbol: string; orderId: number }>>;
  getOpenAlgoOrders(symbol?: string): Promise<Array<{ algoId: number; symbol: string; orderType: string }>>;
  getUserTrades(symbol: string, params?: { startTime?: number; limit?: number }): Promise<Array<{ side: string; price: string; qty: string; realizedPnl: string; commission: string; time: number }>>;
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

async function place(ctx: S3aCtx, p: Parameters<S3aClient['placeOrder']>[0]): Promise<number | null> {
  if (ctx.dryRun) { ctx.log(`   [DRY] ${p.type} ${p.side} ${p.symbol} qty=${p.quantity ?? '-'} trigger=${p.stopPrice ?? '-'}`); return -1; }
  const r = await ctx.client.placeOrder(p);
  return r.orderId;
}
async function cancelAlgo(ctx: S3aCtx, symbol: string, id: number | null) {
  if (id == null || id < 0) return;
  if (ctx.dryRun) { ctx.log(`   [DRY] 撤條件單 ${symbol} ${id}`); return; }
  try { await ctx.client.cancelOrder(symbol, id, true); } catch { /* 已觸發或已撤掉 */ }
}

async function placeStop(ctx: S3aCtx, p: LivePos, qty: number, stop: number): Promise<number | null> {
  const tick = ctx.filters.get(p.symbol)?.tickSize ?? 0;
  return place(ctx, { symbol: p.symbol, side: 'SELL', type: 'STOP_MARKET', quantity: qty, stopPrice: roundTick(stop, tick), reduceOnly: true,
    newClientOrderId: `s3a-sl-${p.symbol}-${Math.floor(ctx.now / 1000)}`.slice(0, 36) });
}

/** 平掉剩餘部位（reduceOnly 市價） */
async function closeAll(ctx: S3aCtx, p: LivePos, qty: number, why: string) {
  ctx.log(`   ⚠ ${p.symbol} 市價平倉 ${qty}（${why}）`);
  await place(ctx, { symbol: p.symbol, side: 'SELL', type: 'MARKET', quantity: qty, reduceOnly: true, newClientOrderId: `s3a-x-${p.symbol}-${Math.floor(ctx.now / 1000)}`.slice(0, 36) });
}

/** 已平倉：從成交紀錄與資金費流水算結果 */
async function finalize(ctx: S3aCtx, p: LivePos) {
  let pnl = 0, fee = 0, sellQty = 0, sellVal = 0, lastT = p.entryAt;
  try {
    const fills = await ctx.client.getUserTrades(p.symbol, { startTime: p.entryAt - 60_000, limit: 1000 });
    for (const f of fills) {
      pnl += +f.realizedPnl; fee += +f.commission;
      if (f.side === 'SELL') { sellQty += +f.qty; sellVal += +f.qty * +f.price; lastT = Math.max(lastT, f.time); }
    }
  } catch (e) { ctx.log(`   ${p.symbol} 讀成交紀錄失敗：${String(e).slice(0, 100)}`); }
  let funding = 0;
  try {
    const inc = await ctx.client.getIncome({ symbol: p.symbol, incomeType: 'FUNDING_FEE', startTime: p.entryAt, limit: 1000 });
    funding = inc.reduce((a, x) => a + +x.income, 0);
  } catch { /* 拿不到就當 0，紀錄裡標出 */ }
  const risk0 = p.qty0 * (p.entry - p.stop0);
  const net = pnl - fee + funding;
  const R = risk0 > 0 ? net / risk0 : NaN;
  const rec = { ...p, status: 'done', exitAt: lastT, exitAvg: sellQty ? sellVal / sellQty : null, realizedPnl: pnl, fee, fundingFee: funding, netPnl: net, R };
  await ctx.store.hset('s3a-live:done', { [`${p.symbol}:${p.entryDay}`]: JSON.stringify(rec) });
  await ctx.store.hdel('s3a-live:pos', p.symbol);
  const meta = (await ctx.store.hgetall('s3a-live:meta')) ?? {};
  const realized = Number(meta.realized ?? 0) + net;
  const peakR = Math.max(Number(meta.peakRealized ?? 0), realized);
  const base = Number(meta.baseEquity ?? 0);
  const streak = net > 0 ? 0 : Number(meta.lossStreak ?? 0) + 1;
  const dd = base > 0 ? (peakR - realized) / (base + peakR) : 0;
  const halted = meta.halted ? String(meta.halted) : dd > 0.35 ? `回撤 ${(dd * 100).toFixed(0)}% > 35%` : streak >= 7 ? `連續虧損 ${streak} 筆` : '';
  await ctx.store.hset('s3a-live:meta', { realized: String(realized), peakRealized: String(peakR), lossStreak: String(streak), ...(halted ? { halted } : {}), [`lastExit:${p.symbol}`]: String(lastT) });
  ctx.log(`   ✅ ${p.symbol} 平倉：淨損益 ${net.toFixed(2)} USDT（${Number.isFinite(R) ? R.toFixed(2) : '?'}R）`);
  await ctx.notify(`S3-A 出場 ${p.symbol.replace(/USDT$/, '')}`, `淨損益 ${net >= 0 ? '+' : ''}${net.toFixed(2)} USDT（${Number.isFinite(R) ? `${R >= 0 ? '+' : ''}${R.toFixed(2)}R` : '—'}）${halted ? `｜⛔ 停用：${halted}` : ''}`);
}

export async function runS3aLive(ctx: S3aCtx): Promise<void> {
  const { client, store, now } = ctx;
  const X = Math.floor(now / DAY) * DAY;
  const posMap = new Map(Object.entries((await store.hgetall('s3a-live:pos')) ?? {}).map(([k, v]) => [k, parse<LivePos>(v)]));
  const meta = (await store.hgetall('s3a-live:meta')) ?? {};
  const daily = now - X >= 30_000 && Number(meta.lastDay ?? 0) < X;
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
      if (c.kind === 'closed') {
        for (const a of algos.filter(a => a.symbol === p.symbol)) await cancelAlgo(ctx, p.symbol, a.algoId);
        if (!ctx.dryRun) await finalize(ctx, p);
        posMap.delete(p.symbol);
        continue;
      }
      if (c.kind === 'partial_filled') {
        const id = await placeStop(ctx, p, c.remaining, c.newStop);
        await cancelAlgo(ctx, p.symbol, p.stopAlgoId);
        Object.assign(p, { partial: true, stop: c.newStop, stopAlgoId: id, tpAlgoId: null, stopFailures: 0 });
        ev(p, 'tp1', { qty: p.qty0 - c.remaining }); ev(p, 'stop', { px: c.newStop, note: '止盈 1/3 後移到保本' });
        ctx.log(`   🎯 ${p.symbol} 1/3 止盈成交，止損移到 ${fmt(c.newStop)}（剩 ${c.remaining}）`);
        await ctx.notify(`S3-A 止盈 1/3 ${p.symbol.replace(/USDT$/, '')}`, `剩餘 ${c.remaining}，止損移到保本 ${fmt(c.newStop)}`);
      } else if (c.kind === 'tp_missing') {
        const flt = ctx.filters.get(p.symbol);
        if (c.priceThrough) {
          // 已經越過 +1R：直接市價平掉 1/3，等同止盈成交，下一輪會走 partial_filled 把止損移到保本
          ctx.log(`   🎯 ${p.symbol} 止盈單不見了且價格已過 +1R，市價平 1/3`);
          ev(p, 'tp_market', { qty: p.tpQty, px: price, note: '止盈單不見、價格已過 +1R' });
          await place(ctx, { symbol: p.symbol, side: 'SELL', type: 'MARKET', quantity: p.tpQty, reduceOnly: true, newClientOrderId: `s3a-tpm-${p.symbol}-${Math.floor(ctx.now / 1000)}`.slice(0, 36) });
        } else {
          p.tpAlgoId = await place(ctx, { symbol: p.symbol, side: 'SELL', type: 'TAKE_PROFIT_MARKET', quantity: p.tpQty,
            stopPrice: roundTick(p.entry + (p.entry - p.stop0), flt?.tickSize ?? 0), reduceOnly: true, newClientOrderId: `s3a-tp-${p.symbol}-${Math.floor(ctx.now / 1000)}`.slice(0, 36) });
          ctx.log(`   🎯 ${p.symbol} 補掛 1/3 止盈單`); ev(p, 'tp_replace');
        }
      } else if (c.kind === 'stop_missing') {
        if (c.priceThrough || p.stopFailures >= 3) {
          const why = c.priceThrough ? '止損單不見了且價格已穿過止損' : '止損單連續 3 輪補不上';
          ev(p, 'close_market', { qty: qtyNow, px: price, note: why });
          await closeAll(ctx, p, qtyNow, why);
        } else {
          try {
            p.stopAlgoId = await placeStop(ctx, p, qtyNow, p.stop);
            p.stopFailures = 0;
            ctx.log(`   🛡 ${p.symbol} 補掛止損 ${fmt(p.stop)}`); ev(p, 'stop_replace', { px: p.stop });
          } catch (e) {
            p.stopFailures++;
            ctx.log(`   ❌ ${p.symbol} 補掛止損失敗（第 ${p.stopFailures} 次）：${String(e).slice(0, 120)}`);
            await ctx.notify(`S3-A ⚠ ${p.symbol.replace(/USDT$/, '')} 沒有止損單`, `補掛失敗第 ${p.stopFailures} 次，第 3 次會直接市價平倉`);
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
  if (!snapRaw) { ctx.log('   S3-A：今天的 prep 快照還沒好，下一輪再試'); return; }
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
        const qty = qtyOf.get(p.symbol) ?? 0;
        const id = await placeStop(ctx, p, qty, ns);     // 先掛新的
        await cancelAlgo(ctx, p.symbol, p.stopAlgoId);   // 再撤舊的——任何時刻都有止損
        ctx.log(`   ↗ ${p.symbol} 移動止損 ${fmt(p.stop)} → ${fmt(ns)}`);
        ev(p, 'stop', { px: ns, note: `LL10 移動（原 ${fmt(p.stop)}）` });
        Object.assign(p, { stop: ns, stopAlgoId: id });
      }
      if (!ctx.dryRun) await store.hset('s3a-live:pos', { [p.symbol]: JSON.stringify(p) });
    } catch (e) { ctx.log(`   ❌ ${p.symbol} 移動止損失敗（下一輪再試）：${String(e).slice(0, 150)}`); }
  }

  // 2. 新訊號
  const done = async () => { if (!ctx.dryRun) await store.hset('s3a-live:meta', { lastDay: String(X) }); };
  // 整天不開新倉時，當天的候選也要記下來（文件 §7.1：被擋掉的訊號一定要記錄）
  const skipAll = async (reason: string) => {
    if (snap.s3.length && !ctx.dryRun) {
      await store.lpush('s3a-live:signals', ...snap.s3.map(c => JSON.stringify({ symbol: c.symbol, signalDay: D, decision: 'skip', reason, at: now,
        close: c.close, hh20: c.hh20, atr14: c.atr14, stop: c.stop, ret7: c.ret7, btcOk: !!snap.btcOk[String(D)], btcExt: snap.btcExt[String(D)], breadth: snap.breadth } satisfies LiveSignal)));
      await store.ltrim('s3a-live:signals', 0, 1999);
    }
    return done();
  };
  if (now - X > S3A.ENTRY_WINDOW_MS) { ctx.log(`   S3-A：已超過進場時間窗（UTC 00:00 後 ${S3A.ENTRY_WINDOW_MS / 3_600_000} 小時），今天不開新倉`); return skipAll('超過進場時間窗'); }
  if (ctx.killSwitch) { ctx.log('   S3-A：kill switch 啟動中，不開新倉'); return skipAll('kill switch'); }
  if (meta.halted) { ctx.log(`   S3-A：已停用（${meta.halted}），不開新倉`); return skipAll(`帳戶已停用：${meta.halted}`); }
  if (!snap.btcOk[String(D)]) { ctx.log('   S3-A：BTC 條件不成立，今天不開新倉'); return skipAll('BTC 條件不成立'); }
  if (!(snap.breadth < BREADTH_MAX)) { ctx.log(`   S3-A：市場過熱（廣度 ${snap.breadth.toFixed(3)}），今天不開新倉`); return skipAll(`市場過熱（廣度 ${snap.breadth.toFixed(3)}）`); }
  const bal = (await client.getBalance()).find(b => b.asset === 'USDT');
  const equity = bal ? +bal.balance : 0;
  if (!meta.baseEquity && !ctx.dryRun) await store.hset('s3a-live:meta', { baseEquity: String(equity) });
  const openOrders = await client.getOpenOrders();
  const sigs: LiveSignal[] = [];
  for (const c of snap.s3.slice().sort((a, b) => b.vol - a.vol)) {
    const tag = `   S3-A ${c.symbol}`;
    const sig: LiveSignal = { symbol: c.symbol, signalDay: D, decision: 'skip', at: now, close: c.close, hh20: c.hh20, atr14: c.atr14, stop: c.stop,
      ret7: c.ret7, btcOk: true, btcExt: snap.btcExt[String(D)], breadth: snap.breadth };
    sigs.push(sig);
    const skipLog = ctx.log;
    const log = (m: string) => { skipLog(m); sig.reason = m.replace(tag + '：', '').replace(/，略過$|，不做$/, ''); };
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
      if (posMap.size >= S3A.CAP || (posMap.size + 1) * S3A.F > S3A.HEAT + 1e-9) { log(`${tag}：已達持倉／風險上限，略過`); continue; }
      const flt = ctx.filters.get(c.symbol);
      if (!flt) { log(`${tag}：testnet 沒有這個合約，略過`); continue; }
      const sz = sizePosition(equity, S3A.F, px, c.stop, { stepSize: flt.stepSize, minQty: flt.minQty ?? flt.stepSize, minNotional: flt.minNotional });
      if ('skip' in sz) { log(`${tag}：${sz.skip}`); continue; }
      const lev = leverageFor(px, c.stop);
      if (!ctx.dryRun) {
        try { await client.setMarginType(c.symbol, 'ISOLATED'); } catch { /* 已經是逐倉 */ }
        await client.setLeverage(c.symbol, lev);
      }
      log(`${tag}：市價買進 ${sz.qty}（槓桿 ${lev}x、止損 ${fmt(c.stop)}、分數 2）`);
      await place(ctx, { symbol: c.symbol, side: 'BUY', type: 'MARKET', quantity: sz.qty, newClientOrderId: `s3a-in-${c.symbol}-${X / 1000}`.slice(0, 36) });
      let E = px, qty0 = sz.qty;
      if (!ctx.dryRun) {
        const pr = (await client.getPositionRisk(c.symbol)).find(r => r.symbol === c.symbol);
        if (!pr || +pr.positionAmt <= 0) { log(`${tag}：市價單送出但沒有持倉，略過`); continue; }
        E = +pr.entryPrice; qty0 = +pr.positionAmt;
      }
      const p: LivePos = {
        symbol: c.symbol, signalDay: D, entryDay: X, entryAt: Date.now(), entry: E, stop0: c.stop, stop: c.stop, qty0,
        tpQty: floorTo(qty0 / 3, flt.stepSize), partial: false, stopAlgoId: null, tpAlgoId: null, trailDay: X, stopFailures: 0,
        score, dist: (E - c.stop) / E, btcExt: be, ret7: c.ret7, breadth: snap.breadth, funding: fr, refPx: px, events: [],
      };
      ev(p, 'entry', { px: E, qty: qty0, note: `參考價 ${fmt(px)}，滑價 ${((E / px - 1) * 1e4).toFixed(1)} bp` });
      sig.decision = 'open'; sig.reason = undefined;
      // 成交後先存檔再掛單：掛止損失敗時，下一輪的管理迴圈會看到「止損單不見了」並補掛／平倉，不會變成沒人管的孤兒
      posMap.set(c.symbol, p);
      const save = async () => { if (!ctx.dryRun) await store.hset('s3a-live:pos', { [c.symbol]: JSON.stringify(p) }); };
      await save();
      if (E <= c.stop) { ev(p, 'close_market', { qty: qty0, note: '成交價已在止損之下' }); await closeAll(ctx, p, qty0, '成交價已在止損之下'); await save(); continue; }
      try { p.stopAlgoId = await placeStop(ctx, p, qty0, c.stop); }
      catch (e) { ctx.log(`${tag}：掛止損失敗，下一輪補掛：${String(e).slice(0, 150)}`); }
      if (p.tpQty > 0 && p.tpQty * E >= flt.minNotional) {
        try {
          p.tpAlgoId = await place(ctx, { symbol: c.symbol, side: 'SELL', type: 'TAKE_PROFIT_MARKET', quantity: p.tpQty,
            stopPrice: roundTick(E + (E - c.stop), flt.tickSize), reduceOnly: true, newClientOrderId: `s3a-tp-${c.symbol}-${X / 1000}`.slice(0, 36) });
        } catch (e) { ctx.log(`${tag}：掛止盈失敗，下一輪補掛：${String(e).slice(0, 150)}`); p.tpAlgoId = -2; }
      } else ctx.log(`${tag}：1/3 數量低於最小下單量，不掛分批止盈`);
      await save();
      await ctx.notify(`S3-A 進場 ${c.symbol.replace(/USDT$/, '')}`, `買進 ${qty0} @ ${fmt(E)}｜止損 ${fmt(c.stop)}｜+1R 平 1/3 @ ${fmt(E + (E - c.stop))}`);
    } catch (e) {
      log(`${tag}：下單失敗：${String(e).slice(0, 200)}`);
      await ctx.notify(`S3-A ⚠ ${c.symbol.replace(/USDT$/, '')} 下單失敗`, String(e).slice(0, 120));
    }
  }
  if (sigs.length && !ctx.dryRun) { await store.lpush('s3a-live:signals', ...sigs.map(x => JSON.stringify(x))); await store.ltrim('s3a-live:signals', 0, 1999); }
  await done();
  void H;
}
