#!/usr/bin/env npx tsx
/**
 * 出場政策比較 — 同一批進場訊號，套不同出場規則走完真實 K 線，比淨 R。
 *
 *   npx tsx scripts/exit-compare.ts [MONTHS] [SYMBOL_COUNT]
 *   npx tsx scripts/exit-compare.ts 3 10
 *
 * 為什麼做這支：2026-08-23 實測資料指出錢漏在出場而不是進場——
 *   移動止損（TP1後）  n=9   MFE +2.66R → 實現 +1.07R  吐回 60%
 *   時間止損（盤面停滯）n=22  MFE +0.65R → 實現 +0.01R  吐回 98%（佔 34% 名額）
 *   原始止損（未達TP1）n=19  MFE +0.05R                 ← 止損是對的，不是漏水點
 * 而五組評分因子跟 R 的等級相關全部 |t|<2（n=78），進場評分量不出效果。
 *
 * 用 MFE 做的反事實試算到此為止：那種算法只把虧損單改好，算不到新規則對
 * 「現在會贏的單」的傷害。要逐根走 K 線，好處與代價才會同時被算到。
 *
 * ── 兩個必須知道的設計取捨 ──
 *
 * 1. 進場獨立於出場產生。backtest.ts 的 runBacktest 是「同時只持有一筆」，
 *    不同出場政策的出場時間不同 → 後續進場點就不一樣，兩組比的就不是同一
 *    批交易，成對比較會失效。這裡改成掃描每一根、用固定冷卻期避免重複進場，
 *    讓所有政策拿到**完全相同**的進場集合。代價是這不等於線上的組合行為
 *    （線上有 symbol 鎖與同向上限），但這支要比的是出場規則，不是組合管理。
 *
 * 2. 成對比較（pairedCompare）而不是比兩組平均。同一筆訊號在兩個政策下的
 *    差異，把「這筆訊號本身好不好」的共同變異消掉，同樣樣本數檢定力高得多
 *    ——這個專案的樣本一向不夠，能省的檢定力都要省。
 *
 * 同根 K 線 TP 與 SL 都碰到時判 SL（悲觀），見 exitPolicy.ts 說明。
 */

import type { Candle, TradingSignal } from '../src/types';
import { generateSignals, generateMeanReversionSignals } from '../src/analysis/signals';
import { fetchHistorical } from './backtest';
import { pairedCompare, type ExitPolicyConfig } from '../src/lib/exitPolicy';
import {
  LIVE, aggregate4h, makeFourHView, adx4hAt, regimeFromAdx, RegimeTracker, closes4hWithForming, ema200Bias,
  simulateFill, simulateExitAfterFill, tradeCostR, type FourHView,
} from './lib/liveReplica';
import axios from 'axios';
import { pathToFileURL } from 'node:url';

const MONTHS = Math.max(1, parseInt(process.argv[2] ?? '3', 10));
const NSYM = Math.max(1, parseInt(process.argv[3] ?? '10', 10));

const WARMUP = 250;
const WINDOW_1H = 200;
// 2026-08-26：對齊 route.ts 的 STRONG_THRESHOLD(65) / STRONG_THRESHOLD_B(13)。
// 原本是 70/10，跟線上不符——65-70 那一格在真實資料裡是最賠的區間，
// 用 70 等於把最差的一段排除掉，基準線會偏樂觀。見 backtest.ts 同名常數說明。
// 2026-09-24：改從 scripts/lib/liveReplica.ts 取（verify-strategy.ts 會比對 route.ts）。
const MIN_SCORE_A = LIVE.STRONG_THRESHOLD;
const MIN_SCORE_B = LIVE.STRONG_THRESHOLD_B;
const SLIP = 0.0003;
// 進場冷卻：同一檔幣在這麼多根之內不重複進場。用來近似線上的 symbol 鎖，
// 但**不依賴出場時間**——依賴的話成對比較就破功了（見檔頭說明 1）。
const ENTRY_COOLDOWN_BARS = 24;
// 每筆訊號往後看的最大根數。要夠長才不會讓「讓贏家跑久一點」的政策被
// 資料長度截斷（那會系統性低估它們）。
export const FORWARD_BARS = 200;
// 掛單等待成交的窗口。2026-09-24 以前這裡是 8，註解寫「route.ts 的
// WAITING_EXPIRY_HOURS = 8」——那個常數只是抓 K 線的後備窗口；真正決定撤單的是
// WAITING_EXPIRY_BARS = 4（route.ts 與 tradeBridge.ts 都是）。多給一倍時間成交，
// 會把「沒回調就跑掉」的單算成成交。
export const WAIT_BARS = LIVE.WAITING_EXPIRY_BARS;

