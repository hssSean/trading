#!/usr/bin/env npx tsx
/**
 * 最小止損距離比較 —— 止損太近到底是不是在燒手續費。
 *
 *   npx tsx scripts/stop-distance-compare.ts [MONTHS] [SYMBOL_COUNT]
 *
 * ## 為什麼做這支（2026-09-07）
 *
 * 策略 A 的止損緩衝有硬下限（signals.ts:577）：
 *
 *     slBuffer = min(max(atr × multi, price × 0.004), price × MAX_SL_PCT)
 *                         ^^^^^^^^^^^^^^^^^^^^^^^^^ 日內 0.4%、波段 1.0%
 *
 * 策略 B 沒有。它的止損是「較近者勝」：
 *
 *     LONG   sl = max(entry - atr, bbLower - atr × 0.5)
 *     SHORT  sl = min(entry + atr, bbUpper + atr × 0.5)
 *
 * 價格從布林軌外側收回來時 bbUpper/bbLower 會很靠近 entry，止損距離因此可以
 * 任意小。實測 13 筆真倉策略 B，12 筆止損距離 < 1.0%，最極端 0.103%。
 *
 * ## 為什麼止損距離小會出事——這部分是算術，不是統計
 *
 * 倉位是照固定風險金額反推的（position.ts）：
 *
 *     倉位名目 = riskUSDT / 止損距離
 *
 * 手續費按**名目**收，所以換算成 R 之後：
 *
 *     手續費(R) = 往返費率% / 止損距離%
 *
 * 止損距離 0.103% 配上實測費率 0.06%，光手續費就是 **0.58R**。這不需要樣本
 * 就成立——它是除法。2026-09-07 那筆 BTC 名目 19,767 USDT、手續費 11.87 USDT，
 * 38 秒吃掉當日虧損上限的 71.6%。
 *
 * ## 這支要回答的是另一個問題
 *
 * 上面那段只證明「成本高」，沒證明「加下限比較好」。下限有代價：
 *
 *   - 止損推遠 → R 的分母變大 → 同一段價格波動換到的 R 變小
 *   - 策略 B 的 TP 固定在布林中軌，止損推遠 → rr 下降 → 可能低於 MIN_RR_B
 *     而**整個訊號不發**
 *
 * 好處（少被雜訊掃、手續費占比下降）與代價（R 變小、訊號變少）只能實測。
 *
 * ## 配對方式：以訊號為單位，不是以成交為單位
 *
 * 跟 entry-compare 同一套理由。不同下限會產生**不同的訊號集合**（rr 門檻），
 * 用「交易」配對就是在比不同的東西。沒發出／沒成交一律記 0R——那才是組合的
 * 真實觀點，也才回答得了「該不該加下限」。
 *
 * ## 兩種修法都測
 *
 *   clamp — 把止損推遠到下限（訊號照發，只是風險距離變大）
 *   skip  — 止損距離低於下限就整個不發（不扭曲止損位置，純過濾）
 *
 * 這兩種在數學上完全不同，不該混為一談。
 */

import type { Candle } from '../src/types';
import { simulateExit, pairedCompare, type ExitBar } from '../src/lib/exitPolicy';
import { fetchHistorical } from './backtest';
import {
  rollingAtr, collectEntries, topSymbols, BASELINE, FORWARD_BARS, WAIT_BARS,
} from './exit-compare';

const MONTHS = Math.max(1, parseInt(process.argv[2] ?? '6', 10));
const NSYM = Math.max(1, parseInt(process.argv[3] ?? '15', 10));

// 往返手續費（占名目的百分比）。實測 2026-09-07 那筆 BTC：名目 19,767 USDT、
// 手續費 11.87 USDT = 0.060%。進場是 LIMIT（maker 0.02%）、止損是 MARKET
// （taker 0.04%）。全 taker 進出會是 0.08%，所以這個值偏保守（低估成本）。
const ROUND_TRIP_FEE_PCT = 0.06;

// 照抄 signals.ts:856。策略 B 的訊號要通過這個 rr 門檻才會發出來，止損推遠
// 之後 rr 會下降，這正是下限的代價之一，不能不算。
const MIN_RR_B = 1.5;

