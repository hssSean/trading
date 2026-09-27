#!/usr/bin/env npx tsx
/**
 * 候選策略比較——「修改現有策略」還是「換策略」，用同一把尺量。
 *
 *   npx tsx scripts/strategy-candidates.ts
 *
 * 起因（docs/ANALYSIS-2026-09-24-策略獲利能力驗證.md）：現有策略扣成本後每筆
 * −0.055R。毛邊際 ~+0.02R，成本 ~0.08R——止損距離中位數 1.78%，一趟進出
 * ~0.14% 的手續費＋滑價就吃掉 8% 的 R。出場參數已經測死五個家族。
 *
 * 所以這裡量的是**結構不同**的候選：更長的時框、更寬的止損（成本占 R 變小）、
 * 讓贏家跑（不設 TP）的趨勢跟隨。參數一律用教科書值（Donchian 20/10、55/20、
 * 2×ATR 止損、EMA200 濾網、30 日動能），**不調參**——在這批資料上調出最佳值
 * 只是在雜訊上擬合，那正是這個專案一再踩到的坑。
 *
 * ── 錄取標準（跑之前寫死，不看結果再改）──
 *   1. 全期淨 R 每筆 > 0，且 bootstrap 95% 下界 > 0
 *   2. 前後兩段都為正（後段 = 2024-07 以後，視為樣本外）
 *   3. ≥ 60% 幣種淨 R 為正
 *   4. 月加總 R 的 t ≥ 2（同一時間多檔幣同向進場，逐筆 t 會因相關性灌水；
 *      以月為單位加總才是組合層級真正的獨立樣本）
 *   同時比 7 個候選有多重比較問題——第 4 條用 t ≥ 2 而不是更寬鬆的門檻就是為此。
 *
 * ── 模擬（一律偏悲觀）──
 *   進場：突破單＝stop-market，觸價成交；跳空越過就用開盤價。Taker 0.05% + 滑價 0.03%。
 *        同一根多空兩邊都觸發 → 分不出先後，不做。
 *   出場：初始止損與通道出場取較緊者，觸價或跳空開盤出場，Taker 0.05% + 滑價 0.05%。
 *        進場那一根若也碰到止損，判止損。
 *   資金費率：持倉期間真實費率。
 *   幣種：固定用 2022 以前就上市的 15 檔（不用「今日成交量前 N」，降低倖存者偏誤）。
 */
import type { Candle } from '../src/types';
import { ema } from '../src/analysis/indicators';
import { fetchKlines, fetchFunding, fundingBetween, type Funding, type KlineInterval } from './lib/binanceData';
import { mean, f, summarize, row, tStat, maxDrawdownR } from './lib/rstats';

const UNIVERSE = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'BNBUSDT', 'LTCUSDT',
  'LINKUSDT', 'AVAXUSDT', 'DOTUSDT', 'BCHUSDT', 'TRXUSDT', 'ETCUSDT', 'ATOMUSDT'];
// 第二階段（--stage2）：第一階段 7 個候選全部不錄取，但「做多全為正、做空全為負」
// 在 8 個策略（含現有策略）上一致出現——這是看了結果才發現的假設，不能用同一批
// 資料確認。所以第二階段只測 3 個純做多版本，而且在**第一階段沒看過的 15 檔幣**上
// 重驗，錄取標準不變。另外列出逐年結果：2022 是空頭年，純做多如果只是在吃
// 整體漲勢，2022 會崩。
const UNIVERSE_B = ['FILUSDT', 'NEARUSDT', 'ALGOUSDT', 'XLMUSDT', 'UNIUSDT', 'AAVEUSDT', 'SANDUSDT', 'MANAUSDT',
  'AXSUSDT', 'ICPUSDT', 'THETAUSDT', 'VETUSDT', 'XTZUSDT', 'ZECUSDT', 'EGLDUSDT'];
const STAGE2 = process.argv.includes('--stage2');
const START = Date.UTC(2022, 0, 1);
const FETCH_FROM = Date.UTC(2021, 3, 1);   // 暖機（EMA200 日線需要 200 天）
const SPLIT = Date.UTC(2024, 6, 1);

const TAKER = 0.0005, ENTRY_SLIP = 0.0003, EXIT_SLIP = 0.0005;