// ── 線上實際參數（照抄，不是重新設計）──────────────────────────
//   TP1_PARTIAL_FRACTION = 0.5          monitorMath.ts
//   PRE_TP1_BREAKEVEN_TRIGGER_R = 0.5   tradeBridge.ts / route.ts
//   移動止損 = markPrice ∓ 2 × ATR(1h)   orderLifecycle.ts calcTrailingStopTarget
//   盤整停滯 = 滿 8 根且進度在 ±0.3R      engine/timeStop.ts
//   到期平倉 = 24h（1h K 線 → 24 根）     route.ts INTRADAY_CLOSE_HOURS
export const BASELINE: ExitPolicyConfig = {
  name: '現況（線上）', tp1Fraction: 0.5, breakevenAtR: 0.5, mfeGiveback: null, trailAtrMult: 2,
  stallBars: 8, stallBandR: 0.3, maxBars: 24,
  tp1AtR: null, tp2AtR: null,
};
const v = (name: string, o: Partial<ExitPolicyConfig>): ExitPolicyConfig => ({ ...BASELINE, name, ...o });

const POLICIES: ExitPolicyConfig[] = [
  BASELINE,
  v('拿掉盤整停滯', { stallBars: null }),
  v('拿掉保本觸發', { breakevenAtR: null }),
  v('保本提早到 0.3R', { breakevenAtR: 0.3 }),
  v('保本延後到 1.0R', { breakevenAtR: 1.0 }),
  v('不做 TP1 部分停利', { tp1Fraction: 0 }),
  v('移動止損收緊 1×ATR', { trailAtrMult: 1 }),
  v('移動止損放寬 3×ATR', { trailAtrMult: 3 }),
  v('到期延長到 72 根', { maxBars: 72 }),
  v('拿掉停滯＋到期延長', { stallBars: null, maxBars: 72 }),

  // 2026-09-03 新增：**TP 位置**。先前 10 個變體全部只動出場管理，沒有一個
  // 動到目標位置本身——而位置直接決定勝率。線上是 TP1 +2R / TP2 +3.5R
  // （buildSignalLevels）。實測賠率結構：勝率 26.3%、平均賺 +1.569R、
  // 平均賠 -0.700R，兩平需要 30.8%——缺的就是勝率。
  //
  // 拉近 TP1 會提高觸及率但降低單筆實現的 R，兩者誰勝誰負只能實測。
  // 這是目前唯一還沒被排除的參數家族。
  v('TP1 拉近到 +1.0R', { tp1AtR: 1.0 }),
  v('TP1 拉近到 +1.5R', { tp1AtR: 1.5 }),
  v('TP1 推遠到 +2.5R', { tp1AtR: 2.5 }),
  v('TP2 拉近到 +2.5R', { tp2AtR: 2.5 }),
  v('TP1 +1.5R ＋ TP2 +2.5R', { tp1AtR: 1.5, tp2AtR: 2.5 }),
  v('TP1 +1.0R ＋ TP2 +2.0R', { tp1AtR: 1.0, tp2AtR: 2.0 }),

  // 2026-09-19：docs/修改清單 B6。ANALYSIS-2026-08-12 §4 用 MFE 做的靜態
  // 反事實試算指出時間止損那 15 筆合計回吐 10.09R，但那個算法只把虧損單
  // 改好、算不到「保護提早啟動會不會砍到現在會贏的單」——exitPolicy.ts
  // 檔頭就是為了修這個問題而存在的模擬器，所以在這裡走真實 K 線驗證，
  // 不能只信那個粗估的 ~5R。固定保本只守住進場價，峰值到保本之間那段
  // 完全沒保護；mfeGiveback 讓地板跟著峰值推進，最多回吐一半浮盈。
  v('保本改用半MFE動態地板', { mfeGiveback: 0.5 }),
];

