#!/usr/bin/env npx tsx
/**
 * 策略獲利能力驗證 —— 回答「這套策略扣掉成本之後到底能不能賺錢」。
 *
 *   npx tsx scripts/verify-strategy.ts [MONTHS] [SYMBOL_COUNT]
 *   npx tsx scripts/verify-strategy.ts 12 15
 *   ENV_FILE=env.txt npx tsx scripts/verify-strategy.ts   # 另外對照真實成交
 *
 * 三個階段，順序是刻意的：
 *
 *   1. 量測工具先驗（檢查清單）
 *      這個專案抓過七個以上的量測錯誤，每一個在被抓到前都長得像結論。所以
 *      在相信任何回測數字之前，先檢查「既有回測腳本跟線上實際行為對不對得
 *      上」、「線上程式碼有沒有跟策略設計不一致的地方」。檢查結果只列出，
 *      不在這裡修——修是另外一步。
 *
 *   2. 貼齊線上規則的逐根模擬
 *      進場：regime（4H ADX 23/18 遲滯）→ 策略 A（1H，含 4H EMA200 bias 與
 *      confluence）或策略 B（1H 均值回歸，連兩敗暫停）→ funding 擁擠扣分 →
 *      BTC 大盤方向／混沌／急動暫停 → 虧損冷卻 → bias 保留 → 6h 訊號冷卻 →
 *      同幣同時只有一筆。掛單 4 根未成交或先碰到 TP1 就取消；分數夠高且 4H
 *      確認時市價進場（marketEntryException）。
 *      出場：直接用 src/lib/exitPolicy.ts 的 simulateExit 跑線上參數
 *      （TP1 50% 部分停利、0.5R 保本、2×ATR 移動止損、8 根 ±0.3R 停滯、24h 到期），
 *      同根 TP/SL 判 SL（悲觀）。成交那一根若也碰到止損，判止損（悲觀）。
 *      成本：Maker 0.02%／Taker 0.05%、進場滑價 0.03%、止損滑價 0.05%、
 *      持倉期間的真實資金費率。全部換算成 R。
 *
 *   3. 統計判讀
 *      平均淨 R、t 值、bootstrap 95% 信賴區間、前後半段穩定性、成本拆解、
 *      複利曲線、偵測所需樣本數；有金鑰時再拿幣安真實成交（audit-exits 報告）
 *      對照。
 *
 * ── 沒有模擬的部分（結論的適用範圍）──
 *   - 5m/15m 多時框（15m 短線單、agreeTFs≥2 的 confluence 路徑）。線上 98% 的單
 *     是 1h，這裡只模擬 1h 進場時框。
 *   - 組合層級的關卡：熔斷、回撤停機、日虧損上限、同向風險上限、總風險 5%。
 *     這些只會「少做幾筆」，不會把沒有邊際的訊號變成有邊際。
 *   - 幣種是用「今天」的成交量前 N 名回頭測（倖存者偏誤），偏向高估。
 */

import axios from 'axios';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Candle, TradingSignal } from '../src/types';
import { generateSignals, generateMeanReversionSignals } from '../src/analysis/signals';
import { adx, ema } from '../src/analysis/indicators';
import { applyFundingRateCrowdingPenalty } from '../src/lib/monitorMath';
import { shouldEnterAtMarket, shiftSignalToMarketEntry } from '../src/lib/marketEntryException';
import { closedCandlesOnly } from '../src/lib/signalCache';
import { BASELINE, rollingAtr, derive4h as exitCompareDerive4h, WAIT_BARS as EXIT_COMPARE_WAIT_BARS } from './exit-compare';
import {
  H, H4, LIVE, makeFourHView, adx4hAt, RegimeTracker, closes4hWithForming, ema200Bias,
  simulateFill, simulateExitAfterFill, tradeCostR, type FourHView,
} from './lib/liveReplica';

const MONTHS = Math.max(1, parseInt(process.argv[2] ?? '12', 10));
const NSYM = Math.max(1, parseInt(process.argv[3] ?? '15', 10));

const WARMUP_1H = 250;
const WINDOW_1H = 200;

// ════════════════════════════════════════════════════════════════════
// 資料抓取（磁碟快取，重跑不必再打幣安）
// ════════════════════════════════════════════════════════════════════
const CACHE_DIR = join(tmpdir(), 'verify-strategy-cache');
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
const api = axios.create({ baseURL: 'https://fapi.binance.com/fapi/v1', timeout: 20_000 });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function getJson<T>(path: string, params: Record<string, unknown>): Promise<T> {
  for (let a = 0; a < 4; a++) {
    try { return (await api.get(path, { params })).data as T; }
    catch (e) { if (a === 3) throw e; await sleep(1000 * (a + 1)); }
  }
  throw new Error('unreachable');
}

