#!/usr/bin/env npx tsx
/**
 * S/R 阻力位有沒有資訊量 —— 用置換檢定回答，不用跑完整走K線模擬。
 *
 *   npx tsx scripts/sr-mechanism.ts
 *
 * ## 為什麼需要這支
 *
 * `buildSignalLevels` 想用「最近阻力」夾住 TP1，但 swing 分支（1h/4h/1d）的
 * `tp1Max` 跟 `MIN_RR_SWING` 同為 2.0R：
 *
 *     tp1 = max(min(阻力, entry + risk*2.0), entry + risk*2.0)  ≡  entry + risk*2.0
 *
 * 上限等於地板，**那段夾持是死碼**。而系統 98% 的單都是 1h。
 *
 * 「要不要讓它活過來」很容易被誤讀成「TP1 該不該拉近」——後者 2026-09-03
 * 已經測完（6 個 TP 位置變體，n=705，最好的 t=2.13 過不了 Bonferroni 2.94）。
 * 真正不同的問題是：**阻力位帶不帶這筆單專屬的資訊？** 如果不帶，「夾到阻力」
 * 就只是「挪到某個較近的 R 倍數」的迂迴寫法，等同已測過的東西。
 *
 * ## 為什麼用置換檢定而不是走K線模擬
 *
 * 走K線模擬要 6 個月 × 15 幣、十幾分鐘，而且結果會混進「TP1 拉近」的效果，
 * 分不出是結構有用還是單純目標變近。置換檢定直接問機制：
 *
 *     把 resistanceR 在交易之間洗牌，破壞「這筆的阻力 ↔ 這筆的走勢」的配對，
 *     兩邊的邊際分布完全不變。真實值若跟洗牌後沒差別 → 阻力不帶資訊。
 *
 * 這是先導檢查：**沒過就不用跑模擬了**。過了才值得排隊。
 *
 * ## 讀法
 *
 * d = mfeR − resistanceR（mfe = 浮盈最高點，兩者都以 R 為單位）
 *   d < 0   價格沒走到阻力就回頭
 *   d ≈ 0   停在阻力 ← 屏障訊號，真的有屏障時這一格會過度集中
 *   d > 0   直接穿過，阻力沒作用
 *
 * ⚠ 「TP1 夾到阻力的觸及率比 2R 高」**不是**證據——目標近本來就容易碰到。
 * 要看的是它有沒有贏過「隨機給一個同樣距離的阻力」，那才是資訊量。
 *
 * 需要 `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`（見 loadEnvFile）。
 * 唯讀：只 select，不寫任何東西。
 */
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { loadEnvFile, reportEnvLoad } from './loadEnvFile';
import { findSRLevels, nearestSupport, nearestResistance } from '../src/analysis/snr';
import type { Candle } from '../src/types';

reportEnvLoad(loadEnvFile());

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!url || !key) {
  console.error('缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

// 這些 close_reason 代表掛單從未成交，沒有進場也就沒有 MFE 可談。
const NEVER_FILLED = new Set([
  'live_entry_expired', 'cancel_expired', 'cancel_tp1_direct',
  'symbol_unavailable', 'cancel_ran_away',
]);
// route.ts 產訊號時用的窗口：fetchCandles(symbol, entryTf, 200)
const BARS = 200;
const PERMUTATIONS = 3000;

async function klines(symbol: string, endTime: number): Promise<Candle[]> {
  const r = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
    params: { symbol, interval: '1h', limit: BARS, endTime },
    timeout: 20000,
  });
  return (r.data as unknown[][]).map(k => ({
    openTime: k[0] as number, open: +(k[1] as string), high: +(k[2] as string),
    low: +(k[3] as string), close: +(k[4] as string), volume: +(k[5] as string),
    closeTime: k[6] as number,
  })) as Candle[];
}

