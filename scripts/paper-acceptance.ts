#!/usr/bin/env npx tsx
/**
 * 紙上策略驗收：拿兩份規格的驗收 CSV 逐筆比對（上線前必須通過）。
 *
 *   npx tsx scripts/paper-acceptance.ts
 *
 * 策略 A：BTC/ETH/SOL 2024-01～2026-08，只看規則本身（不套幣池與持倉上限）。
 *   signal_day／entry_day 100% 相同、stop 相對誤差 < 0.5%、gross_R 誤差 < 0.05R。
 * 影片 A/B/C：ETHUSDT 2025-06，訂單時間、方向、價格、止損、止盈相同（< 0.1%）。
 *   參考實作以 5 分鐘 K 線執行、本實作以 1H 執行，成交／出場欄位僅列出不判定。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchKlines, fetchFunding } from './lib/binanceData';
import { btcRegime, keltnerSignals, simulateKeltner, type Bar } from '../src/lib/paper/keltner';
import type { Candle } from '../src/types';
import { buildFrames, stratA, stratB, stratC, executeSequence } from '../src/lib/paper/video';

const D = 86_400_000;
const toBar = (c: Candle): Bar => ({ t: c.openTime, o: c.open, h: c.high, l: c.low, c: c.close });
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

function specCsv(file: string, header: string): string[][] {
  const txt = readFileSync(join('C:/trading_stratage/docs', file), 'utf-8');
  const start = txt.indexOf(header);
  const body = txt.slice(start).split('```')[0];
  return body.trim().split(/\r?\n/).slice(1).filter(Boolean).map(l => l.split(','));
}

async function acceptanceA(): Promise<boolean> {
  const rows = specCsv('策略A_自動交易規格.md', 'symbol,signal_day,entry_day');
  const END = Date.UTC(2026, 8, 1); // 2026-09-01，資料只到 2026-08-31（與參考輸出一致）
  const FROM = Date.UTC(2022, 6, 1);
  const btc = (await fetchKlines('BTCUSDT', '1d', FROM, END)).map(toBar);
  const regime = btcRegime(btc);
  let ok = true;
  console.log('── 策略 A（日線 Keltner）');
  for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
    const daily = (await fetchKlines(sym, '1d', FROM, END)).map(toBar);
    const hourly = (await fetchKlines(sym, '1h', Date.UTC(2023, 11, 1), END)).map(toBar);
    const fund = await fetchFunding(sym, Date.UTC(2023, 11, 1), END);
    const sigs = keltnerSignals(sym, daily, regime).filter(s => s.signalT >= Date.UTC(2024, 0, 1));
    const mine: { sig: string; entry: string; stop: number; exit: string; gross: number | null }[] = [];
    let busyUntil = -Infinity; // 出場那根之後的下一根日線開盤時間
    for (const s of sigs) {
      if (s.signalT < busyUntil) continue;
      const o = simulateKeltner(s, daily, hourly, fund);
      if (o.status === 'skip' || o.status === 'pending') continue;
      if (o.status === 'done') {
        mine.push({ sig: day(s.signalT), entry: day(s.entryT), stop: s.stop, exit: new Date(o.exitT).toISOString().slice(0, 16).replace('T', ' '), gross: o.grossR });
        busyUntil = Math.floor(o.exitT / D) * D + D;
      } else {
        mine.push({ sig: day(s.signalT), entry: day(s.entryT), stop: s.stop, exit: '2026-08-31 23:00', gross: null });
        busyUntil = Infinity;
      }
    }
    const ref = rows.filter(r => r[0] === sym);
    const n = Math.max(ref.length, mine.length);
    for (let i = 0; i < n; i++) {
      const r = ref[i], m = mine[i];
      if (!r || !m) { ok = false; console.log(`  ❌ ${sym} 第 ${i + 1} 筆：參考 ${r?.slice(1, 3).join('/') ?? '無'}，本實作 ${m ? `${m.sig}/${m.entry}` : '無'}`); continue; }
      const stopErr = Math.abs(m.stop - +r[4]) / +r[4];
      // 參考輸出把資料結束時仍持有的單用最後收盤結算；本實作視為未平倉，不比 gross
      const grossErr = m.gross == null ? 0 : Math.abs(m.gross - +r[6]);
      const pass = m.sig === r[1] && m.entry === r[2] && stopErr < 0.005 && (r[5].startsWith('2026-08-31 23') || grossErr < 0.05);
      if (!pass) ok = false;
      console.log(`  ${pass ? '✅' : '❌'} ${sym.padEnd(8)} ${m.sig} → ${m.entry}  stop ${m.stop.toFixed(4)} (ref ${(+r[4]).toFixed(4)}, ${(stopErr * 100).toFixed(3)}%)  `
        + `exit ${m.exit} (ref ${r[5]})  R ${m.gross == null ? '持有中' : m.gross.toFixed(3)} (ref ${r[6]})`);
    }
  }
  return ok;
}

async function acceptanceVideo(): Promise<boolean> {
  const txt = readFileSync('C:/trading_stratage/docs/影片策略_自動交易規格.md', 'utf-8');
  // 程式碼區塊第一行是 ```csv 的語言標記、第二行是表頭
  const block = (title: string) => txt.slice(txt.indexOf(title)).split('```')[1].trim().split(/\r?\n/)
    .filter(l => l && l !== 'csv' && !l.startsWith('order_time_utc')).map(l => l.split(','));
  const refs = { videoA: block('**策略 A**'), videoB: block('**策略 B**'), videoC: block('**策略 C**') };
  const END = Date.UTC(2025, 7, 1);
  const G = (await fetchKlines('ETHUSDT', '1h', Date.UTC(2024, 6, 1), END)).map(toBar);
  const F = (await fetchKlines('ETHUSDT', '4h', Date.UTC(2023, 6, 1), END)).map(toBar);
  const Dd = (await fetchKlines('ETHUSDT', '1d', Date.UTC(2021, 6, 1), END)).map(toBar);
  const fund = await fetchFunding('ETHUSDT', Date.UTC(2024, 6, 1), END);
  const fr = buildFrames(G, F, Dd);
  const all = { videoA: stratA('ETHUSDT', fr), videoB: stratB('ETHUSDT', fr), videoC: stratC('ETHUSDT', fr) };
  const inJune = (t: number) => t >= Date.UTC(2025, 5, 1) && t < Date.UTC(2025, 6, 1);
  let ok = true;
  for (const key of ['videoA', 'videoB', 'videoC'] as const) {
    console.log(`\n── 影片策略 ${key.slice(-1)}（ETHUSDT 2025-06）`);
    const ex = executeSequence(all[key], G, fund);
    const mine = all[key].map((o, k) => ({ o, r: ex[k] })).filter(x => inJune(x.o.startT)).sort((a, b) => a.o.startT - b.o.startT || b.o.side - a.o.side);
    const ref = refs[key];
    // 參考 CSV 每套只列了 8 筆（Python 輸出的前 8 列；strat_a 先跑完做多才跑做空，所以 A 的 8 筆
    // 全是做多）。判定方式：參考的每一筆都必須在本實作裡找到、且價格／止損／止盈一致。
    const fmt = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
    const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
    const used = new Set<number>();
    for (const r of ref) {
      const k = mine.findIndex(m => fmt(m.o.startT) === r[0] && (m.o.side === 1 ? 'long' : 'short') === r[1]);
      if (k < 0) { ok = false; console.log(`  ❌ 參考 ${r[0]} ${r[1]} 在本實作中找不到`); continue; }
      used.add(k);
      const m = mine[k];
      const pass = rel(m.o.price, +r[3]) < 0.001 && rel(m.o.sl, +r[4]) < 0.001 && rel(m.o.tp, +r[5]) < 0.001;
      if (!pass) ok = false;
      const res = m.r.status === 'done' ? `${m.r.exitKind} ${m.r.grossR.toFixed(3)}` : m.r.status;
      console.log(`  ${pass ? '✅' : '❌'} ${r[0]} ${r[1].padEnd(5)} ${m.o.price.toFixed(4)} sl ${m.o.sl.toFixed(4)} tp ${m.o.tp.toFixed(4)}  `
        + `(ref ${r[3]} ${r[4]} ${r[5]})  執行[1H] ${res}  ref[5m] ${r[6]} ${r[7] ?? ''} ${r[8] ?? ''}`);
    }
    const extra = mine.filter((_, k) => !used.has(k));
    if (extra.length) console.log(`  ℹ 參考表沒列到的（截斷）：${extra.map(m => `${fmt(m.o.startT)} ${m.o.side === 1 ? 'long' : 'short'}`).join('、')}`);
  }
  return ok;
}

async function main(): Promise<void> {
  const a = await acceptanceA();
  const v = await acceptanceVideo();
  console.log(`\n策略 A：${a ? '✅ 通過' : '❌ 未通過'}   影片策略：${v ? '✅ 通過' : '❌ 未通過'}`);
  if (!a || !v) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
