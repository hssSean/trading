#!/usr/bin/env npx tsx
/**
 * 進場政策比較 — 掛單等回調 vs 追市價 vs 不同等待窗口。
 *
 *   npx tsx scripts/entry-compare.ts [MONTHS] [SYMBOL_COUNT]
 *
 * 為什麼做這支：真實資料裡 237 筆有訊號、只有 78 筆有結果——**三分之二的
 * 訊號從未成交**。進場評分（五組因子相關性全部 |t|<2）和出場規則（九個變體
 * 全部 |t|<2）都測不出槓桿，但那些都只影響已成交的部分；掛單機制影響的是
 * 全部訊號，是目前唯一還沒被量過、而且作用面最大的東西。
 *
 * ── 為什麼止損不會跟著進場價走 ──
 * buildSignalLevels 的 SL 錨定在結構位（obEdge / srPrice），不是從進場價
 * 偏移。所以改用市價進場時止損不動、風險距離變大 → 同樣的 TP 拿到的 R 變差。
 * 這就是追高的代價，模型必須算進去，否則市價進場會被高估。
 * R 一律用「實際進場價與止損的距離」當分母——系統本來就是照風險調倉位
 * （suggestedRiskPct），進場差就代表倉位要縮小，用實際風險正規化才對得上。
 *
 * ── 配對方式跟 exit-compare 不同 ──
 * 不同進場政策產生**不同的成交集合**，沒辦法用「交易」配對。改成**以訊號
 * 為單位**配對：沒成交就記 0R。那才是組合的真實觀點（沒進場就是沒賺沒賠），
 * 而且這樣成對比較才成立，才能直接回答「該追還是該等」。
 */

import type { Candle } from '../src/types';
import { simulateExit, pairedCompare, type ExitBar } from '../src/lib/exitPolicy';
import { fetchHistorical } from './backtest';
import {
  rollingAtr, collectEntries, topSymbols, BASELINE, FORWARD_BARS,
} from './exit-compare';

const MONTHS = Math.max(1, parseInt(process.argv[2] ?? '3', 10));
const NSYM = Math.max(1, parseInt(process.argv[3] ?? '8', 10));

interface EntryPolicy {
  name: string;
  /** 等待掛單成交的最大根數；0 = 市價進場（下一根開盤價） */
  waitBars: number;
  /**
   * 掛單價位相對「訊號價 → 市價」的比例。
   * 1 = 訊號原本的掛單價（等完整回調）；0.5 = 只等一半的回調；0 = 市價。
   * 只在 waitBars > 0 時有意義。
   */
  pullbackFraction: number;
}

const POLICIES: EntryPolicy[] = [
  { name: '現況：等完整回調 8 根', waitBars: 8, pullbackFraction: 1 },
  { name: '等待縮短到 4 根', waitBars: 4, pullbackFraction: 1 },
  { name: '等待延長到 16 根', waitBars: 16, pullbackFraction: 1 },
  { name: '等待延長到 24 根', waitBars: 24, pullbackFraction: 1 },
  { name: '只等一半回調 8 根', waitBars: 8, pullbackFraction: 0.5 },
  { name: '只等 1/4 回調 8 根', waitBars: 8, pullbackFraction: 0.25 },
  { name: '直接市價進場', waitBars: 0, pullbackFraction: 0 },
];

const BASE = POLICIES[0].name;

