#!/usr/bin/env npx tsx
/**
 * S3／S1 上線前驗收：對研究端文件第 10 節的參考交易逐筆比對（docs/strategy-deploy-2026-10-06.md、
 * 完整精度版在 docs/s3-reference-trades.csv、docs/s1-reference-trades.csv）。
 *
 *   npx tsx scripts/s3s1-acceptance.ts            # 不含市場廣度（快）
 *   npx tsx scripts/s3s1-acceptance.ts --breadth  # 另外抓全市場日線比對市場廣度（約 3～5 分鐘，有快取）
 *
 * 判定：訊號、指標值、止損、進場價、分數、資金費率、出場時間、R 的相對誤差 < 1e-6（文件 §0.4）。
 * 市場廣度另外報告：參考實作的分母含已下市的幣，現在的 exchangeInfo 拿不到它們，所以只要求
 * 「< 0.93 的判斷結果相同」，數值差異列出不判定。
 */
import { readFileSync } from 'node:fs';
import { fetchBars, fetchFunding, getJson, type QvBar } from './lib/binanceData';
import {
  DAY, H, H12, dailyFeatures, h12Features, s3SignalAt, s1SignalAt, s3Score, btcExt, fundingAt, idxOf,
  breadthAt, simulateTrade, isExcludedSymbol, trimPartialFirstBar, BREADTH_MAX, type DailyFeat,
} from '../src/lib/s3s1/rules';

const END = Date.UTC(2026, 8, 1);          // 參考資料到 2026-08-31 23:00 為止
const D_FROM = Date.UTC(2023, 0, 1);
const H_FROM = Date.UTC(2025, 3, 1);
const TOL = 1e-6;
const WITH_BREADTH = process.argv.includes('--breadth');

function csv(path: string): Record<string, string>[] {
  const lines = readFileSync(path, 'utf-8').replace(/^﻿/, '').trim().split(/\r?\n/);
  const head = lines[0].split(',');
  return lines.slice(1).map(l => { const v = l.split(','); return Object.fromEntries(head.map((h, i) => [h, v[i] ?? ''])); });
}
const parseDay = (s: string) => Date.parse(s.slice(0, 10) + 'T00:00:00Z');
const parseMin = (s: string) => Date.parse(s.replace(' ', 'T') + ':00Z');
const fmtMin = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

let fails = 0;
function check(label: string, mine: number, ref: number, tol = TOL): string {
  const ok = (Number.isNaN(mine) && Number.isNaN(ref)) || Math.abs(mine - ref) <= tol * Math.max(1, Math.abs(ref));
  if (!ok) fails++;
  return ok ? '' : ` ❌${label}(${mine} vs ${ref})`;
}

const dailyCache = new Map<string, QvBar[]>();
const firstHour = new Map<string, number>();
/** 該幣第一根 1H 的開盤時間（上市時間）——只有資料從上市開始時才需要（trimPartialFirstBar） */
async function listingHour(sym: string): Promise<number> {
  if (!firstHour.has(sym)) {
    const k = await getJson<unknown[][]>('/klines', { symbol: sym, interval: '1h', startTime: 0, limit: 1 });
    firstHour.set(sym, k.length ? (k[0][0] as number) : 0);
  }
  return firstHour.get(sym)!;
}
async function daily(sym: string) {
  if (!dailyCache.has(sym)) {
    const bars = await fetchBars(sym, '1d', D_FROM, END);
    dailyCache.set(sym, bars.length && bars[0].t > D_FROM ? trimPartialFirstBar(bars, await listingHour(sym), DAY) as QvBar[] : bars);
  }
  return dailyCache.get(sym)!;
}
async function bars12(sym: string) {
  const bars = await fetchBars(sym, '12h', D_FROM, END);
  return bars.length && bars[0].t > D_FROM ? trimPartialFirstBar(bars, await listingHour(sym), H12) : bars;
}