interface StopPolicy {
  name: string;
  /** 止損距離下限（占進場價的百分比）；null = 現況，不設限 */
  minStopPct: number | null;
  /** true = 低於下限就不發訊號；false = 把止損推遠到下限 */
  skip: boolean;
}

const POLICIES: StopPolicy[] = [
  { name: '現況：無下限', minStopPct: null, skip: false },
  { name: 'clamp ≥0.4%', minStopPct: 0.4, skip: false },
  { name: 'clamp ≥0.6%', minStopPct: 0.6, skip: false },
  { name: 'clamp ≥0.8%', minStopPct: 0.8, skip: false },
  { name: 'clamp ≥1.0%', minStopPct: 1.0, skip: false },
  { name: 'skip <0.4%', minStopPct: 0.4, skip: true },
  { name: 'skip <0.6%', minStopPct: 0.6, skip: true },
  { name: 'skip <0.8%', minStopPct: 0.8, skip: true },
  { name: 'skip <1.0%', minStopPct: 1.0, skip: true },
];

const BASE = POLICIES[0].name;

interface Slot {
  /** 每個政策的淨 R（已扣手續費），索引對齊同一個訊號 */
  r: Map<string, number>;
  strategy: string;
  /** 現況下的止損距離%，用來判斷這個訊號會不會被下限影響 */
  baseDistPct: number;
}

async function main(): Promise<void> {
  const syms = await topSymbols(NSYM);
  console.log('='.repeat(78));
  console.log(`  最小止損距離比較  |  ${MONTHS} 個月  |  ${syms.length} 檔幣`);
  console.log(`  ${syms.map(s => s.replace('USDT', '')).join(' ')}`);
  console.log(`  出場規則固定為線上現況；手續費 ${ROUND_TRIP_FEE_PCT}% 名目已扣；沒發／沒成交記 0R`);
  console.log('='.repeat(78));

  const slots: Slot[] = [];
  let neverFilled = 0;
  let skippedShort = 0;

  for (const symbol of syms) {
    process.stdout.write(`  ${symbol} ... `);
    let candles: Candle[];
    try { candles = await fetchHistorical(symbol, MONTHS); }
    catch (e) { console.log(`跳過：${String(e).slice(0, 50)}`); continue; }
    const atr = rollingAtr(candles);
    const entries = collectEntries(symbol, candles);

    let used = 0;
    for (const e of entries) {
      const isLong = e.sig.direction === 'LONG';
      const entry = e.sig.entry;
      const baseSl = e.sig.stopLoss;
      const tp1 = e.sig.takeProfits[0];
      const tp2 = e.sig.takeProfits[1] ?? tp1;
      const strategy = e.sig.strategy === 'B' ? 'B' : 'A';
      const baseDistPct = Math.abs(entry - baseSl) / entry * 100;
      if (!(baseDistPct > 0)) continue;

      const fwd = candles.slice(e.idx + 1, e.idx + 1 + FORWARD_BARS);

      // 掛單成交模擬與 exit-compare 完全相同——進場模型換掉的話兩份結果就
      // 不能互相對照了。沒成交的訊號仍然佔一個 slot（記 0R），因為不同下限
      // 不改變成交與否，但改變「有沒有發出來」，兩者都要能被算進去。
      let fillIdx = -1;
      for (let k = 0; k < Math.min(WAIT_BARS, fwd.length); k++) {
        const c = fwd[k];
        if (isLong ? c.low <= entry : c.high >= entry) { fillIdx = k; break; }
      }

      const slot: Slot = { r: new Map(), strategy, baseDistPct };
      let usable = true;

      for (const p of POLICIES) {
        // ── 這個政策下，這個訊號還在不在？──
        if (p.minStopPct !== null && p.skip && baseDistPct < p.minStopPct) {
          slot.r.set(p.name, 0);   // 被過濾掉 = 沒開倉 = 0R，也沒有手續費
          continue;
        }
        // ── 止損位置 ──
        const dist = p.minStopPct === null
          ? Math.abs(entry - baseSl)
          : Math.max(Math.abs(entry - baseSl), entry * p.minStopPct / 100);
        const sl = isLong ? entry - dist : entry + dist;
        const distPct = dist / entry * 100;

        // ── 止損推遠後 rr 還過得了門檻嗎（只有策略 B 有這道）──
        // 策略 A 的止損緩衝本來就有下限，clamp 幾乎不會動到它；真的動到時
        // 這裡不重算 rr，會略微高估 clamp 對 A 的好處。A 不是本次的問題所在，
        // 而低估代價比高估安全的方向相反——所以下面的輸出只把策略 B 當結論，
        // 全體那組只當背景。
        if (strategy === 'B') {
          const rr = Math.abs(tp1 - entry) / dist;
          if (rr < MIN_RR_B) { slot.r.set(p.name, 0); continue; }
        }

        if (fillIdx < 0) { slot.r.set(p.name, 0); continue; }

        const bars: ExitBar[] = fwd.slice(fillIdx + 1).map(c => ({ high: c.high, low: c.low, close: c.close }));
        const a = atr.slice(e.idx + 1 + fillIdx + 1, e.idx + 1 + FORWARD_BARS);
        if (bars.length < 30) { usable = false; break; }

        const o = simulateExit({ entry, stopLoss: sl, tp1, tp2, isLong, bars, atr: a }, BASELINE);
        // 沒走完的樣本整筆排除——成對比較每個政策都要拿到同一批訊號。
        if (o.reason === 'open') { usable = false; break; }

        // 手續費換算成 R：費率占名目，而名目 = risk / 止損距離。
        // 這是下限唯一確定會改善的東西，也是整支腳本的重點。
        slot.r.set(p.name, o.r - ROUND_TRIP_FEE_PCT / distPct);
      }

      if (!usable) { skippedShort++; continue; }
      if (fillIdx < 0) neverFilled++;
      slots.push(slot);
      used++;
    }
    console.log(`${entries.length} 個訊號 → 採用 ${used}`);
  }

  report('全部訊號（策略 A 為主，只當背景）', slots);
  report('只看策略 B', slots.filter(s => s.strategy === 'B'));
  report('只看策略 B 且現況止損 < 1.0%（真正受影響的那群）',
    slots.filter(s => s.strategy === 'B' && s.baseDistPct < 1.0));
}