interface TradeRow {
  symbol: string; direction: string; entry: number; stop_loss: number;
  signal_price: number | null; mfe_price: number; opened_at: number;
  close_reason: string | null; strategy: string | null;
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const med  = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

function corr(a: number[], b: number[]): number {
  const ma = mean(a), mb = mean(b);
  let num = 0, va = 0, vb = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    va  += (a[i] - ma) ** 2;
    vb  += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(va * vb);
}

function shuffled(src: number[]): number[] {
  const out = [...src];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

(async () => {
  const { data, error } = await db.from('trades')
    .select('symbol, direction, entry, stop_loss, signal_price, mfe_price, opened_at, close_reason, strategy, timeframe, closed_at')
    .not('closed_at', 'is', null)
    .eq('timeframe', '1h')
    .not('mfe_price', 'is', null)
    .order('closed_at', { ascending: false })
    .limit(1000);
  if (error) { console.error(error); process.exit(1); }

  const rows = ((data ?? []) as unknown as TradeRow[])
    .filter(r => !NEVER_FILLED.has(r.close_reason ?? ''))
    .filter(r => r.entry && r.stop_loss && r.mfe_price && r.opened_at);
  console.log(`候選 ${rows.length} 筆（1h、已成交、有 MFE）\n`);

  const recs: { resR: number; mfeR: number }[] = [];
  let noLevel = 0, fetchFail = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const c = await klines(r.symbol, r.opened_at);
      if (c.length < 60) { fetchFail++; continue; }
      // buildSignalLevels 的 tpClampPrice 是相對「訊號當下的現價」找的，不是
      // entry（進場價可能掛在下方等回調）。這裡照抄那個口徑。
      const px = r.signal_price ?? r.entry;
      const isLong = r.direction === 'LONG';
      const lvl = isLong ? nearestResistance(findSRLevels(c), px) : nearestSupport(findSRLevels(c), px);
      if (!lvl) { noLevel++; continue; }

      const risk = Math.abs(r.entry - r.stop_loss);
      if (risk <= 0) continue;
      const resR = (isLong ? lvl.price - r.entry : r.entry - lvl.price) / risk;
      const mfeR = (isLong ? r.mfe_price - r.entry : r.entry - r.mfe_price) / risk;
      if (!Number.isFinite(resR) || !Number.isFinite(mfeR)) continue;
      recs.push({ resR, mfeR });
    } catch { fetchFail++; }
    if (i % 20 === 0) process.stdout.write(`\r  抓取中 ${i}/${rows.length}`);
    await new Promise(res => setTimeout(res, 60)); // 別打爆 Binance 公開端點
  }
  console.log(`\r  完成。可用 ${recs.length}，該方向無 S/R 位 ${noLevel}，抓取失敗 ${fetchFail}\n`);

  if (recs.length < 30) { console.log('樣本太少（<30），不下結論。'); return; }

  // ── 1. 覆蓋率：夾持會不會真的生效 ──────────────────────────────
  // 阻力落在 entry 與 entry+2R 之間才夾得到；≥2R 的話 min() 選中的是 2R，
  // 等於沒夾。覆蓋率太低的話後面的統計就是被稀釋出來的假 n。
  const bind = recs.filter(x => x.resR > 0 && x.resR < 2.0);
  console.log('── 1. 覆蓋率（阻力落在 entry 與 2R 之間才夾得到）──');
  console.log(`  會被夾到: ${bind.length}/${recs.length} = ${(bind.length / recs.length * 100).toFixed(1)}%`);
  console.log(`  阻力 ≥2R（夾不到）: ${recs.filter(x => x.resR >= 2.0).length}`);
  if (bind.length) {
    const b = bind.map(x => x.resR).sort((a, c) => a - c);
    const q = (p: number) => b[Math.floor(p * (b.length - 1))].toFixed(2);
    console.log(`  被夾到的那些，阻力位置(R): min=${q(0)} 中位=${q(.5)} max=${q(1)}`);
  }

  // ── 2. 屏障證據：MFE 相對阻力的位置 ────────────────────────────
  const valid = recs.filter(x => x.resR > 0);
  const d = valid.map(x => x.mfeR - x.resR);
  const ds = [...d].sort((a, b) => a - b);
  const dq = (p: number) => ds[Math.floor(p * (ds.length - 1))].toFixed(2);
  console.log(`\n── 2. d = mfeR − resistanceR 的分布（n=${valid.length}）──`);
  console.log(`  min=${dq(0)} p25=${dq(.25)} 中位=${dq(.5)} p75=${dq(.75)} max=${dq(1)}`);
  const band = (lo: number, hi: number) => d.filter(v => v >= lo && v < hi).length;
  console.log(`  d < −0.5      ${band(-Infinity, -0.5)}  (離阻力還很遠就回頭)`);
  console.log(`  −0.5 ≤ d < 0  ${band(-0.5, 0)}  (逼近阻力但沒到)`);
  console.log(`  0 ≤ d < 0.5   ${band(0, 0.5)}  (停在阻力附近 ← 屏障訊號)`);
  console.log(`  d ≥ 0.5       ${band(0.5, Infinity)}  (直接穿過)`);

  // ── 3. 置換檢定 ────────────────────────────────────────────────
  const resArr = valid.map(x => x.resR);
  const mfeArr = valid.map(x => x.mfeR);
  const hitRate   = (rs: number[], ms: number[]) => rs.filter((v, i) => ms[i] >= v).length / rs.length;
  const stallRate = (rs: number[], ms: number[]) =>
    rs.filter((v, i) => ms[i] - v >= -0.5 && ms[i] - v < 0.5).length / rs.length;

  const realHit = hitRate(resArr, mfeArr);
  const realStall = stallRate(resArr, mfeArr);
  const realCorr = corr(resArr, mfeArr);

  let hitGE = 0, stallGE = 0, corrGE = 0;
  const nullHit: number[] = [], nullStall: number[] = [], nullCorr: number[] = [];
  for (let k = 0; k < PERMUTATIONS; k++) {
    const sh = shuffled(mfeArr);
    const h = hitRate(resArr, sh), s = stallRate(resArr, sh), c = corr(resArr, sh);
    nullHit.push(h); nullStall.push(s); nullCorr.push(c);
    if (h >= realHit)   hitGE++;
    if (s >= realStall) stallGE++;
    if (c >= realCorr)  corrGE++;
  }
  const p = (ge: number) => ((ge + 1) / (PERMUTATIONS + 1)).toFixed(4);
  console.log(`\n── 3. 置換檢定（洗牌 ${PERMUTATIONS} 次，破壞「這筆的阻力↔這筆的走勢」配對）──`);
  console.log(`  觸及率 P(MFE≥阻力)   真實 ${(realHit * 100).toFixed(1)}%   洗牌均值 ${(mean(nullHit) * 100).toFixed(1)}%   p=${p(hitGE)}`);
  console.log(`  停在阻力±0.5R        真實 ${(realStall * 100).toFixed(1)}%   洗牌均值 ${(mean(nullStall) * 100).toFixed(1)}%   p=${p(stallGE)}`);
  console.log(`  corr(阻力R, MFE R)   真實 ${realCorr.toFixed(3)}   洗牌均值 ${mean(nullCorr).toFixed(3)}   p=${p(corrGE)}`);

  // ── 4. 決策相關對比（注意這一段最容易被誤讀）──────────────────
  if (bind.length >= 20) {
    const bHit = bind.filter(x => x.mfeR >= x.resR).length / bind.length;
    const b2R  = bind.filter(x => x.mfeR >= 2.0).length / bind.length;
    console.log(`\n── 4. 只看會被夾到的 ${bind.length} 筆 ──`);
    console.log(`  TP1 夾到阻力 → 觸及率 ${(bHit * 100).toFixed(1)}%（中位阻力 ${med(bind.map(x => x.resR)).toFixed(2)}R）`);
    console.log(`  TP1 維持 2R  → 觸及率 ${(b2R * 100).toFixed(1)}%`);
    console.log('  ⚠ 這個差距主要是「目標變近」的機械效果，不是阻力有用。');
    console.log('    要不要當成證據，看第 3 節的 p 值，不是看這兩個數字。');
  }
})();