// ── 工具 ────────────────────────────────────────────────────────
export function rollingAtr(candles: Candle[], period = 14): number[] {
  const tr: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prev = i > 0 ? candles[i - 1].close : c.open;
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev)));
  }
  const out: number[] = new Array(candles.length).fill(0);
  let sum = 0;
  for (let i = 0; i < tr.length; i++) {
    sum += tr[i];
    if (i >= period) sum -= tr[i - period];
    out[i] = i >= period - 1 ? sum / period : 0;
  }
  return out;
}

// 2026-09-24：原本以陣列長度對齊（`c.length % 4`），拼出來的 4H 棒不在 UTC 4H
// 邊界上，跟幣安真實 4H 不同；改用 liveReplica 的 UTC 對齊版本。名字保留給既有呼叫端。
export const derive4h = aggregate4h;

// 同一個 1H 陣列只拼一次 4H（regimeAt 會被逐根呼叫）
const fourHCache = new WeakMap<Candle[], FourHView>();
function fourHOf(c: Candle[]): FourHView {
  let v = fourHCache.get(c);
  if (!v) { v = makeFourHView(aggregate4h(c)); fourHCache.set(c, v); }
  return v;
}

/**
 * 無狀態的 regime 標籤（18-23 一律 transitional，沒有遲滯）。給只需要分類的
 * 呼叫端用；要重現線上進場請用 collectEntries（它有遲滯）。
 *
 * 2026-09-24 以前：門檻是 >25／<20（線上是 ≥23／≤18），而且註解寫「540 根 4H」
 * 實際切的是 540 根 1H → 只有 135 根 4H 餵給 ADX。現在只吃 T 時點已收盤的 4H，
 * 最多 540 根。
 */
export function regimeAt(c: Candle[], i: number): 'trending' | 'ranging' | 'transitional' {
  return regimeFromAdx(adx4hAt(fourHOf(c), c[i].closeTime + 1));
}

export interface Entry { symbol: string; sig: TradingSignal; idx: number }

/**
 * 重現線上 1H 進場：regime 遲滯、4H EMA200 bias 傳進 generateSignals、只有 1H 一個
 * 時框時的 confluence（4H 同向或中性才放行）。2026-09-24 以前 htfBias 傳 null、
 * 沒有遲滯也沒有 confluence——跑的是一個線上從來不會執行的進場集合。
 */
export function collectEntries(symbol: string, candles: Candle[]): Entry[] {
  const out: Entry[] = [];
  const v4 = fourHOf(candles);
  const tracker = new RegimeTracker();
  let lastEntryIdx = -Infinity;
  for (let i = WARMUP; i < candles.length - 1; i++) {
    const T = candles[i].closeTime + 1;
    const a = adx4hAt(v4, T);
    if (isNaN(a)) continue;
    const regime = tracker.next(a); // 遲滯狀態每根都推進，不能被冷卻跳過
    if (i - lastEntryIdx < ENTRY_COOLDOWN_BARS) continue;
    if (regime === 'transitional') continue;
    const w = candles.slice(Math.max(0, i - WINDOW_1H + 1), i + 1);
    let best: TradingSignal | undefined;
    if (regime === 'ranging') {
      best = generateMeanReversionSignals(symbol, '1h', w).filter(s => s.score >= MIN_SCORE_B)
        .sort((x, y) => y.score - x.score)[0];
    } else {
      const bias = ema200Bias(closes4hWithForming(v4, T, candles[i].close, 250));
      best = generateSignals(symbol, '1h', w, bias, regime).filter(s => s.tier || s.score >= MIN_SCORE_A)
        .sort((x, y) => y.score - x.score)[0];
      if (best && !(bias === null || bias === best.direction)) continue; // confluence
    }
    if (!best) continue;
    const slipped = best.direction === 'LONG' ? best.entry * (1 + SLIP) : best.entry * (1 - SLIP);
    out.push({ symbol, sig: { ...best, entry: slipped }, idx: i });
    lastEntryIdx = i;
  }
  return out;
}

