#!/usr/bin/env npx tsx
/**
 * B7 前導檢定：signals.ts 的「hard gate 1」（intraday: structure.trend===
 * 'ranging' 全部跳過）到底有沒有抓對東西？
 *
 *   npx tsx scripts/regime-structure-mechanism.ts [MONTHS] [SYMBOL_COUNT]
 *
 * ## 為什麼先做這支
 *
 * docs/修改清單-2026-09-19.md B7「盤整識別收緊濾網」原始規格已遺失，使用者
 * 把方向判斷交給我。收緊或放寬都是在調同一個分類器的門檻，但**這個分類器
 * 從沒被驗證過有沒有資訊量**——它甚至沒進 reject-funnel（signals.ts 344 行
 * 的 hard gate 1 在候選評分之前就 return []，從沒被記錄成一筆候選）。跟
 * ANALYSIS-2026-09-07B 的教訓一樣：先問機制存不存在，過了才排隊決定往哪個
 * 方向調，省下不必要的模擬時間。
 *
 * analyzeMarketStructure（src/analysis/smc.ts）宣稱 trend='ranging' 代表
 * 「沒有乾淨動能、一天內構不到 TP」。如果這個分類是真的，'ranging' 判定
 * 之後的未來走勢震幅（相對 ATR 正規化）應該明顯小於 'bullish'/'bearish' 判定
 * 之後。用置換檢定驗證：把 trend 標籤在樣本間洗牌，破壞「這根的分類 ↔ 這根
 * 之後的走勢」配對，看真實的組間差異是不是洗牌洗不出來的。
 *
 * 只用公開 K 線，不需要任何金鑰。
 */
import type { Candle } from '../src/types';
import { analyzeMarketStructure } from '../src/analysis/smc';
import { fetchHistorical } from './backtest';
import { rollingAtr, regimeAt, topSymbols } from './exit-compare';

// exit-compare.ts 的 WINDOW_1H 沒有 export（純內部常數），照抄同一個值——
// analyzeMarketStructure 用的窗口要跟 signals.ts 實際吃到的一致，比較才有意義。
const WINDOW_1H = 200;

const MONTHS = Math.max(1, parseInt(process.argv[2] ?? '3', 10));
const NSYM = Math.max(1, parseInt(process.argv[3] ?? '12', 10));
const WARMUP = 250;
const HORIZON = 24; // route.ts INTRADAY_CLOSE_HOURS：1h K 線 → 24 根
const PERMUTATIONS = 3000;

const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))); };

function shuffledLabels(labels: boolean[]): boolean[] {
  const out = [...labels];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// 兩組均值差（trending 組 − ranging 組），標籤與數值分開傳入才能重複洗牌。
function groupDiff(values: number[], isTrending: boolean[]): number {
  const t: number[] = [], r: number[] = [];
  for (let i = 0; i < values.length; i++) (isTrending[i] ? t : r).push(values[i]);
  if (t.length === 0 || r.length === 0) return 0;
  return mean(t) - mean(r);
}

interface Rec { trend: 'bullish' | 'bearish' | 'ranging'; regime4h: string; fwdR: number }

async function main(): Promise<void> {
  const syms = await topSymbols(NSYM);
  console.log('='.repeat(72));
  console.log(`  盤整分類機制檢定  |  ${MONTHS} 個月  |  ${syms.length} 檔幣  |  水平 ${HORIZON} 根`);
  console.log(`  ${syms.map(s => s.replace('USDT', '')).join(' ')}`);
  console.log('='.repeat(72));

  const recs: Rec[] = [];
  // 逐幣逐根跑 analyzeMarketStructure 是 O(n²) 量級（findSwingPoints 內部
  // 掃鄰居），為了不讓這支腳本跑十幾分鐘，每隔 STRIDE 根取一次樣——分類器
  // 有沒有資訊量這個問題，不需要每一根都取。
  const STRIDE = 3;

  for (const symbol of syms) {
    process.stdout.write(`  ${symbol} ... `);
    let candles: Candle[];
    try { candles = await fetchHistorical(symbol, MONTHS); }
    catch (e) { console.log(`跳過：${String(e).slice(0, 50)}`); continue; }
    const atr = rollingAtr(candles);
    let used = 0;
    for (let i = WARMUP; i < candles.length - HORIZON; i += STRIDE) {
      const w = candles.slice(Math.max(0, i - WINDOW_1H + 1), i + 1);
      const structure = analyzeMarketStructure(w);
      if (structure.trend === 'ranging' && structure.swingHighs.length < 2) continue; // 資料不足的退化情況，不是真的判斷
      const a = atr[i];
      if (!a || a <= 0) continue;
      const fwdR = Math.abs(candles[i + HORIZON].close - candles[i].close) / a;
      if (!Number.isFinite(fwdR)) continue;
      recs.push({ trend: structure.trend, regime4h: regimeAt(candles, i), fwdR });
      used++;
    }
    console.log(`取樣 ${used}`);
  }

  console.log(`\n總樣本：${recs.length}`);
  if (recs.length < 60) { console.log('樣本太少，不下結論。'); return; }

  const byTrend = { bullish: recs.filter(r => r.trend === 'bullish'), bearish: recs.filter(r => r.trend === 'bearish'), ranging: recs.filter(r => r.trend === 'ranging') };
  console.log(`  bullish=${byTrend.bullish.length}  bearish=${byTrend.bearish.length}  ranging=${byTrend.ranging.length}`);
  console.log(`  未來 ${HORIZON} 根｜close-to-close 位移 / ATR｜(震幅越大＝越有動能可吃)`);
  for (const [k, v] of Object.entries(byTrend)) {
    if (v.length === 0) continue;
    const vals = v.map(x => x.fwdR).sort((a, b) => a - b);
    console.log(`  ${k.padEnd(8)} n=${String(v.length).padStart(4)}  平均=${mean(vals).toFixed(3)}  中位=${vals[Math.floor(vals.length / 2)].toFixed(3)}  sd=${sd(vals).toFixed(3)}`);
  }

  // ── 置換檢定：trending（bullish+bearish）vs ranging ──
  const values = recs.map(r => r.fwdR);
  const isTrending = recs.map(r => r.trend !== 'ranging');
  const realDiff = groupDiff(values, isTrending);
  let ge = 0;
  const nullDiffs: number[] = [];
  for (let k = 0; k < PERMUTATIONS; k++) {
    const d = groupDiff(values, shuffledLabels(isTrending));
    nullDiffs.push(d);
    if (d >= realDiff) ge++;
  }
  const p = (ge + 1) / (PERMUTATIONS + 1);
  console.log(`\n── 置換檢定（洗牌 ${PERMUTATIONS} 次，trending vs ranging 分類與後續震幅配對）──`);
  console.log(`  真實差 trending−ranging = ${realDiff >= 0 ? '+' : ''}${realDiff.toFixed(4)}   洗牌均值 = ${mean(nullDiffs).toFixed(4)}   p=${p.toFixed(4)}`);
  console.log(`  判讀：p < 0.05 才算「這個分類抓到了真的東西」；沒過代表`);
  console.log(`  'ranging' 標籤跟未來震幅無關——這種情況下調門檻鬆緊沒有意義，`);
  console.log(`  問題可能出在用錯指標，不是門檻設錯值。`);
}

main().catch(e => { console.error('regime-structure-mechanism error:', e); process.exit(1); });