async function main(): Promise<void> {
  const syms = await topSymbols(NSYM);
  console.log('='.repeat(72));
  console.log(`  進場政策比較  |  ${MONTHS} 個月  |  ${syms.length} 檔幣`);
  console.log(`  ${syms.map(s => s.replace('USDT', '')).join(' ')}`);
  console.log('  出場規則固定為線上現況；沒成交的訊號記 0R');
  console.log('='.repeat(72));

  // 以訊號為單位配對：每個政策一組 R，索引對齊同一個訊號
  const rBy = new Map<string, number[]>(POLICIES.map(p => [p.name, []]));
  const fillsBy = new Map<string, number>(POLICIES.map(p => [p.name, 0]));
  let totalSignals = 0;

  for (const symbol of syms) {
    process.stdout.write(`  ${symbol} ... `);
    let candles: Candle[];
    try { candles = await fetchHistorical(symbol, MONTHS); }
    catch (e) { console.log(`跳過：${String(e).slice(0, 50)}`); continue; }
    const atr = rollingAtr(candles);
    const entries = collectEntries(symbol, candles);

    let counted = 0;
    for (const e of entries) {
      const isLong = e.sig.direction === 'LONG';
      const fwd = candles.slice(e.idx + 1, e.idx + 1 + FORWARD_BARS);
      if (fwd.length < 40) continue;   // 往後資料不足，所有政策都比不準
      const market = fwd[0].open;      // 訊號隔一根的開盤價 = 追市價會拿到的價
      const sl = e.sig.stopLoss;
      const tp1 = e.sig.takeProfits[0];
      const tp2 = e.sig.takeProfits[1] ?? tp1;

      const perPolicy: Array<{ name: string; r: number; filled: boolean }> = [];
      for (const p of POLICIES) {
        // 掛單價：在「訊號原本的掛單價」與「市價」之間插值
        const limitPx = market + (e.sig.entry - market) * p.pullbackFraction;

        let fillIdx = -1;
        let fillPx = 0;
        if (p.waitBars === 0) {
          fillIdx = -1 + 1 - 1; // 市價：第 0 根就成交
          fillIdx = 0;
          fillPx = market;
        } else {
          for (let k = 0; k < Math.min(p.waitBars, fwd.length); k++) {
            const c = fwd[k];
            if (isLong ? c.low <= limitPx : c.high >= limitPx) { fillIdx = k; fillPx = limitPx; break; }
          }
        }
        // 沒成交 = 沒進場 = 0R（不是把這個訊號丟掉——丟掉就等於假裝
        // 「錯過機會」沒有成本／沒有好處，那正是要比較的東西）
        if (fillIdx < 0) { perPolicy.push({ name: p.name, r: 0, filled: false }); continue; }

        // 止損不隨進場價移動（結構錨定），所以進場差就是風險距離變大。
        // 進場價踩在止損另一側的訊號直接視為無效，不硬算一個負風險。
        const riskDist = isLong ? fillPx - sl : sl - fillPx;
        if (riskDist <= 0) { perPolicy.push({ name: p.name, r: 0, filled: false }); continue; }

        const bars: ExitBar[] = fwd.slice(fillIdx + 1).map(c => ({ high: c.high, low: c.low, close: c.close }));
        const a = atr.slice(e.idx + 1 + fillIdx + 1, e.idx + 1 + FORWARD_BARS);
        if (bars.length < 30) { perPolicy.push({ name: p.name, r: 0, filled: false }); continue; }

        const o = simulateExit(
          { entry: fillPx, stopLoss: sl, tp1, tp2, isLong, bars, atr: a },
          BASELINE,
        );
        // 走不完的樣本不能當 0R（那會假裝它沒發生），整個訊號跳過
        if (o.reason === 'open') { perPolicy.push({ name: p.name, r: NaN, filled: true }); continue; }
        perPolicy.push({ name: p.name, r: o.r, filled: true });
      }

      if (perPolicy.some(x => Number.isNaN(x.r))) continue;
      for (const x of perPolicy) {
        rBy.get(x.name)!.push(x.r);
        if (x.filled) fillsBy.set(x.name, fillsBy.get(x.name)! + 1);
      }
      counted++;
    }
    totalSignals += counted;
    console.log(`${entries.length} 個訊號 → 採用 ${counted}`);
  }

  const baseR = rBy.get(BASE)!;
  const n = baseR.length;
  console.log(`\n樣本：${n} 個訊號（每個政策都在同一批訊號上評估）`);
  if (n < 30) { console.log('樣本太少，不輸出比較。'); return; }

  const net = (a: number[]) => a.reduce((s, x) => s + x, 0);
  const f = (x: number, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d);

  console.log('─'.repeat(72));
  const rows = POLICIES.map(p => {
    const r = rBy.get(p.name)!;
    const fills = fillsBy.get(p.name)!;
    return {
      name: p.name, net: net(r), fillRate: fills / n * 100,
      perFilled: fills > 0 ? net(r) / fills : 0,
      cmp: p.name === BASE ? null : pairedCompare(baseR, r),
    };
  });

  for (const row of rows) {
    const head = `  ${row.name.padEnd(20)} 成交率 ${row.fillRate.toFixed(0).padStart(3)}%  淨 ${f(row.net).padStart(8)}R  已成交每筆 ${f(row.perFilled, 3).padStart(7)}R`;
    if (!row.cmp) { console.log(head + '   ← 基準'); continue; }
    const mark = row.cmp.significant ? (row.cmp.meanDiff > 0 ? '★ 顯著較好' : '✗ 顯著較差') : '分不出來';
    console.log(head + `  每訊號差 ${f(row.cmp.meanDiff, 3)}R t=${row.cmp.t}  ${mark}`);
  }

  console.log('─'.repeat(72));
  console.log('  「已成交每筆」是只看有進場的那些；「每訊號差」把沒成交的算 0R，');
  console.log('  那才是組合層面的比較——成交率高但每筆較差，兩者可能互相抵消。');
  console.log('─'.repeat(72));
  void totalSignals;
}

main().catch(e => { console.error('entry-compare error:', e); process.exit(1); });