export async function topSymbols(n: number): Promise<string[]> {
  const base = 'https://fapi.binance.com/fapi/v1';
  const [info, tick] = await Promise.all([
    axios.get(`${base}/exchangeInfo`).then(r => r.data),
    axios.get(`${base}/ticker/24hr`).then(r => r.data),
  ]);
  const perp = new Set<string>(
    (info.symbols as { symbol: string; status: string; contractType: string }[])
      .filter(s => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.symbol.endsWith('USDT'))
      .map(s => s.symbol));
  const EX = /^(USDC|BUSD|TUSD|USDP|FDUSD|DAI|EUR|GBP|AUD|BVOL|IBVOL|BEAR|BULL|UP|DOWN|3L|3S)/;
  return (tick as { symbol: string; quoteVolume: string }[])
    .filter(t => perp.has(t.symbol) && !EX.test(t.symbol.replace('USDT', '')))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, n).map(t => t.symbol);
}

async function main(): Promise<void> {
  const syms = await topSymbols(NSYM);
  console.log('='.repeat(70));
  console.log(`  出場政策比較  |  ${MONTHS} 個月  |  ${syms.length} 檔幣`);
  console.log(`  ${syms.map(s => s.replace('USDT', '')).join(' ')}`);
  console.log('='.repeat(70));

  // 每個政策一組 R 陣列，索引對齊同一筆進場（成對比較的前提）
  const rByPolicy = new Map<string, number[]>(POLICIES.map(p => [p.name, []]));
  const reasonByPolicy = new Map<string, Map<string, number>>(POLICIES.map(p => [p.name, new Map()]));
  let skippedOpen = 0;
  let neverFilled = 0;
  const baseNetR: number[] = []; // 基準政策扣手續費＋滑價後的 R（回答「賺不賺錢」用；政策比較仍用毛 R）

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

      // ── 先模擬掛單成交 ──
      // 訊號的 entry 是掛在現價下方（做多）等回調的**限價單**，不是市價。
      // 價格沒回到那個位置就不會成交，掛單逾期就取消。第一版沒模擬這段，
      // 假設每筆都以 entry 立刻成交——結果 299 筆只有 10 筆吃到止損（3%），
      // 而真實資料是 19/64（30%），每筆 +0.75R 對上真實的 +0.163R。
      // 原因就是「沒回調就跑掉」的單在真實世界是取消，在模擬裡卻變成
      // 「已經用更好的價格進場」直接獲利，把整個結果灌爆。
      // 真實資料的佐證：237 筆有訊號、只有 78 筆有結果，三分之二沒成交。
      //
      // 2026-09-24：改用 liveReplica 的共用版本，補上兩件事——
      //   成交前先碰到 TP1 → 取消（route.ts cancel_tp1_direct），以前會變成之後
      //     回調才成交的單；
      //   成交那一根若也碰到止損 → 判止損。以前出場從「成交的下一根」開始走，
      //     那一根被忽略，而限價單正是在回調時成交、那一根最容易順便打到止損。
      const lv = {
        entry: e.sig.entry, stopLoss: e.sig.stopLoss,
        tp1: e.sig.takeProfits[0], tp2: e.sig.takeProfits[1] ?? e.sig.takeProfits[0], isLong,
      };
      const fill = simulateFill(candles, e.idx, lv, false);
      if (fill.kind !== 'filled') { neverFilled++; continue; }
      if (candles.length - fill.idx < 30) continue; // 往後資料不足，任何政策都比不準

      const results = POLICIES.map(p => ({ p, o: simulateExitAfterFill(candles, atr, fill.idx, fill.price, lv, false, p, FORWARD_BARS) }));
      // 只要有任何一個政策沒走完，這筆就整批排除——成對比較必須每個政策
      // 都拿到同一批樣本，否則就是在比不同的東西。
      if (results.some(r => r.o === null)) { skippedOpen++; continue; }
      const riskPct = Math.abs(fill.price - lv.stopLoss) / fill.price;
      for (const { p, o } of results) {
        rByPolicy.get(p.name)!.push(o!.grossR);
        if (p.name === BASELINE.name) baseNetR.push(o!.grossR - tradeCostR(riskPct, false, o!.reason, o!.tp1Hit));
        const m = reasonByPolicy.get(p.name)!;
        m.set(o!.reason, (m.get(o!.reason) ?? 0) + 1);
      }
      used++;
    }
    console.log(`${entries.length} 個訊號 → 採用 ${used}`);
  }

  const baseR = rByPolicy.get(BASELINE.name)!;
  const n = baseR.length;
  console.log(`\n樣本：${n} 筆進場（另有 ${skippedOpen} 筆因往後資料不足被排除）`);
  if (n < 20) { console.log('樣本太少，不輸出比較。'); return; }

  const netOf = (a: number[]) => a.reduce((s, x) => s + x, 0);
  const f = (x: number, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d);

  console.log('\n' + '─'.repeat(70));
  console.log(`  基準：${BASELINE.name}   淨 ${f(netOf(baseR))}R   每筆 ${f(netOf(baseR) / n, 3)}R`);
  // 上面是毛 R（政策之間的成對比較不受成本影響，用毛 R 比較乾淨）。
  // 要回答「賺不賺錢」得看扣掉手續費＋滑價之後的這一列——未含資金費率，
  // 完整版見 scripts/verify-strategy.ts。
  console.log(`  　扣手續費＋滑價後：淨 ${f(netOf(baseNetR))}R   每筆 ${f(netOf(baseNetR) / (baseNetR.length || 1), 3)}R`);
  const bm = reasonByPolicy.get(BASELINE.name)!;
  console.log(`  出場分佈：${Array.from(bm.entries()).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k}=${c}`).join('  ')}`);
  console.log('─'.repeat(70));
  console.log('  對照政策（成對比較，t 是每筆差異的 t 值）\n');

  const rows = POLICIES.filter(p => p.name !== BASELINE.name).map(p => {
    const r = rByPolicy.get(p.name)!;
    return { name: p.name, net: netOf(r), cmp: pairedCompare(baseR, r) };
  }).sort((a, b) => b.cmp.meanDiff - a.cmp.meanDiff);

  for (const row of rows) {
    const mark = row.cmp.significant ? (row.cmp.meanDiff > 0 ? '★ 顯著較好' : '✗ 顯著較差') : '  分不出來';
    console.log(`  ${row.name.padEnd(22)} 淨 ${f(row.net).padStart(8)}R   每筆差 ${f(row.cmp.meanDiff, 3).padStart(7)}R ±${row.cmp.se.toFixed(3)}  t=${String(row.cmp.t).padStart(6)}  ${mark}`);
  }

  console.log('\n' + '─'.repeat(70));
  console.log('  判讀：|t| >= 2 才算分得出來。多數政策落在「分不出來」是正常的');
  console.log('  ——出場規則的差異本來就小，而且這個比較沒有模擬 symbol 鎖與');
  console.log('  同向上限，絕對數字不等於線上表現，只有政策之間的相對比較有效。');
  console.log('─'.repeat(70));
}

// 只有直接執行才跑 main——entry-compare.ts 要 import 上面的共用工具，
// 複製一份出去遲早會跟這裡分岔，而兩支腳本如果用不同的進場產生邏輯，
// 比較結果就沒有意義了。
const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(e => { console.error('exit-compare error:', e); process.exit(1); });
}