interface Cand {
  name: string;
  interval: KlineInterval;
  kind: 'donchian' | 'tsmom';
  entryN: number;          // donchian：突破根數；tsmom：動能回看根數
  exitN: number;           // donchian：反向通道出場根數
  stopAtr: number;         // 初始止損 = ATR(20) × 倍數
  trend: boolean;          // EMA200 方向濾網
  longOnly?: boolean;
}

const CANDS: Cand[] = [
  { name: '4H 唐奇安 20/10', interval: '4h', kind: 'donchian', entryN: 20, exitN: 10, stopAtr: 2, trend: false },
  { name: '4H 唐奇安 20/10 +EMA200', interval: '4h', kind: 'donchian', entryN: 20, exitN: 10, stopAtr: 2, trend: true },
  { name: '4H 唐奇安 55/20 +EMA200', interval: '4h', kind: 'donchian', entryN: 55, exitN: 20, stopAtr: 2, trend: true },
  { name: '日線 唐奇安 20/10', interval: '1d', kind: 'donchian', entryN: 20, exitN: 10, stopAtr: 2, trend: false },
  { name: '日線 唐奇安 55/20', interval: '1d', kind: 'donchian', entryN: 55, exitN: 20, stopAtr: 2, trend: false },
  { name: '日線 唐奇安 20/10 +EMA200', interval: '1d', kind: 'donchian', entryN: 20, exitN: 10, stopAtr: 2, trend: true },
  { name: '日線 30日動能', interval: '1d', kind: 'tsmom', entryN: 30, exitN: 0, stopAtr: 3, trend: false },
];

const CANDS_STAGE2: Cand[] = [
  { name: '日線 唐奇安 20/10 純做多', interval: '1d', kind: 'donchian', entryN: 20, exitN: 10, stopAtr: 2, trend: false, longOnly: true },
  { name: '日線 唐奇安 20/10 +EMA200 純做多', interval: '1d', kind: 'donchian', entryN: 20, exitN: 10, stopAtr: 2, trend: true, longOnly: true },
  { name: '日線 30日動能 純做多', interval: '1d', kind: 'tsmom', entryN: 30, exitN: 0, stopAtr: 3, trend: false, longOnly: true },
];

interface Trade { symbol: string; entryT: number; exitT: number; dir: 1 | -1; grossR: number; netR: number; riskPct: number; bars: number }

