#!/usr/bin/env npx tsx
/**
 * 結構性資訊候選——不是再換一組技術指標，而是換資訊來源。
 *
 *   npx tsx scripts/structural-candidates.ts
 *
 * 起因（docs/ANALYSIS-2026-09-27-修改還是換策略.md）：11 種方向型技術策略扣成本後
 * 都沒有穩定優勢；純做多的獲利集中在 2023–24 牛市（吃 beta）。這裡測三個不靠
 * 價格型態、有公開文獻或明確機制的候選：
 *
 *   F1 資金費率極端值反向  —— 擁擠的一邊付錢給另一邊，極端時常反轉
 *   F3 資金費率橫向排序    —— 多低費率、空高費率，多空對沖（不吃大盤）
 *   L1 爆倉式急跌後接多    —— 連環清算常過度下殺（用 1H 急跌＋爆量代替清算資料）
 *
 * 未平倉量（OI）不在內：幣安 API 的 OI 歷史只有最近 30 天，清算紀錄也沒有公開歷史。
 *
 * ── 錄取標準（跑之前寫死，不看結果改）──
 *   F1／L1（逐筆 R）：全期 CI 下界 > 0、前後段都為正、≥60% 幣種為正、月加總 t ≥ 2
 *   F3（每日組合報酬）：全期 CI 下界 > 0、前後段都為正、≥55% 月份為正、月加總 t ≥ 2
 *   參數一律用事先寫好的整數值，不在這批資料上調。
 *
 * ── 成本 ──
 *   進出都用 Taker 0.05% + 滑價（進 0.03%／止損 0.05%）；持倉期間的真實資金費率。
 *   F3 依實際換倉比例計成本。
 */
import type { Candle } from '../src/types';
import { fetchKlines, fetchFunding, fundingBetween, type Funding } from './lib/binanceData';
import { mean, sd, f, summarize, row, tStat, maxDrawdownR, bootstrapCI } from './lib/rstats';

const UNIVERSE = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'BNBUSDT', 'LTCUSDT',
  'LINKUSDT', 'AVAXUSDT', 'DOTUSDT', 'BCHUSDT', 'TRXUSDT', 'ETCUSDT', 'ATOMUSDT',
  'FILUSDT', 'NEARUSDT', 'ALGOUSDT', 'XLMUSDT', 'UNIUSDT', 'AAVEUSDT', 'SANDUSDT', 'MANAUSDT',
  'AXSUSDT', 'THETAUSDT', 'VETUSDT', 'XTZUSDT', 'ZECUSDT', 'EGLDUSDT'];
// 第三批幣（--universe-c）：2022–23 才上市、前兩輪都沒用過。F1 在第一批 29 檔上
// 只差「月 t ≥ 2」一條，而且逐年都贏過無條件做多——這裡用完全沒看過的幣重驗，
// 規則與標準都不改（雙向、預設參數）。資料從各幣上市起算，所以不套 1500 根的門檻。
const UNIVERSE_C = ['OPUSDT', 'ARBUSDT', 'APTUSDT', 'SUIUSDT', 'INJUSDT', 'LDOUSDT', 'APEUSDT', 'GMTUSDT',
  'GALAUSDT', 'CRVUSDT', 'DYDXUSDT', 'IMXUSDT', 'BLURUSDT', '1000PEPEUSDT', 'WLDUSDT', 'SEIUSDT',
  'TIAUSDT', 'STXUSDT', 'RUNEUSDT', 'CFXUSDT', 'FETUSDT', 'ORDIUSDT', 'JUPUSDT', '1000SHIBUSDT', 'ENSUSDT'];
const UNIVERSE_C_MODE = process.argv.includes('--universe-c');
const FETCH_FROM = Date.UTC(2021, 3, 1);
const START = Date.UTC(2022, 0, 1);
const SPLIT = Date.UTC(2024, 6, 1);
const H = 3_600_000, H4 = 4 * H, D = 24 * H;
const TAKER = 0.0005, ENTRY_SLIP = 0.0003, STOP_SLIP = 0.0005;

