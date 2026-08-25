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
import { adx } from '../src/analysis/indicators';
import { fetchHistorical } from './backtest';
import { simulateExit, pairedCompare, type ExitPolicyConfig, type ExitBar } from '../src/lib/exitPolicy';
import axios from 'axios';
import { pathToFileURL } from 'node:url';

const MONTHS = Math.max(1, parseInt(process.argv[2] ?? '3', 10));
const NSYM = Math.max(1, parseInt(process.argv[3] ?? '10', 10));

const WARMUP = 250;
const WINDOW_1H = 200;
const WINDOW_4H = 540;
// 2026-08-26：對齊 route.ts 的 STRONG_THRESHOLD(65) / STRONG_THRESHOLD_B(13)。
// 原本是 70/10，跟線上不符——65-70 那一格在真實資料裡是最賠的區間，
// 用 70 等於把最差的一段排除掉，基準線會偏樂觀。見 backtest.ts 同名常數說明。
const MIN_SCORE_A = 65;
const MIN_SCORE_B = 13;
const SLIP = 0.0003;
// 進場冷卻：同一檔幣在這麼多根之內不重複進場。用來近似線上的 symbol 鎖，
// 但**不依賴出場時間**——依賴的話成對比較就破功了（見檔頭說明 1）。
const ENTRY_COOLDOWN_BARS = 24;
// 每筆訊號往後看的最大根數。要夠長才不會讓「讓贏家跑久一點」的政策被
// 資料長度截斷（那會系統性低估它們）。
export const FORWARD_BARS = 200;
// 掛單等待成交的窗口。route.ts 的 WAITING_EXPIRY_HOURS = 8（1h K 線 → 8 根），
// 超過就取消——這是三分之二訊號從未成交的來源。
export const WAIT_BARS = 8;

// ── 線上實際參數（照抄，不是重新設計）──────────────────────────
//   TP1_PARTIAL_FRACTION = 0.5          monitorMath.ts
//   PRE_TP1_BREAKEVEN_TRIGGER_R = 0.5   tradeBridge.ts / route.ts
//   移動止損 = markPrice ∓ 2 × ATR(1h)   orderLifecycle.ts calcTrailingStopTarget
//   盤整停滯 = 滿 8 根且進度在 ±0.3R      engine/timeStop.ts
//   到期平倉 = 24h（1h K 線 → 24 根）     route.ts INTRADAY_CLOSE_HOURS
export const BASELINE: ExitPolicyConfig = {
  name: '現況（線上）', tp1Fraction: 0.5, breakevenAtR: 0.5, trailAtrMult: 2,
  stallBars: 8, stallBandR: 0.3, maxBars: 24,
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

export function derive4h(c: Candle[]): Candle[] {
  const out: Candle[] = [];
  const rem = c.length % 4;
  for (let i = rem === 0 ? 0 : rem; i + 3 < c.length; i += 4) {
    const g = c.slice(i, i + 4);
    out.push({
      openTime: g[0].openTime, open: g[0].open,
      high: Math.max(...g.map(x => x.high)), low: Math.min(...g.map(x => x.low)),
      close: g[3].close, volume: g.reduce((s, x) => s + x.volume, 0), closeTime: g[3].closeTime,
    });
  }
  return out;
}

export function regimeAt(c: Candle[], i: number): 'trending' | 'ranging' | 'transitional' {
  const s = Math.max(0, i - WINDOW_4H + 1);
  const { adx: a } = adx(derive4h(c.slice(s, i + 1)), 14);
  if (isNaN(a)) return 'ranging';
  if (a > 25) return 'trending';
  if (a < 20) return 'ranging';
  return 'transitional';
}

export interface Entry { symbol: string; sig: TradingSignal; idx: number }

export function collectEntries(symbol: string, candles: Candle[]): Entry[] {
  const out: Entry[] = [];
  let lastEntryIdx = -Infinity;
  for (let i = WARMUP; i < candles.length - 1; i++) {
    if (i - lastEntryIdx < ENTRY_COOLDOWN_BARS) continue;
    const regime = regimeAt(candles, i);
    if (regime === 'transitional') continue;
    const w = candles.slice(Math.max(0, i - WINDOW_1H + 1), i + 1);
    const sigs = regime === 'ranging'
      ? generateMeanReversionSignals(symbol, '1h', w).filter(s => s.score >= MIN_SCORE_B)
      : generateSignals(symbol, '1h', w, null, regime).filter(s => s.score >= MIN_SCORE_A);
    const best = sigs.sort((a, b) => b.score - a.score)[0];
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
      const fwd = candles.slice(e.idx + 1, e.idx + 1 + FORWARD_BARS);

      // ── 先模擬掛單成交 ──
      // 訊號的 entry 是掛在現價下方（做多）等回調的**限價單**，不是市價。
      // 價格沒回到那個位置就不會成交，掛單逾期就取消。第一版沒模擬這段，
      // 假設每筆都以 entry 立刻成交——結果 299 筆只有 10 筆吃到止損（3%），
      // 而真實資料是 19/64（30%），每筆 +0.75R 對上真實的 +0.163R。
      // 原因就是「沒回調就跑掉」的單在真實世界是取消，在模擬裡卻變成
      // 「已經用更好的價格進場」直接獲利，把整個結果灌爆。
      // 真實資料的佐證：237 筆有訊號、只有 78 筆有結果，三分之二沒成交。
      let fillIdx = -1;
      for (let k = 0; k < Math.min(WAIT_BARS, fwd.length); k++) {
        const c = fwd[k];
        if (isLong ? c.low <= e.sig.entry : c.high >= e.sig.entry) { fillIdx = k; break; }
      }
      if (fillIdx < 0) { neverFilled++; continue; }

      const bars: ExitBar[] = fwd.slice(fillIdx + 1).map(c => ({ high: c.high, low: c.low, close: c.close }));
      const a = atr.slice(e.idx + 1 + fillIdx + 1, e.idx + 1 + FORWARD_BARS);
      if (bars.length < 30) continue; // 往後資料不足，任何政策都比不準

      const input = {
        entry: e.sig.entry, stopLoss: e.sig.stopLoss,
        tp1: e.sig.takeProfits[0], tp2: e.sig.takeProfits[1] ?? e.sig.takeProfits[0],
        isLong, bars, atr: a,
      };
      const results = POLICIES.map(p => ({ p, o: simulateExit(input, p) }));
      // 只要有任何一個政策沒走完，這筆就整批排除——成對比較必須每個政策
      // 都拿到同一批樣本，否則就是在比不同的東西。
      if (results.some(r => r.o.reason === 'open')) { skippedOpen++; continue; }
      for (const { p, o } of results) {
        rByPolicy.get(p.name)!.push(o.r);
        const m = reasonByPolicy.get(p.name)!;
        m.set(o.reason, (m.get(o.reason) ?? 0) + 1);
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