async function fetchKlines(symbol: string, interval: '1h' | '4h', startMs: number, endMs: number): Promise<Candle[]> {
  const day = Math.floor(endMs / 86_400_000);
  const file = join(CACHE_DIR, `${symbol}-${interval}-${startMs}-${day}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf-8'));
  const step = interval === '1h' ? H : H4;
  const out: Candle[] = [];
  let from = startMs;
  while (from < endMs) {
    const rows = await getJson<unknown[][]>('/klines', { symbol, interval, startTime: from, limit: 1500 });
    if (!rows.length) break;
    for (const k of rows) {
      const c: Candle = {
        openTime: k[0] as number, open: +(k[1] as string), high: +(k[2] as string), low: +(k[3] as string),
        close: +(k[4] as string), volume: +(k[5] as string), closeTime: k[6] as number,
      };
      if (c.closeTime < endMs) out.push(c); // 只收已收盤的
    }
    from = (rows[rows.length - 1][0] as number) + step;
    if (rows.length < 1500) break;
    await sleep(200);
  }
  const seen = new Set<number>();
  const dedup = out.filter(c => (seen.has(c.openTime) ? false : (seen.add(c.openTime), true)));
  writeFileSync(file, JSON.stringify(dedup), { encoding: 'utf-8' });
  return dedup;
}

interface Funding { t: number; rate: number }
async function fetchFunding(symbol: string, startMs: number, endMs: number): Promise<Funding[]> {
  const day = Math.floor(endMs / 86_400_000);
  const file = join(CACHE_DIR, `${symbol}-funding-${startMs}-${day}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf-8'));
  const out: Funding[] = [];
  let from = startMs;
  while (from < endMs) {
    const rows = await getJson<{ fundingTime: number; fundingRate: string }[]>('/fundingRate', { symbol, startTime: from, limit: 1000 });
    if (!rows.length) break;
    for (const r of rows) out.push({ t: r.fundingTime, rate: +r.fundingRate });
    from = rows[rows.length - 1].fundingTime + 1;
    if (rows.length < 1000) break;
    await sleep(200);
  }
  writeFileSync(file, JSON.stringify(out), { encoding: 'utf-8' });
  return out;
}

async function topSymbols(n: number): Promise<string[]> {
  const [info, tick] = await Promise.all([
    getJson<{ symbols: { symbol: string; status: string; contractType: string }[] }>('/exchangeInfo', {}),
    getJson<{ symbol: string; quoteVolume: string }[]>('/ticker/24hr', {}),
  ]);
  const perp = new Set(info.symbols
    .filter(s => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.symbol.endsWith('USDT'))
    .map(s => s.symbol));
  const EX = /^(USDC|BUSD|TUSD|USDP|FDUSD|DAI|EUR|GBP|AUD|BVOL|IBVOL|BEAR|BULL|UP|DOWN|3L|3S)/;
  return tick
    .filter(t => perp.has(t.symbol) && !EX.test(t.symbol.replace('USDT', '')))
    .sort((a, b) => +b.quoteVolume - +a.quoteVolume)
    .slice(0, n).map(t => t.symbol);
}

// ════════════════════════════════════════════════════════════════════
// 階段 1：量測工具先驗
// ════════════════════════════════════════════════════════════════════
type Severity = '🔴' | '🟡' | 'ℹ️';
interface Issue { id: string; sev: Severity; where: string; what: string; evidence: string }
const issues: Issue[] = [];
const issue = (i: Issue) => issues.push(i);
const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const num = (text: string, re: RegExp): number | null => { const m = text.match(re); return m ? Number(m[1]) : null; };

function checkConstants(): void {
  const route = src('src/app/api/analyze/route.ts');
  const bridge = src('src/engine/tradeBridge.ts');
  const live = {
    STRONG_THRESHOLD: num(route, /const STRONG_THRESHOLD\s*=\s*(\d+)/),
    STRONG_THRESHOLD_B: num(route, /const STRONG_THRESHOLD_B\s*=\s*(\d+)/),
    WAITING_EXPIRY_BARS: num(route, /const WAITING_EXPIRY_BARS\s*=\s*(\d+)/),
    WAITING_EXPIRY_BARS_BRIDGE: num(bridge, /const WAITING_EXPIRY_BARS\s*=\s*(\d+)/),
    INTRADAY_CLOSE_HOURS: num(route, /const INTRADAY_CLOSE_HOURS\s*=\s*(\d+)/),
    PRE_TP1_BREAKEVEN_TRIGGER_R: num(route, /const PRE_TP1_BREAKEVEN_TRIGGER_R\s*=\s*([\d.]+)/),
    ADX_TREND: num(route, /symbolAdx >= (\d+)\)\s*symbolRegime = 'trending'/),
    ADX_RANGE: num(route, /symbolAdx <= (\d+)\)\s*symbolRegime = 'ranging'/),
  };
  // 本腳本自己用的值必須跟線上一致——否則下面的模擬本身就是錯的
  for (const k of Object.keys(LIVE) as (keyof typeof LIVE)[]) {
    const v = (live as Record<string, number | null>)[k];
    if (v != null && v !== LIVE[k]) {
      issue({ id: 'V0', sev: '🔴', where: 'scripts/verify-strategy.ts', what: `本腳本的 ${k}=${LIVE[k]} 與線上 ${v} 不符`, evidence: 'route.ts 原始碼' });
    }
  }
  if (live.WAITING_EXPIRY_BARS_BRIDGE !== live.WAITING_EXPIRY_BARS) {
    issue({ id: 'C0', sev: '🔴', where: 'src/engine/tradeBridge.ts', what: `真倉與 DB 模擬的掛單有效根數不同（${live.WAITING_EXPIRY_BARS_BRIDGE} vs ${live.WAITING_EXPIRY_BARS}）`, evidence: '兩處常數' });
  }

  // 既有回測工具的參數
  const bt = src('scripts/backtest.ts');
  const ec = src('scripts/exit-compare.ts');
  // 引用共用的 LIVE 常數就等於跟線上一致（LIVE 本身在上面已對過 route.ts）
  const btA = /const MIN_SCORE_A\s*=\s*LIVE\.STRONG_THRESHOLD\b/.test(bt) ? LIVE.STRONG_THRESHOLD : num(bt, /const MIN_SCORE_A\s*=\s*(\d+)/);
  const btB = /const MIN_SCORE_B\s*=\s*LIVE\.STRONG_THRESHOLD_B\b/.test(bt) ? LIVE.STRONG_THRESHOLD_B : num(bt, /const MIN_SCORE_B\s*=\s*(\d+)/);
  if (btA !== live.STRONG_THRESHOLD || btB !== live.STRONG_THRESHOLD_B) {
    issue({ id: 'B1', sev: '🔴', where: 'scripts/backtest.ts', what: `分數門檻 ${btA}/${btB} ≠ 線上 ${live.STRONG_THRESHOLD}/${live.STRONG_THRESHOLD_B}`, evidence: 'MIN_SCORE_A/B' });
  }
  const ecWait = EXIT_COMPARE_WAIT_BARS;
  if (ecWait !== live.WAITING_EXPIRY_BARS) {
    issue({ id: 'B2', sev: '🔴', where: 'scripts/exit-compare.ts WAIT_BARS', what: `掛單等待 ${ecWait} 根，線上是 ${live.WAITING_EXPIRY_BARS} 根（route.ts 與 tradeBridge.ts 的 WAITING_EXPIRY_BARS）`, evidence: `WAIT_BARS=${ecWait}。多給一倍時間成交，會把「沒回調就跑掉」的單算成成交` });
  }
  for (const [file, text] of [['scripts/backtest.ts', bt], ['scripts/exit-compare.ts', ec]] as const) {
    if (/adxVal > 25|a > 25/.test(text) && live.ADX_TREND === 23) {
      issue({ id: 'B3', sev: '🔴', where: `${file} regime`, what: `regime 用 ADX >25 / <20 且沒有遲滯；線上是 ≥${live.ADX_TREND} / ≤${live.ADX_RANGE} 加遲滯（18-23 沿用前一狀態）`, evidence: '線上 transitional 只在沒有前一狀態時才出現；回測在 20-25 之間一律不交易，丟掉大量線上會做的單' });
    }
    if (/i - WINDOW_4H \+ 1/.test(text)) {
      issue({ id: 'B10', sev: '🟡', where: `${file} regime 視窗`, what: 'WINDOW_4H=540 註解說是「540 根 4H（90 天）」，實際切的是 540 根 1H → 只有 135 根 4H 餵給 ADX', evidence: '線上 ADX 吃 540 根 4H；Wilder 平滑的起點不同，ADX 值與 regime 判定跟著偏' });
    }
    if (/generateSignals\([^)]*,\s*null\s*,/.test(text)) {
      issue({ id: 'B4', sev: '🔴', where: `${file} generateSignals`, what: '傳入 htfBias=null；線上傳入 4H EMA200 方向，且逆 4H 方向的 1H 單會被 confluence 擋掉', evidence: 'route.ts HTF_MAP 1h→4h；htfBias 影響評分與 confluenceMet' });
    }
  }

  // 出場模型
  if (/exitPrice = tp1; result = 'WIN_TP1'/.test(bt)) {
    issue({ id: 'B5', sev: '🔴', where: 'scripts/backtest.ts runBacktest', what: '碰到 TP1 就全部平倉，同根 TP1+SL 判 TP1 贏；沒有 50% 部分停利、保本、移動止損、停滯／24h 到期，進場也不是限價掛單', evidence: 'npm run backtest 量到的是另一個策略，而且同根判定是樂觀的' });
  }
  for (const file of ['scripts/exit-compare.ts', 'scripts/stop-distance-compare.ts', 'scripts/entry-compare.ts']) {
    const text = src(file);
    if (/fwd\.slice\(fillIdx \+ 1\)/.test(text) && !/fillBarStop/.test(text)) {
      issue({ id: 'B6', sev: '🔴', where: `${file} 成交後出場`, what: '出場模擬從「成交的下一根」開始，成交那一根若也碰到止損會被忽略', evidence: '限價單是在回調時成交的，成交那根正是最容易順便打到止損的一根——系統性樂觀' });
    }
  }
  if (!/cancel_tp1_direct|直接到達 TP1|tp1Direct|simulateFill\(/i.test(ec)) {
    issue({ id: 'B7', sev: '🟡', where: 'scripts/exit-compare.ts 掛單模擬', what: '沒模擬「成交前先碰到 TP1 → 取消」（route.ts cancel_tp1_direct）', evidence: '這類單在線上是取消，在回測裡會變成之後回調才成交的單' });
  }
  if (!/FEE|fee|手續費/.test(ec)) {
    issue({ id: 'B8', sev: '🟡', where: 'scripts/exit-compare.ts / src/lib/exitPolicy.ts', what: '回報的 R 未扣手續費、滑價、資金費率', evidence: '做政策之間的成對比較沒關係，但不能拿來回答「賺不賺錢」' });
  }
}