interface Trade { symbol: string; entryT: number; exitT: number; dir: 1 | -1; grossR: number; netR: number }

function atr(c: Candle[], n = 20): number[] {
  const out = new Array(c.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < c.length; i++) {
    const tr = i === 0 ? c[i].high - c[i].low
      : Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    s += tr;
    if (i >= n) {
      const j = i - n;
      s -= j === 0 ? c[0].high - c[0].low
        : Math.max(c[j].high - c[j].low, Math.abs(c[j].high - c[j - 1].close), Math.abs(c[j].low - c[j - 1].close));
    }
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

/**
 * 通用持倉模擬：entryIdx 那根開盤進場，止損 stopDist，最多持有 holdBars 根
 * （最後一根收盤出場）。進場那根就碰到止損 → 判止損（悲觀）。
 */
function holdTrade(symbol: string, c: Candle[], entryIdx: number, dir: 1 | -1, stopDist: number, holdBars: number, fund: Funding[]): { t: Trade; exitIdx: number } | null {
  if (entryIdx >= c.length || !(stopDist > 0)) return null;
  const entry = c[entryIdx].open * (1 + dir * ENTRY_SLIP);
  const stop = entry - dir * stopDist;
  let exitIdx = -1, exitPx = 0;
  const last = Math.min(entryIdx + holdBars - 1, c.length - 1);
  if (last < entryIdx + holdBars - 1) return null; // 資料尾端走不完
  for (let k = entryIdx; k <= last; k++) {
    const b = c[k];
    if (k > entryIdx && (dir === 1 ? b.open <= stop : b.open >= stop)) { exitIdx = k; exitPx = b.open * (1 - dir * STOP_SLIP); break; }
    if (dir === 1 ? b.low <= stop : b.high >= stop) { exitIdx = k; exitPx = stop * (1 - dir * STOP_SLIP); break; }
  }
  if (exitIdx < 0) { exitIdx = last; exitPx = c[last].close * (1 - dir * ENTRY_SLIP); }
  const risk = Math.abs(entry - stop);
  const riskPct = risk / entry;
  const grossR = dir * (exitPx - entry) / risk;
  const fr = fundingBetween(fund, c[entryIdx].openTime, c[exitIdx].closeTime);
  const netR = grossR - (2 * TAKER) / riskPct - dir * fr / riskPct;
  return { t: { symbol, entryT: c[entryIdx].openTime, exitT: c[exitIdx].closeTime, dir, grossR, netR }, exitIdx };
}

// ── F1：資金費率極端值反向 ──────────────────────────────────────
interface F1Opt { lag: number; pHi: number; pLo: number; hold: number }
const F1_DEFAULT: F1Opt = { lag: 0, pHi: 0.95, pLo: 0.05, hold: 18 };
function f1(symbol: string, c4: Candle[], fund: Funding[], o: F1Opt = F1_DEFAULT): Trade[] {
  const idx = new Map(c4.map((c, i) => [c.openTime, i]));
  const a = atr(c4);
  const out: Trade[] = [];
  let busyUntil = -1;
  for (let k = 90; k < fund.length; k++) {
    const t = fund[k].t, fr = fund[k].rate;
    if (t < START) continue;
    const win = fund.slice(k - 90, k).map(x => x.rate).sort((x, y) => x - y);
    const p95 = win[Math.min(win.length - 1, Math.floor(win.length * o.pHi))], p05 = win[Math.floor(win.length * o.pLo)];
    let dir: 1 | -1 | 0 = 0;
    if (fr >= Math.max(p95, 0.0005)) dir = -1;      // 做多太擁擠 → 反向做空
    else if (fr <= Math.min(p05, -0.0002)) dir = 1; // 做空太擁擠 → 反向做多
    if (!dir) continue;
    // 結算時間對齊 4H 邊界（00/08/16 UTC）；結算當下之後的第一根 4H 開盤進場
    const bar = Math.ceil(t / H4) * H4 + o.lag * H4;
    const i = idx.get(bar);
    if (i == null || i <= busyUntil || i < 21) continue;
    const r = holdTrade(symbol, c4, i, dir, 3 * a[i - 1], o.hold, fund);
    if (!r) continue;
    out.push(r.t); busyUntil = r.exitIdx;
  }
  return out;
}

// ── L1：爆倉式急跌後接多 ────────────────────────────────────────
function l1(symbol: string, c1: Candle[], fund: Funding[]): Trade[] {
  const a = atr(c1);
  const out: Trade[] = [];
  let busyUntil = -1;
  for (let i = 21; i < c1.length - 1; i++) {
    if (c1[i].openTime < START || i <= busyUntil) continue;
    const drop = c1[i - 1].close - c1[i].close;
    const avgVol = mean(c1.slice(i - 20, i).map(x => x.volume));
    if (!(drop >= 3 * a[i - 1] && c1[i].volume >= 3 * avgVol)) continue;
    const r = holdTrade(symbol, c1, i + 1, 1, 2 * a[i], 24, fund);
    if (!r) continue;
    out.push(r.t); busyUntil = r.exitIdx;
  }
  return out;
}

// ── F3：資金費率橫向排序（多空對沖）────────────────────────────
interface DayRet { t: number; ret: number }
function f3(daily: Map<string, Candle[]>, funds: Map<string, Funding[]>, K = 5): DayRet[] {
  const dayIdx = new Map<string, Map<number, Candle>>();
  for (const [s, c] of Array.from(daily.entries())) dayIdx.set(s, new Map(c.map(x => [x.openTime, x] as [number, Candle])));
  const out: DayRet[] = [];
  let prevL = new Set<string>(), prevS = new Set<string>();
  for (let t = START; t < Date.now() - D; t += D) {
    // 排序依據：T 之前最後三次結算的平均（T 當下看得到的資訊）
    const ranks: { s: string; fr: number }[] = [];
    for (const [s, fu] of Array.from(funds.entries())) {
      const bar = dayIdx.get(s)?.get(t);
      if (!bar) continue;
      const past = fu.filter(x => x.t <= t && x.t > t - D);
      if (past.length < 2) continue;
      ranks.push({ s, fr: mean(past.map(x => x.rate)) });
    }
    if (ranks.length < 2 * K + 4) continue;
    ranks.sort((x, y) => x.fr - y.fr);
    const L = new Set(ranks.slice(0, K).map(x => x.s)), S = new Set(ranks.slice(-K).map(x => x.s));
    const legRet = (set: Set<string>, dir: 1 | -1) => mean(Array.from(set).map(s => {
      const b = dayIdx.get(s)!.get(t)!;
      const px = dir * (b.close - b.open) / b.open;
      const fr = fundingBetween(funds.get(s)!, t, t + D - 1);
      return px - dir * fr;
    }));
    // 換倉成本：每一檔進出場各付一次 Taker＋滑價，權重 1/K
    const churn = (now: Set<string>, prev: Set<string>) =>
      (Array.from(now).filter(s => !prev.has(s)).length + Array.from(prev).filter(s => !now.has(s)).length) / K;
    const cost = (churn(L, prevL) + churn(S, prevS)) * (TAKER + ENTRY_SLIP);
    // 資本 1：多頭 0.5、空頭 0.5（總曝險 1，多空各半）
    out.push({ t, ret: 0.5 * legRet(L, 1) + 0.5 * legRet(S, -1) - 0.5 * cost });
    prevL = L; prevS = S;
  }
  return out;
}

function monthly<T>(xs: T[], time: (x: T) => number, val: (x: T) => number): number[] {
  const m = new Map<string, number>();
  for (let t = START; t < Date.now(); t += 28 * D) m.set(new Date(t).toISOString().slice(0, 7), 0);
  for (const x of xs) { const k = new Date(time(x)).toISOString().slice(0, 7); m.set(k, (m.get(k) ?? 0) + val(x)); }
  return Array.from(m.values());
}

function reportTrades(name: string, trades: Trade[], nSym: number): { pass: boolean; why: string[] } {
  trades.sort((a, b) => a.exitT - b.exitT);
  const net = trades.map(t => t.netR);
  const early = trades.filter(t => t.entryT < SPLIT).map(t => t.netR);
  const late = trades.filter(t => t.entryT >= SPLIT).map(t => t.netR);
  const bySym = new Map<string, number>();
  for (const t of trades) bySym.set(t.symbol, (bySym.get(t.symbol) ?? 0) + t.netR);
  const symPos = Array.from(bySym.values()).filter(v => v > 0).length;
  const months = monthly(trades, t => t.exitT, t => t.netR);
  const tM = tStat(months);
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 76 - name.length))}`);
  console.log(row('毛 R', trades.map(t => t.grossR)));
  console.log(row('淨 R 全期', net));
  console.log(row('前段', early));
  console.log(row('後段 (OOS)', late));
  if (trades.some(t => t.dir === 1)) console.log(row('做多', trades.filter(t => t.dir === 1).map(t => t.netR)));
  if (trades.some(t => t.dir === -1)) console.log(row('做空', trades.filter(t => t.dir === -1).map(t => t.netR)));
  for (const y of [2022, 2023, 2024, 2025, 2026]) {
    const ys = trades.filter(t => new Date(t.entryT).getUTCFullYear() === y).map(t => t.netR);
    if (ys.length) console.log(row(`  ${y} 年`, ys));
  }
  console.log(`  幣種 ${symPos}/${nSym} 為正（有交易的 ${bySym.size} 檔）  月加總 t=${f(tM, 2)}  最大回撤 ${maxDrawdownR(net).toFixed(1)}R`);
  const s = summarize(net);
  const why: string[] = [];
  if (!(s.mean > 0 && s.ci[0] > 0)) why.push(`CI 下界 ${f(s.ci[0])}`);
  if (!(mean(early) > 0 && mean(late) > 0)) why.push(`前/後段 ${f(mean(early))}/${f(mean(late))}`);
  if (!(symPos / nSym >= 0.6)) why.push(`幣種 ${symPos}/${nSym}`);
  if (!(tM >= 2)) why.push(`月 t=${f(tM, 2)}`);
  return { pass: why.length === 0, why };
}

async function main(): Promise<void> {
  const end = Math.floor(Date.now() / D) * D;
  console.log('═'.repeat(92));
  console.log(`  結構性資訊候選  |  2022-01 → 今天  |  ${UNIVERSE.length} 檔  |  後段(樣本外) = 2024-07 起`);
  console.log('═'.repeat(92));

  if (UNIVERSE_C_MODE) {
    const all: Trade[] = [];
    const ctrlC: Trade[] = []; // 對照組：無條件做多（同第一批的做法）
    let n = 0;
    for (const s of UNIVERSE_C) {
      process.stdout.write(`  抓取 ${s.padEnd(14)} `);
      try {
        const c = await fetchKlines(s, '4h', FETCH_FROM, end);
        const fund = await fetchFunding(s, FETCH_FROM, end);
        if (c.length < 500 || fund.length < 200) { console.log('資料不足，排除'); continue; }
        const tr = f1(s, c, fund);
        all.push(...tr); n++;
        const a = atr(c);
        for (let i = 21; i < c.length; i += 18) {
          if (c[i].openTime < START) continue;
          const r = holdTrade(s, c, i, 1, 3 * a[i - 1], 18, fund);
          if (r) ctrlC.push(r.t);
        }
        console.log(`4h ${c.length}（自 ${new Date(c[0].openTime).toISOString().slice(0, 10)}）→ ${tr.length} 筆`);
      } catch (e) { console.log(`跳過：${String(e).slice(0, 50)}`); }
    }
    const v = reportTrades('F1 資金費率極端值反向［第三批幣，沒看過］', all, n);
    const fl = all.filter(t => t.dir === 1);
    console.log('\n  對照組（無條件做多）：');
    console.log(row('無條件做多', ctrlC.map(t => t.netR)));
    console.log(row('F1 做多', fl.map(t => t.netR)));
    for (const y of [2022, 2023, 2024, 2025, 2026]) {
      const cy = ctrlC.filter(t => new Date(t.entryT).getUTCFullYear() === y).map(t => t.netR);
      const fy = fl.filter(t => new Date(t.entryT).getUTCFullYear() === y).map(t => t.netR);
      if (cy.length && fy.length) console.log(`    ${y}  無條件做多 ${f(mean(cy))}R  vs  F1 做多 ${f(mean(fy))}R  差 ${f(mean(fy) - mean(cy))}R`);
    }
    console.log(`\n  判定：${v.pass ? '✅ 錄取' : '❌ 不錄取'}  ${v.why.join('；')}`);
    return;
  }

  const c1 = new Map<string, Candle[]>(), c4 = new Map<string, Candle[]>(), c1d = new Map<string, Candle[]>(), fu = new Map<string, Funding[]>();
  for (const s of UNIVERSE) {
    process.stdout.write(`  抓取 ${s.padEnd(10)} `);
    const d = await fetchKlines(s, '1d', FETCH_FROM, end);
    if (d.length < 1500) { console.log('資料不足，排除'); continue; }
    c1d.set(s, d);
    c4.set(s, await fetchKlines(s, '4h', FETCH_FROM, end));
    c1.set(s, await fetchKlines(s, '1h', Date.UTC(2021, 11, 1), end));
    fu.set(s, await fetchFunding(s, FETCH_FROM, end));
    console.log(`1h ${c1.get(s)!.length}  4h ${c4.get(s)!.length}  funding ${fu.get(s)!.length}`);
  }
  const syms = Array.from(c1d.keys());
  const verdicts: { name: string; pass: boolean; why: string[] }[] = [];

  const t1 = syms.flatMap(s => f1(s, c4.get(s)!, fu.get(s)!));
  verdicts.push({ name: 'F1 資金費率極端值反向', ...reportTrades('F1 資金費率極端值反向（4H，持有 72h，止損 3×ATR）', t1, syms.length) });

  // 穩健性（只看脆不脆弱，不拿來挑參數；判定只看上面的預設版本）
  console.log('\n  F1 穩健性：');
  const variants: [string, F1Opt][] = [
    ['進場晚 4 小時', { ...F1_DEFAULT, lag: 1 }],
    ['門檻放寬到 90/10 百分位', { ...F1_DEFAULT, pHi: 0.9, pLo: 0.1 }],
    ['門檻收緊到 99/1 百分位', { ...F1_DEFAULT, pHi: 0.99, pLo: 0.01 }],
    ['持有縮短到 36h', { ...F1_DEFAULT, hold: 9 }],
    ['持有延長到 144h', { ...F1_DEFAULT, hold: 36 }],
  ];
  for (const [lab, o] of variants) {
    const v = syms.flatMap(s => f1(s, c4.get(s)!, fu.get(s)!, o));
    console.log(row(lab, v.map(t => t.netR)) + `  月t=${f(tStat(monthly(v, t => t.exitT, t => t.netR)), 2)}`);
  }

  // 對照組：同樣規則（持有 72h、止損 3×ATR）但「每 72 小時無條件做多一次」。
  // F1 的單 87% 是做多——如果對照組也一樣好，F1 只是在吃大盤漲勢，不是費率資訊。
  const ctrl: Trade[] = [];
  for (const s of syms) {
    const c = c4.get(s)!, a = atr(c), fund = fu.get(s)!;
    for (let i = 21; i < c.length; i += 18) {
      if (c[i].openTime < START) continue;
      const r = holdTrade(s, c, i, 1, 3 * a[i - 1], 18, fund);
      if (r) ctrl.push(r.t);
    }
  }
  const f1Long = t1.filter(t => t.dir === 1);
  console.log('\n  F1 對照組（無條件做多，同樣持有與止損）：');
  console.log(row('無條件做多', ctrl.map(t => t.netR)) + `  月t=${f(tStat(monthly(ctrl, t => t.exitT, t => t.netR)), 2)}`);
  console.log(row('F1 做多（費率極負）', f1Long.map(t => t.netR)));
  for (const y of [2022, 2023, 2024, 2025, 2026]) {
    const cy = ctrl.filter(t => new Date(t.entryT).getUTCFullYear() === y).map(t => t.netR);
    const fy = f1Long.filter(t => new Date(t.entryT).getUTCFullYear() === y).map(t => t.netR);
    console.log(`    ${y}  無條件做多 ${f(mean(cy))}R  vs  F1 做多 ${f(mean(fy))}R  差 ${f(mean(fy) - mean(cy))}R`);
  }

  const tl = syms.flatMap(s => l1(s, c1.get(s)!, fu.get(s)!));
  verdicts.push({ name: 'L1 爆倉式急跌後接多', ...reportTrades('L1 爆倉式急跌後接多（1H，持有 24h，止損 2×ATR）', tl, syms.length) });

  // F3
  const days = f3(c1d, fu);
  const rets = days.map(d => d.ret);
  const early = days.filter(d => d.t < SPLIT).map(d => d.ret), late = days.filter(d => d.t >= SPLIT).map(d => d.ret);
  const months = monthly(days, d => d.t, d => d.ret);
  const ci = bootstrapCI(rets);
  const tM = tStat(months);
  const ann = (xs: number[]) => mean(xs) * 365 * 100;
  let eq = 1, peak = 1, dd = 0;
  for (const r of rets) { eq *= 1 + r; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); }
  console.log(`\n── F3 資金費率橫向排序（每日多最低 5 檔／空最高 5 檔，多空各半）${'─'.repeat(20)}`);
  console.log(`  全期   ${days.length} 天  年化 ${f(ann(rets), 1)}%  年化波動 ${(sd(rets) * Math.sqrt(365) * 100).toFixed(1)}%  Sharpe ${(mean(rets) / sd(rets) * Math.sqrt(365)).toFixed(2)}  日報酬 95%CI [${(ci[0] * 100).toFixed(3)}%, ${(ci[1] * 100).toFixed(3)}%]`);
  console.log(`  前段 年化 ${f(ann(early), 1)}%   後段(OOS) 年化 ${f(ann(late), 1)}%`);
  for (const y of [2022, 2023, 2024, 2025, 2026]) {
    const ys = days.filter(d => new Date(d.t).getUTCFullYear() === y).map(d => d.ret);
    if (ys.length) console.log(`    ${y} 年  年化 ${f(ann(ys), 1)}%  (${ys.length} 天)`);
  }
  console.log(`  月份 ${months.filter(v => v > 0).length}/${months.length} 為正  月加總 t=${f(tM, 2)}  最大回撤 ${(dd * 100).toFixed(1)}%  累積 ${f((eq - 1) * 100, 1)}%`);
  const why3: string[] = [];
  if (!(mean(rets) > 0 && ci[0] > 0)) why3.push(`CI 下界 ${(ci[0] * 100).toFixed(3)}%`);
  if (!(mean(early) > 0 && mean(late) > 0)) why3.push(`前/後段 ${f(ann(early), 1)}%/${f(ann(late), 1)}%`);
  if (!(months.filter(v => v > 0).length / months.length >= 0.55)) why3.push(`正月份 ${months.filter(v => v > 0).length}/${months.length}`);
  if (!(tM >= 2)) why3.push(`月 t=${f(tM, 2)}`);
  verdicts.push({ name: 'F3 資金費率橫向排序', pass: why3.length === 0, why: why3 });

  console.log('\n' + '═'.repeat(92));
  console.log('  判定（四條錄取標準全過才算）');
  for (const v of verdicts) console.log(`  ${v.pass ? '✅ 錄取' : '❌ 不錄取'}  ${v.name.padEnd(22)} ${v.why.join('；')}`);
  console.log('═'.repeat(92));
}

main().catch(e => { console.error('structural-candidates error:', e); process.exit(1); });