function report(title: string, slots: Slot[]): void {
  const f = (x: number, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d);
  console.log('\n' + '─'.repeat(78));
  console.log(`  ${title}`);
  console.log('─'.repeat(78));
  if (slots.length < 20) {
    console.log(`  n=${slots.length} —— 樣本太少，不輸出比較。`);
    console.log('  （這不是「沒有效果」，是「測不出來」。兩者不可互換。）');
    return;
  }

  const arr = (name: string) => slots.map(s => s.r.get(name) ?? 0);
  const baseR = arr(BASE);
  const net = (a: number[]) => a.reduce((s, x) => s + x, 0);
  console.log(`  n=${slots.length}   基準「${BASE}」淨 ${f(net(baseR))}R   每筆 ${f(net(baseR) / slots.length, 3)}R`);
  console.log('');

  const rows = POLICIES.filter(p => p.name !== BASE).map(p => {
    const r = arr(p.name);
    // 受影響筆數：止損距離本來就在下限之上的訊號，兩個政策的結果完全相同，
    // 對成對差異貢獻 0。它們會同時放大 n 與縮小 sd，t 值不受影響但**看起來
    // 像大樣本**。2026-09-07 實測 n=1473 裡只有 81 筆真的被動到——不報這個
    // 數字的話，「n=1473、t=-0.99」會被誤讀成「大樣本測不出差異」，
    // 實際上是「81 筆測不出差異」。兩者的檢定力差了一個數量級。
    const affected = r.filter((v, i) => v !== baseR[i]).length;
    return { name: p.name, net: net(r), affected, cmp: pairedCompare(baseR, r) };
  }).sort((a, b) => b.cmp.meanDiff - a.cmp.meanDiff);

  for (const row of rows) {
    const mark = row.cmp.significant ? (row.cmp.meanDiff > 0 ? '★ 顯著較好' : '✗ 顯著較差') : '  分不出來';
    console.log(`  ${row.name.padEnd(14)} 淨 ${f(row.net).padStart(8)}R   每筆差 ${f(row.cmp.meanDiff, 3).padStart(7)}R `
      + `±${row.cmp.se.toFixed(3)}  t=${String(row.cmp.t).padStart(6)}  ${mark}`
      + `   受影響 ${String(row.affected).padStart(4)}/${slots.length}`);
  }
}

main().catch(e => { console.error('失敗：', e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