/**
 * 形成中 K 棒 × 訊號快取。
 *
 * fetchCandles 回傳的最後一根是還在跑的 K 棒；generateSignals 的 price／RSI／BB／
 * EMA 都吃到它。但 signalCache 的命中條件是「最後一根的 openTime 沒變」——
 * 所以每小時第一次掃描（那根才開幾分鐘）算出的訊號會被凍結一整小時。
 * regimeCache 的 is4hBarUnchanged 是同一個形狀（4H ADX 被凍結 4 小時）。
 *
 * 這裡用真實 K 線實測：同一個小時，「開盤 3 分鐘」與「收盤前」兩種形成中
 * K 棒狀態，generateSignals 給的答案有多少比例不同。不同 = 快取命中時沿用的
 * 是錯的答案。
 */
function checkFormingBarCache(sample1h: Candle[], sample4h: Candle[]): void {
  const route = src('src/app/api/analyze/route.ts');
  const future = Date.now() + 10 * H;
  const mkForming = (c: Candle, early: boolean): Candle => early
    ? { ...c, high: c.open, low: c.open, close: c.open, volume: c.volume * 0.05, closeTime: future }
    : { ...c, closeTime: future };

  const key = (s: TradingSignal[]) => s.map(x => `${x.direction}|${x.score}|${x.entry.toFixed(8)}|${x.stopLoss.toFixed(8)}`).join(';');
  const guarded = /closedCandlesOnly\(/.test(route);
  let tested = 0, differs = 0, lateOnly = 0;
  for (let i = WINDOW_1H + 10; i < sample1h.length; i += 7) {
    const base = sample1h.slice(i - WINDOW_1H, i);
    const bar = sample1h[i];
    const prep = (w: Candle[]) => guarded ? closedCandlesOnly(w, Date.now()) : w;
    const early = prep([...base, mkForming(bar, true)]);
    const late = prep([...base, mkForming(bar, false)]);
    const a = generateSignals('X', '1h', early, null, 'trending');
    const b = generateSignals('X', '1h', late, null, 'trending');
    const ra = generateMeanReversionSignals('X', '1h', early);
    const rb = generateMeanReversionSignals('X', '1h', late);
    tested++;
    if (key(a) !== key(b) || key(ra) !== key(rb)) differs++;
    if ((a.length === 0 && b.length > 0) || (ra.length === 0 && rb.length > 0)) lateOnly++;
  }
  if (differs > 0) {
    issue({
      id: 'L1', sev: '🔴', where: 'src/app/api/analyze/route.ts + src/lib/signalCache.ts',
      what: '訊號在形成中 K 棒上計算，而快取以該 K 棒 openTime 為 key → 每小時第一次掃描（K 棒才開幾分鐘）的結果被沿用整小時',
      evidence: `真實 K 線 ${tested} 個時點中 ${differs} 個（${(100 * differs / tested).toFixed(1)}%）「開盤 3 分鐘」與「收盤前」訊號不同；其中 ${lateOnly} 個是收盤時才有訊號、開盤時沒有（線上永遠看不到）。快取檔頭宣稱「K 棒沒變就是 byte-identical」不成立`,
    });
  }

  // regimeCache：4H ADX 同樣的問題
  const guarded4h = /closedCandlesOnly\(fourHC|closedCandlesOnly\(candleCache\.get\('4h'\)/.test(route);
  let t4 = 0, flip4 = 0;
  for (let i = 100; i < sample4h.length; i += 3) {
    const base = sample4h.slice(Math.max(0, i - 540), i);
    const bar = sample4h[i];
    const prep = (w: Candle[]) => guarded4h ? closedCandlesOnly(w, Date.now()) : w;
    const reg = (x: number) => (x >= LIVE.ADX_TREND ? 'T' : x <= LIVE.ADX_RANGE ? 'R' : 'M');
    const e = adx(prep([...base, mkForming(bar, true)]), 14).adx;
    const l = adx(prep([...base, mkForming(bar, false)]), 14).adx;
    t4++;
    if (reg(e) !== reg(l)) flip4++;
  }
  if (flip4 > 0) {
    issue({
      id: 'L2', sev: '🟡', where: 'src/app/api/analyze/route.ts regime + src/lib/regimeCache.ts',
      what: '4H ADX 含形成中 K 棒且被快取 4 小時 → regime 由「4H 棒開盤幾分鐘時」的狀態決定',
      evidence: `${t4} 個時點中 ${flip4} 個（${(100 * flip4 / t4).toFixed(1)}%）開盤 vs 收盤前落在不同 regime 區間`,
    });
  }
}

function checkDerive4hAlignment(c1h: Candle[]): void {
  // 用非 4 整除的長度切一段，模擬 backtest/exit-compare 呼叫時的樣子
  for (const cut of [1, 2, 3]) {
    const d = exitCompareDerive4h(c1h.slice(cut, cut + 540));
    const bad = d.filter(x => x.openTime % H4 !== 0).length;
    if (bad > 0) {
      issue({ id: 'B9', sev: '🟡', where: 'scripts/exit-compare.ts / backtest.ts derive4h', what: '從 1H 拼 4H 時以陣列長度對齊而非 UTC 4H 邊界，拼出的 4H 棒與幣安真實 4H 不同', evidence: `切點偏移 ${cut} 時 ${bad}/${d.length} 根 4H 棒開盤時間不在 4H 邊界上` });
      return;
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// 階段 2：模擬
// ════════════════════════════════════════════════════════════════════
interface SimTrade {
  symbol: string; strategy: 'A' | 'B'; direction: 'LONG' | 'SHORT';
  signalTime: number; fillTime: number; market: boolean;
  grossR: number; feeR: number; fundingR: number; netR: number;
  reason: string; riskPct: number; score: number; fillBarStop: boolean;
}
interface Counters { signals: number; expired: number; tp1Direct: number; gated: Record<string, number> }

interface BtcCtx { regimeAt: Map<number, 'bullish' | 'bearish' | 'chaotic'>; pauseLongUntil: number[]; pauseShortUntil: number[]; times: number[] }

function buildBtcContext(c1: Candle[], v4: FourHView): BtcCtx {
  const regimeAt = new Map<number, 'bullish' | 'bearish' | 'chaotic'>();
  const pl: number[] = [], ps: number[] = [], times: number[] = [];
  let longUntil = 0, shortUntil = 0;
  for (let i = 0; i < c1.length; i++) {
    const T = c1[i].closeTime + 1;
    times.push(T);
    if (i >= WARMUP_1H) {
      const closes = closes4hWithForming(v4, T, c1[i].close, 250);
      const e50 = ema(closes, 50), e200 = ema(closes, 200);
      const a = e50[e50.length - 1], b = e200[e200.length - 1], px = closes[closes.length - 1];
      let r: 'bullish' | 'bearish' | 'chaotic' = 'chaotic';
      if (closes.length >= 200 && !isNaN(a) && !isNaN(b)) {
        if (a > b && px > a) r = 'bullish';
        else if (a < b && px < a) r = 'bearish';
      }
      regimeAt.set(T, r);
    }
    if (i >= 15) {
      const w = c1.slice(Math.max(0, i - 19), i + 1);
      const last4 = w.slice(-4);
      const chg = (last4[3].close - last4[0].close) / last4[0].close;
      let atr = 0, n = 0;
      for (let k = Math.max(1, w.length - 14); k < w.length; k++) {
        atr += Math.max(w[k].high - w[k].low, Math.abs(w[k].high - w[k - 1].close), Math.abs(w[k].low - w[k - 1].close)); n++;
      }
      const th = (2.5 * atr / n) / w[w.length - 1].close;
      if (chg < -th) longUntil = T + LIVE.BTC_PAUSE_H * H;
      if (chg > th) shortUntil = T + LIVE.BTC_PAUSE_H * H;
    }
    pl.push(longUntil); ps.push(shortUntil);
  }
  return { regimeAt, pauseLongUntil: pl, pauseShortUntil: ps, times };
}

function fundingBetween(f: Funding[], a: number, b: number): number {
  let s = 0;
  for (const x of f) if (x.t > a && x.t <= b) s += x.rate;
  return s;
}
function fundingAt(f: Funding[], T: number): number {
  let r = 0;
  for (const x of f) { if (x.t <= T) r = x.rate; else break; }
  return r;
}

function simulateSymbol(
  symbol: string, c1: Candle[], c4: Candle[], funding: Funding[], btc: BtcCtx | null, cnt: Counters,
): SimTrade[] {
  const trades: SimTrade[] = [];
  const v4 = makeFourHView(c4);
  const atr = rollingAtr(c1);
  const btcIdx = btc ? new Map(btc.times.map((t, k) => [t, k])) : null;
  const isLargeCap = symbol === 'BTCUSDT' || symbol === 'ETHUSDT';

  const tracker = new RegimeTracker();
  let busyUntilIdx = -1;          // 同幣同時只有一筆（掛單或持倉）
  let lastSignalT = -Infinity;    // 6h 訊號冷卻
  const lossCd: Record<'LONG' | 'SHORT', number> = { LONG: 0, SHORT: 0 };
  let biasHold: { dir: 'LONG' | 'SHORT'; until: number } | null = null;
  const bResults: { t: number; loss: boolean }[] = [];
  const gate = (k: string) => { cnt.gated[k] = (cnt.gated[k] ?? 0) + 1; };

  for (let i = WARMUP_1H; i < c1.length - 1; i++) {
    const T = c1[i].closeTime + 1;

    // regime：只用已收盤 4H（修正後的語意；見 L2）。遲滯狀態每根都要推進，不能被 busy 跳過。
    const a = adx4hAt(v4, T);
    if (isNaN(a)) continue;
    const regime = tracker.next(a);

    if (i <= busyUntilIdx) continue;
    if (regime === 'transitional') continue;

    const w = c1.slice(i - WINDOW_1H + 1, i + 1);
    const recentB = bResults.slice(-2);
    const bPaused = recentB.length === 2 && recentB.every(r => r.loss) && T - recentB[1].t <= LIVE.STRAT_B_PAUSE_H * H;

    let sig: TradingSignal | undefined;
    let bias: 'LONG' | 'SHORT' | null = null;
    const fr = fundingAt(funding, T);
    if (regime === 'ranging' && !bPaused) {
      sig = generateMeanReversionSignals(symbol, '1h', w)
        .map(s => ({ ...s, score: applyFundingRateCrowdingPenalty(s.score, s.direction, fr) }))
        .filter(s => s.score >= LIVE.STRONG_THRESHOLD_B)
        .sort((x, y) => y.score - x.score)[0];
    } else {
      bias = ema200Bias(closes4hWithForming(v4, T, c1[i].close, 250));
      sig = generateSignals(symbol, '1h', w, bias, regime)
        .map(s => ({ ...s, score: applyFundingRateCrowdingPenalty(s.score, s.direction, fr) }))
        .filter(s => s.tier ? true : s.score >= LIVE.STRONG_THRESHOLD)
        .sort((x, y) => y.score - x.score)[0];
      // confluence（只有 1h 一個時框：agreeTFs=1 → 需 4H 同向或 4H 中性）
      if (sig && !(bias === sig.direction || bias === null)) { gate('confluence'); continue; }
    }
    if (!sig) continue;
    cnt.signals++;

    const dir = sig.direction;
    if (T - lastSignalT < LIVE.COOLDOWN_H * H) { gate('cooldown'); continue; }
    if (!isLargeCap && btc && btcIdx) {
      const bi = btcIdx.get(T);
      const br = btc.regimeAt.get(T) ?? 'chaotic';
      if (br === 'bullish' && dir === 'SHORT') { gate('btc_direction'); continue; }
      if (br === 'bearish' && dir === 'LONG') { gate('btc_direction'); continue; }
      if (br === 'chaotic' && sig.strategy !== 'B') { gate('btc_chaos'); continue; }
      if (bi != null && ((dir === 'LONG' && btc.pauseLongUntil[bi] > T) || (dir === 'SHORT' && btc.pauseShortUntil[bi] > T))) { gate('btc_pause'); continue; }
    }
    if (lossCd[dir] > T) { gate('loss_cooldown'); continue; }
    if (biasHold && biasHold.until > T && biasHold.dir !== dir) { gate('bias_hold'); continue; }

    lastSignalT = T;
    const isLong = dir === 'LONG';
    const stratB = sig.strategy === 'B';
    let entry = sig.entry, stop = sig.stopLoss, tps = sig.takeProfits;
    const market = shouldEnterAtMarket(sig, LIVE.STRONG_THRESHOLD + 10, bias === dir);
    if (market) {
      const s = shiftSignalToMarketEntry(sig);
      entry = s.entry; stop = s.stopLoss; tps = s.takeProfits;
    }
    const lv = { entry, stopLoss: stop, tp1: tps[0], tp2: tps[1] ?? tps[0], isLong };

    const fill = simulateFill(c1, i, lv, market);
    if (fill.kind !== 'filled') {
      if (fill.kind === 'tp1_direct') cnt.tp1Direct++; else cnt.expired++;
      biasHold = { dir, until: T + LIVE.BIAS_HOLD_BARS * H };
      busyUntilIdx = i + LIVE.WAITING_EXPIRY_BARS;
      continue;
    }
    const risk = Math.abs(fill.price - stop);
    if (risk <= 0) continue;
    const riskPct = risk / fill.price;
    const ex = simulateExitAfterFill(c1, atr, fill.idx, fill.price, lv, market, BASELINE);
    if (!ex) break; // 資料尾端，後面都不完整

    // ── 成本（佔名目的比例 → 除以風險比例換成 R）──
    const feeR = tradeCostR(riskPct, market, ex.reason, ex.tp1Hit);
    const fund = fundingBetween(funding, c1[fill.idx].closeTime, c1[ex.exitIdx].closeTime);
    const remainFrac = ex.tp1Hit ? 0.75 : 1; // 粗估：TP1 後只剩一半部位付資金費
    const fundingR = (isLong ? -fund : fund) * remainFrac / riskPct;
    const netR = ex.grossR - feeR + fundingR;

    trades.push({
      symbol, strategy: stratB ? 'B' : 'A', direction: dir, signalTime: T, fillTime: c1[fill.idx].closeTime,
      market, grossR: ex.grossR, feeR, fundingR, netR, reason: ex.reason, riskPct, score: sig.score,
      fillBarStop: ex.fillBarStop,
    });
    busyUntilIdx = ex.exitIdx;
    const closeT = c1[ex.exitIdx].closeTime + 1;
    if (ex.reason === 'stop') lossCd[dir] = closeT + LIVE.LOSS_COOLDOWN_H * H;
    if (ex.reason === 'stall' || ex.reason === 'expiry') {
      lossCd.LONG = Math.max(lossCd.LONG, closeT + LIVE.TIME_STOP_COOLDOWN_H * H);
      lossCd.SHORT = Math.max(lossCd.SHORT, closeT + LIVE.TIME_STOP_COOLDOWN_H * H);
    }
    if (stratB) bResults.push({ t: closeT, loss: ex.reason === 'stop' });
  }
  return trades;
}

// ════════════════════════════════════════════════════════════════════
// 階段 3：統計
// ════════════════════════════════════════════════════════════════════
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const f = (x: number, d = 3) => (x >= 0 ? '+' : '') + x.toFixed(d);

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function bootstrapCI(a: number[], iters = 10_000): [number, number] {
  if (a.length < 2) return [NaN, NaN];
  const r = rng(42);
  const ms: number[] = [];
  for (let k = 0; k < iters; k++) { let s = 0; for (let j = 0; j < a.length; j++) s += a[Math.floor(r() * a.length)]; ms.push(s / a.length); }
  ms.sort((x, y) => x - y);
  return [ms[Math.floor(iters * 0.025)], ms[Math.floor(iters * 0.975)]];
}

interface Summary { n: number; mean: number; t: number; ci: [number, number]; win: number; pf: number }
function summarize(rs: number[]): Summary {
  const n = rs.length;
  const m = mean(rs), s = sd(rs);
  const pos = rs.filter(x => x > 0).reduce((q, x) => q + x, 0);
  const neg = -rs.filter(x => x < 0).reduce((q, x) => q + x, 0);
  return { n, mean: m, t: n > 1 && s > 0 ? m / (s / Math.sqrt(n)) : 0, ci: bootstrapCI(rs), win: rs.filter(x => x > 0).length / (n || 1), pf: neg > 0 ? pos / neg : Infinity };
}
function row(label: string, rs: number[]): string {
  if (rs.length === 0) return `  ${label.padEnd(18)} n=0`;
  const s = summarize(rs);
  return `  ${label.padEnd(18)} n=${String(s.n).padStart(4)}  每筆 ${f(s.mean).padStart(7)}R  t=${f(s.t, 2).padStart(6)}  95%CI [${f(s.ci[0])}, ${f(s.ci[1])}]  勝率 ${(100 * s.win).toFixed(1).padStart(5)}%  PF ${s.pf === Infinity ? '∞' : s.pf.toFixed(2)}  合計 ${f(rs.reduce((q, x) => q + x, 0), 1)}R`;
}

function maxDrawdownR(rs: number[]): number {
  let eq = 0, peak = 0, dd = 0;
  for (const r of rs) { eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return dd;
}

function realFills(): number[] | null {
  const files = readdirSync(process.cwd()).filter(x => /^audit-fabricated-exits-.*\.json$/.test(x)).sort();
  if (!files.length) return null;
  const j = JSON.parse(readFileSync(files[files.length - 1], 'utf-8'));
  const xs = (j.findings as { realR: number | null; verdict: string }[])
    .filter(x => x.realR != null && Number.isFinite(x.realR) && x.verdict !== 'NO_ENTRY_FILL')
    .map(x => x.realR as number);
  console.log(`  （來源：${files[files.length - 1]}，${j.days} 天）`);
  return xs;
}

// ════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  const endMs = Math.floor(Date.now() / H) * H;
  const start1h = endMs - MONTHS * 30 * 24 * H - WARMUP_1H * H;
  const start4h = start1h - 600 * H4;

  console.log('═'.repeat(78));
  console.log(`  策略獲利能力驗證  |  ${MONTHS} 個月  |  前 ${NSYM} 檔（今日成交量）`);
  console.log('═'.repeat(78));

  const syms = await topSymbols(NSYM);
  console.log(`  ${syms.map(s => s.replace('USDT', '')).join(' ')}\n`);

  // BTC 大盤狀態（山寨幣的方向濾網）
  const btc1 = await fetchKlines('BTCUSDT', '1h', start1h, endMs);
  const btc4 = await fetchKlines('BTCUSDT', '4h', start4h, endMs);

  // ── 階段 1 ──
  console.log('── 階段 1：量測工具先驗 ' + '─'.repeat(54));
  checkConstants();
  checkDerive4hAlignment(btc1);
  checkFormingBarCache(btc1.slice(-3000), btc4.slice(-1500));
  issue({ id: 'S1', sev: 'ℹ️', where: '本腳本', what: '幣種用「今天」的成交量前 N 名回頭測（倖存者偏誤），結果偏向高估', evidence: '無法完全消除；解讀時只當上限' });
  issue({ id: 'S2', sev: 'ℹ️', where: '本腳本', what: '未模擬 5m/15m 多時框與組合層級風控（熔斷、回撤、同向上限）', evidence: '這些只會少做幾筆，不會讓沒邊際的訊號變有邊際' });

  const order: Record<Severity, number> = { '🔴': 0, '🟡': 1, 'ℹ️': 2 };
  issues.sort((a, b) => order[a.sev] - order[b.sev]);
  for (const x of issues) {
    console.log(`  ${x.sev} [${x.id}] ${x.what}`);
    console.log(`       位置：${x.where}`);
    console.log(`       證據：${x.evidence}`);
  }
  const blocking = issues.filter(x => x.sev !== 'ℹ️').length;
  console.log(`\n  共 ${issues.length} 項（需修 ${blocking} 項）\n`);

  // ── 階段 2 ──
  console.log('── 階段 2：逐根模擬 ' + '─'.repeat(58));
  const btcCtx = buildBtcContext(btc1, makeFourHView(btc4));
  const all: SimTrade[] = [];
  const cnt: Counters = { signals: 0, expired: 0, tp1Direct: 0, gated: {} };
  for (const s of syms) {
    process.stdout.write(`  ${s.padEnd(14)}`);
    try {
      const c1 = s === 'BTCUSDT' ? btc1 : await fetchKlines(s, '1h', start1h, endMs);
      const c4 = s === 'BTCUSDT' ? btc4 : await fetchKlines(s, '4h', start4h, endMs);
      const fu = await fetchFunding(s, start1h, endMs);
      const tr = simulateSymbol(s, c1, c4, fu, btcCtx, cnt);
      all.push(...tr);
      console.log(`${String(c1.length).padStart(5)} 根  → ${String(tr.length).padStart(3)} 筆  淨 ${f(tr.reduce((q, t) => q + t.netR, 0), 1)}R`);
    } catch (e) { console.log(`跳過：${String(e).slice(0, 60)}`); }
  }
  all.sort((a, b) => a.fillTime - b.fillTime);
  console.log(`\n  通過評分的訊號 ${cnt.signals}，掛單逾期 ${cnt.expired}，先碰 TP1 取消 ${cnt.tp1Direct}`);
  console.log(`  濾網擋下：${Object.entries(cnt.gated).map(([k, v]) => `${k}=${v}`).join('  ') || '無'}`);

  if (all.length < 10) { console.log('\n樣本太少，無法判讀。'); return; }

  // ── 階段 3 ──
  const net = all.map(t => t.netR), gross = all.map(t => t.grossR);
  console.log('\n── 階段 3：結果 ' + '─'.repeat(62));
  console.log(row('毛 R（未扣成本）', gross));
  console.log(row('淨 R（扣全部成本）', net));
  console.log(`  成本拆解：手續費+滑價 每筆 ${f(-mean(all.map(t => t.feeR)))}R，資金費率 每筆 ${f(mean(all.map(t => t.fundingR)))}R；止損距離中位數 ${(100 * all.map(t => t.riskPct).sort((a, b) => a - b)[Math.floor(all.length / 2)]).toFixed(2)}%`);

  // 敏感度：悲觀假設占多少。成交那根就打止損的單，若改成「剔除不算」（最樂觀的上界）
  const fbs = all.filter(t => t.fillBarStop).length;
  console.log(row('樂觀上界*', all.filter(t => !t.fillBarStop).map(t => t.netR)));
  console.log(`  *剔除 ${fbs} 筆「成交那根就碰到止損」（悲觀判止損）的單；真相在兩列之間`);

  console.log('\n  分組（淨 R）');
  console.log(row('策略 A 趨勢', all.filter(t => t.strategy === 'A').map(t => t.netR)));
  console.log(row('策略 B 均值回歸', all.filter(t => t.strategy === 'B').map(t => t.netR)));
  console.log(row('做多', all.filter(t => t.direction === 'LONG').map(t => t.netR)));
  console.log(row('做空', all.filter(t => t.direction === 'SHORT').map(t => t.netR)));
  console.log(row('市價進場', all.filter(t => t.market).map(t => t.netR)));
  console.log(row('限價進場', all.filter(t => !t.market).map(t => t.netR)));
  const half = Math.floor(all.length / 2);
  console.log(row('前半段', net.slice(0, half)));
  console.log(row('後半段', net.slice(half)));

  const reasons = new Map<string, number[]>();
  for (const t of all) { if (!reasons.has(t.reason)) reasons.set(t.reason, []); reasons.get(t.reason)!.push(t.netR); }
  console.log('\n  出場原因');
  for (const [k, v] of Array.from(reasons.entries()).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`    ${k.padEnd(10)} ${String(v.length).padStart(4)} 筆 (${(100 * v.length / all.length).toFixed(1).padStart(4)}%)  平均 ${f(mean(v))}R`);
  }

  const bySym = new Map<string, number[]>();
  for (const t of all) { if (!bySym.has(t.symbol)) bySym.set(t.symbol, []); bySym.get(t.symbol)!.push(t.netR); }
  const symPos = Array.from(bySym.values()).filter(v => v.reduce((q, x) => q + x, 0) > 0).length;
  console.log(`\n  幣種：${symPos}/${bySym.size} 檔淨 R 為正`);

  const byMonth = new Map<string, number>();
  for (const t of all) { const m = new Date(t.fillTime).toISOString().slice(0, 7); byMonth.set(m, (byMonth.get(m) ?? 0) + t.netR); }
  const months = Array.from(byMonth.entries()).sort();
  console.log(`  月份：${months.filter(([, v]) => v > 0).length}/${months.length} 個月為正  ` + months.map(([m, v]) => `${m.slice(2)} ${f(v, 1)}`).join('  '));

  let eq = 1; for (const r of net) eq *= 1 + 0.01 * r;
  console.log(`  最大回撤 ${maxDrawdownR(net).toFixed(1)}R；每筆風險 1% 複利：${f((eq - 1) * 100, 1)}%（${MONTHS} 個月、組合未限制同時持倉）`);

  const s = summarize(net);
  const sdev = sd(net);
  const nNeed = (target: number) => Math.ceil((2 * sdev / target) ** 2);
  console.log(`  檢定力：sd=${sdev.toFixed(2)}，要在 t=2 偵測 +0.05R/筆 需 n≈${nNeed(0.05)}，+0.10R/筆 需 n≈${nNeed(0.1)}`);

  // 真實成交
  console.log('\n── 對照：幣安真實成交 ' + '─'.repeat(56));
  const real = realFills();
  if (real && real.length) {
    console.log(row('真實（未扣手續費）', real));
    console.log('  真實 realR 來自 realizedPnl，不含手續費；扣掉後只會更低。');
  } else {
    console.log('  （找不到 audit-fabricated-exits-*.json，先跑 npm run audit-exits）');
  }

  // 判語
  console.log('\n' + '═'.repeat(78));
  const halves = [summarize(net.slice(0, half)), summarize(net.slice(half))];
  let verdict: string;
  if (s.ci[0] > 0 && halves.every(h => h.mean > 0)) verdict = '✅ 有正邊際：淨 R 信賴區間整段在 0 以上，前後半段都為正';
  else if (s.ci[1] < 0) verdict = '❌ 會虧錢：淨 R 信賴區間整段在 0 以下';
  else if (s.mean < 0) verdict = '⚠️ 測不出邊際，點估計為負：信賴區間跨 0，沒有證據能賺錢';
  else verdict = '⚠️ 測不出邊際，點估計為正但不顯著：信賴區間跨 0';
  console.log(`  判語：${verdict}`);
  console.log(`  淨 R 每筆 ${f(s.mean)}R，95%CI [${f(s.ci[0])}, ${f(s.ci[1])}]，n=${s.n}`);
  if (blocking > 0) console.log(`  ⚠ 階段 1 還有 ${blocking} 項未修，上面的判語建立在「本腳本的模擬是對的」這個前提上`);
  console.log('═'.repeat(78));

  const out = join(CACHE_DIR, `verify-trades-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(out, JSON.stringify({ issues, trades: all }, null, 1), { encoding: 'utf-8' });
  console.log(`  逐筆明細：${out}`);
}

main().catch(e => { console.error('verify-strategy error:', e); process.exit(1); });