async function main(): Promise<void> {
  const btc = dailyFeatures(await daily('BTCUSDT'));
  let breadthFeat: Map<string, DailyFeat> | null = null;
  if (WITH_BREADTH) {
    process.stdout.write('抓全市場日線（市場廣度用）… ');
    const info = await getJson<{ symbols: { symbol: string; contractType: string; quoteAsset: string }[] }>('/exchangeInfo', {});
    const syms = info.symbols.filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && !isExcludedSymbol(s.symbol)).map(s => s.symbol);
    breadthFeat = new Map();
    for (const s of syms) {
      try { breadthFeat.set(s, dailyFeatures(await daily(s))); } catch { /* 下架或抓不到 */ }
      await new Promise(r => setTimeout(r, 120));
    }
    console.log(`${breadthFeat.size} 檔`);
  }

  // ── S3 ──
  console.log('\n── S3（文件 §10.1）');
  for (const r of csv('docs/s3-reference-trades.csv')) {
    const sym = r['合約'], dayD = parseDay(r['訊號日UTC']);
    const f = dailyFeatures(await daily(sym));
    const sig = s3SignalAt(sym, f, dayD);
    if (!sig) { fails++; console.log(`  ❌ ${sym} ${r['訊號日UTC']} 沒有產生訊號`); continue; }
    const hourly = await fetchBars(sym, '1h', H_FROM, END);
    const fund = await fetchFunding(sym, H_FROM, END);
    const sim = simulateTrade({ kind: 'S3', entryT: dayD + DAY, stop: sig.stop, hourly, daily: f, fund, dataEnd: END, forceCloseAtEnd: true, withAddon: true });
    if (!sim) { fails++; console.log(`  ❌ ${sym} ${r['訊號日UTC']} 無法模擬`); continue; }
    const dist = sim.risk / sim.entry;
    const be = btcExt(btc, dayD);
    const score = s3Score(dist, be, sig.ret7);
    const fr = fundingAt(fund, dayD + DAY);
    let msg = check('收盤', sig.close, +r['訊號收盤']) + check('HH20', sig.hh20, +r['前20日最高']) + check('ATR14', sig.atr14, +r['ATR14'])
      + check('止損', sig.stop, +r['止損']) + check('進場', sim.entry, +r['進場價']) + check('止損距離', dist, +r['止損距離'])
      + check('BTC離EMA50', be, +r['BTC離EMA50_ATR']) + check('七日漲幅', sig.ret7, +r['七日漲幅']) + check('分數', score, +r['分數'])
      + check('資金費', fr, +r['資金費率']);
    if (fmtMin(sim.exitT) !== r['出場UTC']) { fails++; msg += ` ❌出場(${fmtMin(sim.exitT)} vs ${r['出場UTC']})`; }
    msg += check('原單R', sim.netR, +r['原單R']);
    if (r['結果'] === '交易') msg += check('加碼R', sim.addR ?? 0, +(r['加碼R'] || 0));
    if (breadthFeat) {
      const b = breadthAt(breadthFeat, dayD + DAY);
      const same = (b < BREADTH_MAX) === (+r['市場廣度'] < BREADTH_MAX);
      if (!same) fails++;
      msg += ` 廣度 ${b.toFixed(4)}（參考 ${(+r['市場廣度']).toFixed(4)}）${same ? '' : ' ❌判斷不同'}`;
    }
    console.log(`  ${msg.includes('❌') ? '❌' : '✅'} ${r['結果'].slice(0, 2)} ${r['訊號日UTC']} ${sym.padEnd(14)} 分數 ${score} R ${sim.netR.toFixed(3)}${r['加碼R'] ? ` 加碼 ${(sim.addR ?? 0).toFixed(3)}` : ''}${msg}`);
  }

  // ── S1 ──
  console.log('\n── S1（文件 §10.2）');
  for (const r of csv('docs/s1-reference-trades.csv')) {
    const sym = r['合約'], barT = parseMin(r['訊號K開盤UTC']);
    const h12 = h12Features(await bars12(sym));
    const sig = s1SignalAt(sym, h12, barT);
    if (!sig) { fails++; console.log(`  ❌ ${sym} ${r['訊號K開盤UTC']} 沒有產生訊號`); continue; }
    const i = idxOf(h12.bars, barT);
    const fd = dailyFeatures(await daily(sym));
    const dayD = Math.floor(barT / DAY) * DAY;
    const di = idxOf(fd.bars, dayD - DAY), bi = idxOf(btc.bars, dayD - DAY);
    const hourly = await fetchBars(sym, '1h', H_FROM, END);
    const fund = await fetchFunding(sym, H_FROM, END);
    const sim = simulateTrade({ kind: 'S1', entryT: barT + H12, stop: sig.stop, hourly, h12, fund, dataEnd: END, forceCloseAtEnd: true });
    if (!sim) { fails++; console.log(`  ❌ ${sym} ${r['訊號K開盤UTC']} 無法模擬`); continue; }
    let msg = check('收盤', sig.close, +r['收盤']) + check('EMA20', sig.ema20, +r['EMA20']) + check('ATR10', sig.atr10, +r['ATR10'])
      + check('上軌', sig.upper, +r['上軌']) + check('前收', h12.bars[i - 1].c, +r['前一根收盤']) + check('前上軌', h12.upper[i - 1], +r['前一根上軌'])
      + check('止損', sig.stop, +r['止損']) + check('進場', sim.entry, +r['進場價'])
      + check('幣D-1收盤', fd.bars[di].c, +r['幣前一天收盤']) + check('幣D-1EMA50', fd.ema50[di], +r['幣前一天EMA50'])
      + check('BTC D-1收盤', btc.bars[bi].c, +r['BTC前一天收盤']) + check('BTC D-1EMA50', btc.ema50[bi], +r['BTC前一天EMA50'])
      + check('資金費', fundingAt(fund, barT + H12), +r['資金費率']);
    if (fmtMin(sim.exitT) !== r['出場UTC']) { fails++; msg += ` ❌出場(${fmtMin(sim.exitT)} vs ${r['出場UTC']})`; }
    msg += check('R', sim.netR, +r['R']);
    if (breadthFeat) {
      const b = breadthAt(breadthFeat, barT + H12);
      const same = (b < BREADTH_MAX) === (+r['市場廣度'] < BREADTH_MAX);
      if (!same) fails++;
      msg += ` 廣度 ${b.toFixed(4)}（參考 ${(+r['市場廣度']).toFixed(4)}）${same ? '' : ' ❌判斷不同'}`;
    }
    console.log(`  ${msg.includes('❌') ? '❌' : '✅'} ${r['訊號K開盤UTC']} ${sym.padEnd(12)} R ${sim.netR.toFixed(3)}${msg}`);
  }
  void H;

  console.log(`\n${fails === 0 ? '✅ 全部通過' : `❌ ${fails} 項不符`}`);
  if (fails) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