function atrSeries(c: Candle[], n = 20): number[] {
  const out = new Array(c.length).fill(NaN);
  let sum = 0;
  const tr = c.map((x, i) => i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)));
  for (let i = 0; i < c.length; i++) {
    sum += tr[i];
    if (i >= n) sum -= tr[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}
const hh = (c: Candle[], i: number, n: number) => { let m = -Infinity; for (let k = i - n + 1; k <= i; k++) m = Math.max(m, c[k].high); return m; };
const ll = (c: Candle[], i: number, n: number) => { let m = Infinity; for (let k = i - n + 1; k <= i; k++) m = Math.min(m, c[k].low); return m; };

function simulate(cand: Cand, symbol: string, c: Candle[], fund: Funding[]): Trade[] {
  const trades: Trade[] = [];
  const atr = atrSeries(c);
  const e200 = ema(c.map(x => x.close), 200);
  const warm = Math.max(cand.entryN, cand.exitN, 200) + 1;

  let pos: { dir: 1 | -1; entry: number; stop0: number; risk: number; entryIdx: number } | null = null;

  const close = (i: number, rawPx: number, slip: number) => {
    const p = pos!;
    const px = p.dir === 1 ? rawPx * (1 - slip) : rawPx * (1 + slip);
    const grossR = p.dir * (px - p.entry) / p.risk;
    const riskPct = p.risk / p.entry;
    const fr = fundingBetween(fund, c[p.entryIdx].openTime, c[i].closeTime);
    const fundingR = -p.dir * fr / riskPct;
    // entry 與 px 都已含滑價，所以 grossR 已經扣過滑價；這裡再扣進出兩邊的手續費與資金費率
    const netR = grossR - (2 * TAKER) / riskPct + fundingR;
    trades.push({ symbol, entryT: c[p.entryIdx].openTime, exitT: c[i].closeTime, dir: p.dir, grossR, netR, riskPct, bars: i - p.entryIdx + 1 });
    pos = null;
  };

  for (let i = warm; i < c.length - 1; i++) {
    // 以 i 收盤的資訊，決定 i+1 的動作
    const nx = c[i + 1];
    const a = atr[i];
    if (!(a > 0)) continue;

    if (pos) {
      const p = pos;
      if (cand.kind === 'donchian') {
        const chan = p.dir === 1 ? ll(c, i, cand.exitN) : hh(c, i, cand.exitN);
        const stop = p.dir === 1 ? Math.max(p.stop0, chan) : Math.min(p.stop0, chan);
        if (p.dir === 1 ? nx.open <= stop : nx.open >= stop) close(i + 1, nx.open, EXIT_SLIP);
        else if (p.dir === 1 ? nx.low <= stop : nx.high >= stop) close(i + 1, stop, EXIT_SLIP);
      } else {
        const mom = c[i].close - c[i - cand.entryN].close;
        const flip = p.dir === 1 ? mom <= 0 : mom >= 0;
        if (flip) close(i + 1, nx.open, ENTRY_SLIP);
        else if (p.dir === 1 ? nx.low <= p.stop0 : nx.high >= p.stop0)
          close(i + 1, p.dir === 1 ? Math.min(nx.open, p.stop0) : Math.max(nx.open, p.stop0), EXIT_SLIP);
      }
      // 持倉中不找新進場；剛出場的那一根也不同根反手（避免同根先後順序問題）
      continue;
    }

    const allowLong = !cand.trend || c[i].close > e200[i];
    const allowShort = !cand.longOnly && (!cand.trend || c[i].close < e200[i]);

    let dir: 1 | -1 | 0 = 0, fill = 0;
    if (cand.kind === 'donchian') {
      const up = hh(c, i, cand.entryN), dn = ll(c, i, cand.entryN);
      const hitUp = allowLong && nx.high >= up;
      const hitDn = allowShort && nx.low <= dn;
      if (hitUp && hitDn) continue; // 分不出先後，不做
      if (hitUp) { dir = 1; fill = Math.max(nx.open, up); }
      else if (hitDn) { dir = -1; fill = Math.min(nx.open, dn); }
    } else {
      if (i - cand.entryN < 0) continue;
      const mom = c[i].close - c[i - cand.entryN].close;
      if (mom > 0 && allowLong) { dir = 1; fill = nx.open; }
      else if (mom < 0 && allowShort) { dir = -1; fill = nx.open; }
    }
    if (!dir) continue;
    const entry = dir === 1 ? fill * (1 + ENTRY_SLIP) : fill * (1 - ENTRY_SLIP);
    const stop0 = entry - dir * cand.stopAtr * a;
    pos = { dir, entry, stop0, risk: Math.abs(entry - stop0), entryIdx: i + 1 };
    // 進場那一根也碰到止損 → 判止損（悲觀）
    if (dir === 1 ? nx.low <= stop0 : nx.high >= stop0) close(i + 1, stop0, EXIT_SLIP);
  }
  return trades.filter(t => t.entryT >= START);
}

function monthlySums(trades: Trade[]): number[] {
  const m = new Map<string, number>();
  for (let t = START; t < Date.now(); t += 28 * 86_400_000) m.set(new Date(t).toISOString().slice(0, 7), 0);
  for (const t of trades) { const k = new Date(t.exitT).toISOString().slice(0, 7); m.set(k, (m.get(k) ?? 0) + t.netR); }
  return Array.from(m.values());
}

async function main(): Promise<void> {
  const end = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  console.log('═'.repeat(96));
  console.log(`  候選策略比較  |  ${new Date(START).toISOString().slice(0, 10)} → 今天  |  ${UNIVERSE.length} 檔固定幣種  |  後段(樣本外) = 2024-07 起`);
  console.log('═'.repeat(96));

  const universe = STAGE2 ? [...UNIVERSE, ...UNIVERSE_B] : UNIVERSE;
  const data = new Map<string, { c4: Candle[]; c1d: Candle[]; fu: Funding[] }>();
  for (const s of universe) {
    process.stdout.write(`  抓取 ${s} ... `);
    const c4 = STAGE2 ? [] : await fetchKlines(s, '4h', FETCH_FROM, end);
    const c1d = await fetchKlines(s, '1d', FETCH_FROM, end);
    const fu = await fetchFunding(s, FETCH_FROM, end);
    // 上市太晚（EMA200 日線暖機不夠）或已下架的幣整檔排除，不拿半套資料混進來
    if (c1d.length < 1500 || c1d[0].openTime > FETCH_FROM + 30 * 86_400_000) { console.log(`資料不足（1d ${c1d.length}），排除`); continue; }
    data.set(s, { c4, c1d, fu });
    console.log(`4h ${c4.length}  1d ${c1d.length}  funding ${fu.length}`);
  }

  const verdicts: { name: string; pass: boolean; why: string[] }[] = [];
  const runs: { cand: Cand; uni: string[]; tag: string }[] = STAGE2
    ? CANDS_STAGE2.flatMap(cand => [
        { cand, uni: UNIVERSE.filter(s => data.has(s)), tag: '［第一批幣，已看過］' },
        { cand, uni: UNIVERSE_B.filter(s => data.has(s)), tag: '［第二批幣，沒看過 ← 判定看這個］' },
      ])
    : CANDS.map(cand => ({ cand, uni: UNIVERSE, tag: '' }));
  for (const { cand, uni, tag } of runs) {
    const all: Trade[] = [];
    const bySym = new Map<string, number>();
    for (const s of uni) {
      const d = data.get(s)!;
      const tr = simulate(cand, s, cand.interval === '4h' ? d.c4 : d.c1d, d.fu);
      all.push(...tr);
      bySym.set(s, tr.reduce((q, t) => q + t.netR, 0));
    }
    all.sort((a, b) => a.exitT - b.exitT);
    const net = all.map(t => t.netR);
    const early = all.filter(t => t.entryT < SPLIT).map(t => t.netR);
    const late = all.filter(t => t.entryT >= SPLIT).map(t => t.netR);
    const months = monthlySums(all);
    const sAll = summarize(net);
    const symPos = Array.from(bySym.values()).filter(v => v > 0).length;
    const tMonth = tStat(months);

    console.log(`\n── ${cand.name} ${tag} ${'─'.repeat(Math.max(0, 70 - cand.name.length - tag.length))}`);
    console.log(row('毛 R', all.map(t => t.grossR)));
    console.log(row('淨 R 全期', net));
    console.log(row('前段 2022-01~24-06', early));
    console.log(row('後段 2024-07~ (OOS)', late));
    console.log(row('做多', all.filter(t => t.dir === 1).map(t => t.netR)));
    console.log(row('做空', all.filter(t => t.dir === -1).map(t => t.netR)));
    for (const y of [2022, 2023, 2024, 2025, 2026]) {
      const ys = all.filter(t => new Date(t.entryT).getUTCFullYear() === y).map(t => t.netR);
      if (ys.length) console.log(row(`  ${y} 年`, ys));
    }
    console.log(`  止損距離中位數 ${(100 * all.map(t => t.riskPct).sort((a, b) => a - b)[Math.floor(all.length / 2)]).toFixed(2)}%  平均持有 ${mean(all.map(t => t.bars)).toFixed(1)} 根  成本 ≈ ${f(-mean(all.map(t => t.grossR - t.netR)))}R/筆`);
    console.log(`  幣種 ${symPos}/${uni.length} 為正  月份 ${months.filter(v => v > 0).length}/${months.length} 為正  月加總 t=${f(tMonth, 2)}  最大回撤 ${maxDrawdownR(net).toFixed(1)}R  每年 ${(all.length / ((Date.now() - START) / 3.156e10)).toFixed(0)} 筆`);

    const why: string[] = [];
    if (!(sAll.mean > 0 && sAll.ci[0] > 0)) why.push(`全期 CI 下界 ${f(sAll.ci[0])}`);
    if (!(mean(early) > 0 && mean(late) > 0)) why.push(`前/後段 ${f(mean(early))}/${f(mean(late))}`);
    if (!(symPos / uni.length >= 0.6)) why.push(`幣種 ${symPos}/${uni.length}`);
    if (!(tMonth >= 2)) why.push(`月 t=${f(tMonth, 2)}`);
    verdicts.push({ name: `${cand.name} ${tag}`, pass: why.length === 0, why });
  }

  console.log('\n' + '═'.repeat(96));
  console.log('  判定（四條錄取標準全過才算）');
  for (const v of verdicts) console.log(`  ${v.pass ? '✅ 錄取' : '❌ 不錄取'}  ${v.name.padEnd(44)} ${v.why.join('；')}`);
  console.log('  對照：現有策略（1H，12 個月）淨 −0.055R/筆，95%CI [−0.100, −0.010]');
  console.log('═'.repeat(96));
}

main().catch(e => { console.error('strategy-candidates error:', e); process.exit(1); });
