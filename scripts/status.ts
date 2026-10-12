#!/usr/bin/env npx tsx
/**
 * 「這個系統現在是活的還是停的」—— 一個指令回答。
 *
 * 這一整輪排查最貴的部分不是修 bug，是**不知道當下狀態**：訊號還在發嗎？
 * 有幾筆倉位開著？回撤停機解除了沒？live-runner 還活著嗎？
 * 每個問題都要開網頁、登入不同服務、或翻 DB 才知道，於是「系統已經靜默
 * 停擺一週」這種事發生過不只一次（live-runner 整週沒監控持倉、
 * DB 模擬捏造出場把系統自己停掉）。
 *
 * 2026-10-12 起以 S3 為主：先印 S3 真倉（Redis s3a-live:* ＋交易所），判語在
 * src/lib/s3s1/statusCheck.ts。**Redis 讀不到時照樣往下跑**——Redis 掛掉正是最需要
 * 看狀態的時候，Supabase 心跳與交易所部位仍然印得出來。
 * 舊策略（Supabase trades）只在還有未平倉、或加 --legacy 時才展開。
 *
 *   ENV_FILE=env.txt npm run status [-- --legacy]
 *
 * 需要 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / TRADING_USER_ID；
 * S3 部分另外需要 UPSTASH_REDIS_REST_URL／TOKEN，交易所部分需要 BINANCE_TESTNET_API_KEY／SECRET。
 */

import { createClient } from '@supabase/supabase-js';
import { loadEnvFile, reportEnvLoad } from './loadEnvFile';

const H = 3600_000;
const ago = (t: number | null | undefined): string => {
  if (t == null) return '從未';
  const d = Date.now() - t;
  if (d < 60_000) return '剛剛';
  if (d < H) return `${Math.floor(d / 60_000)} 分鐘前`;
  if (d < 24 * H) return `${(d / H).toFixed(1)} 小時前`;
  return `${(d / (24 * H)).toFixed(1)} 天前`;
};

const DAYMS = 24 * H;
const fmtDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const num = (v: unknown, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '—');
const parse = <T,>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;

/** S3 真倉區塊。回傳 Redis 記著的持倉 symbol（給孤兒比對）；Redis 讀不到回 null。 */
async function printS3(
  exPos: { symbol: string; positionAmt: string }[] | null,
  exAlgos: { symbol: string; algoId: number }[] | null,
): Promise<string[] | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) { console.log('⚠ 缺 UPSTASH_REDIS_REST_URL／TOKEN，看不到 S3'); return null; }
  const { Redis } = await import('@upstash/redis');
  const { legMeta, LEGS, LEG_KEYS } = await import('../src/engine/s3aLive');
  type LivePos = import('../src/engine/s3aLive').LivePos;
  type LiveSignal = import('../src/engine/s3aLive').LiveSignal;
  const { s3Findings } = await import('../src/lib/s3s1/statusCheck');
  const { ACCTS } = await import('../src/lib/s3s1/engine');
  const r = new Redis({ url, token });
  const now = Date.now();
  const X = Math.floor(now / DAYMS) * DAYMS, D = X - DAYMS;

  let meta: Record<string, unknown>, posRaw: Record<string, unknown>, sigRaw: unknown[], xc: Record<string, unknown>, ledger: Record<string, unknown>;
  try {
    [meta, posRaw, sigRaw, xc, ledger] = await Promise.all([
      r.hgetall<Record<string, unknown>>('s3a-live:meta').then(v => v ?? {}),
      r.hgetall<Record<string, unknown>>('s3a-live:pos').then(v => v ?? {}),
      r.lrange('s3a-live:signals', 0, 29),
      r.hgetall<Record<string, unknown>>('s3s1:xcheck').then(v => v ?? {}),
      r.hgetall<Record<string, unknown>>('s3s1:meta').then(v => v ?? {}),
    ]);
  } catch (e) {
    console.log(`⚠ Redis 讀不到（${String(e).slice(0, 100)}）——S3 狀態看不到，以下只剩 Supabase 與交易所`);
    return null;
  }

  const positions = Object.values(posRaw).map(v => parse<LivePos>(v));
  const signals = sigRaw.map(v => parse<LiveSignal>(v));

  console.log(`模式 ${meta.mode ?? '?'}｜testnet 錢包 ${num(meta.wallet)} USDT（${ago(meta.walletAt ? Number(meta.walletAt) : null)}）`);
  for (const k of LEG_KEYS) {
    const m = legMeta(meta, k);
    console.log(`  ${LEGS[k].name}  權益 ${num(m.equity)}（起始 ${num(m.base)}、已實現 ${m.realized >= 0 ? '+' : ''}${num(m.realized)}）`
      + `  連虧 ${m.streak}${m.halted ? `  ⛔ 停用：${m.halted}` : ''}`);
  }

  const today = signals.filter(s => s.signalDay === D);
  console.log(`\n今天（決策日 ${fmtDay(X)}，訊號日 ${fmtDay(D)}）`
    + `  最後決策日 ${meta.lastDay ? fmtDay(Number(meta.lastDay)) : '從未'}`);
  if (today.length === 0) console.log('  沒有突破候選（或今天的決策還沒跑）');
  for (const s of today) {
    const legs = s.legs ? Object.entries(s.legs).map(([k, v]) => `${k}:${v}`).join(' ') : (s.reason ?? s.decision);
    console.log(`  ${s.symbol.replace('USDT', '').padEnd(8)} 分數 ${s.score ?? '—'}  廣度 ${num(s.breadth, 3)}  BTC ${s.btcOk ? '✓' : '✗'}  → ${legs}`);
  }

  const qty = exPos ? Object.fromEntries(exPos.map(p => [p.symbol, Math.abs(parseFloat(p.positionAmt))])) : null;
  console.log(`\n持倉 ${positions.length} 筆`);
  for (const p of positions) {
    const R = p.entry - p.stop0;
    console.log(`  ${p.symbol.replace('USDT', '').padEnd(8)} 進場 ${p.entry}（${fmtDay(p.entryAt)}）  止損 ${p.stop}`
      + `（${R > 0 ? `${((p.stop - p.entry) / R).toFixed(2)}R` : '—'}）  ${p.partial ? '止盈已成交' : '止盈未成交'}`
      + `${p.addQty ? (p.addFilled ? '  B 已加碼' : '  B 加碼單掛著') : ''}`
      + `${qty ? `  交易所 ${qty[p.symbol] ?? 0}` : ''}`);
  }

  const L = ACCTS;
  const ledgerLine = (['s3a', 's3b', 's1'] as const).map(k => {
    const st = ledger[`acct.${k}`] ? parse<{ equity: number; trades: number; halted: string | null }>(ledger[`acct.${k}`]) : null;
    return `${L[k].name.split('｜')[0]} ${st ? `${num(st.equity)}（${st.trades} 筆）${st.halted ? '⛔' : ''}` : '—'}`;
  }).join('  ');
  console.log(`\n模擬帳本（各 100 起）  ${ledgerLine}`);

  // 分數影子追蹤：被分數擋掉的訊號後來怎麼了（驗證分數門檻唯一的方法，見 shadow.ts）
  try {
    const { summarizeShadow } = await import('../src/lib/s3s1/shadow');
    const sx = Object.values((await r.hgetall<Record<string, unknown>>('s3s1:s3x')) ?? {}).map(v => parse<import('../src/lib/s3s1/shadow').ShadowTrade>(v));
    const sm = summarizeShadow(sx);
    const g = (x: typeof sm.score2) => (x.n ? `${x.n} 筆 平均 ${x.avgR! >= 0 ? '+' : ''}${x.avgR!.toFixed(2)}R 勝率 ${(x.winRate! * 100).toFixed(0)}%` : '0 筆');
    console.log(`分數影子  2 分：${g(sm.score2)}｜被擋：${g(sm.blocked)}｜未出場 ${sm.open}（樣本少於 30 筆前不要下結論）`);
  } catch (e) {
    console.log(`分數影子  讀取失敗：${String(e).slice(0, 80)}`);
  }
  const xr = Object.values(xc).map(v => parse<{ X: number; day: string; ok: boolean; checkedAt: number }>(v));
  const lastXc = xr.length ? Math.max(...xr.map(x => x.checkedAt)) : null;
  const recentBad = xr.filter(x => !x.ok && x.X >= X - 7 * DAYMS).map(x => x.day).sort();
  console.log(`每日對帳  最後 ${ago(lastXc)}，近 7 天 ${xr.filter(x => x.X >= X - 7 * DAYMS).length} 天已對、不一致 ${recentBad.length} 天`);

  const findings = s3Findings({
    now, lastDay: Number(meta.lastDay ?? 0), mode: meta.mode ? String(meta.mode) : null,
    walletAt: meta.walletAt ? Number(meta.walletAt) : null,
    legs: LEG_KEYS.map(k => ({ name: LEGS[k].name, halted: legMeta(meta, k).halted })),
    positions: positions.map(p => ({ symbol: p.symbol, stopAlgoId: p.stopAlgoId, tpAlgoId: p.tpAlgoId, partial: p.partial })),
    exchangeQty: qty, algos: exAlgos,
    xcheck: { lastAt: lastXc, badDays: recentBad },
  });
  console.log('');
  for (const f of findings) console.log(`${f.level === 'ok' ? '✅' : f.level === 'warn' ? '⚠ ' : '🔴'} ${f.msg}`);
  return positions.map(p => p.symbol);
}

async function main() {
  reportEnvLoad(loadEnvFile());
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const uid = process.env.TRADING_USER_ID;
  if (!url || !key || !uid) throw new Error('缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / TRADING_USER_ID');
  const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: prof } = await db.from('profiles')
    .select('live_trading_enabled, drawdown_ack_at, live_runner_heartbeat_at')
    .eq('id', uid).single();

  const { data: recent } = await db.from('trades')
    .select('symbol, direction, result, status, opened_at, closed_at, exchange_entry_order_id')
    .eq('user_id', uid).order('opened_at', { ascending: false }).limit(200);
  const rows = recent ?? [];

  const open = rows.filter(r => r.closed_at == null);
  const lastOpened = rows[0]?.opened_at ?? null;
  const last24 = rows.filter(r => (r.opened_at ?? 0) > Date.now() - 24 * H);
  const closed24 = rows.filter(r => (r.closed_at ?? 0) > Date.now() - 24 * H);

  const showLegacy = open.length > 0 || process.argv.includes('--legacy');
  const ack = prof && 'drawdown_ack_at' in prof ? prof.drawdown_ack_at : undefined;
  const hb  = prof && 'live_runner_heartbeat_at' in prof ? prof.live_runner_heartbeat_at : undefined;

  // ── 交易所（帳戶級，S3 與舊策略共用一次查詢）──
  let exPos: Awaited<ReturnType<import('../src/engine/binanceClient').BinanceFuturesClient['getPositionRisk']>> | null = null;
  let exAlgos: Awaited<ReturnType<import('../src/engine/binanceClient').BinanceFuturesClient['getOpenAlgoOrders']>> | null = null;
  if (process.env.BINANCE_TESTNET_API_KEY) {
    try {
      const { BinanceFuturesClient, loadBinanceConfigFromEnv } = await import('../src/engine/binanceClient');
      const client = new BinanceFuturesClient(loadBinanceConfigFromEnv(true));
      exPos = (await client.getPositionRisk()).filter(p => parseFloat(p.positionAmt) !== 0);
      exAlgos = await client.getOpenAlgoOrders();
    } catch (e) {
      console.log(`⚠ 查不到交易所：${String(e).slice(0, 120)}`);
    }
  }

  console.log(`\n${'='.repeat(60)}\nS3 真倉（testnet）`);
  const s3Symbols = await printS3(exPos, exAlgos);

  console.log(`\nlive-runner 心跳（Supabase） ${hb === undefined ? '⚠ 欄位不存在（migration 未跑）' : ago(hb as number)}`);
  console.log(`live_trading_enabled         ${prof?.live_trading_enabled ?? '（讀不到）'}`);

  // ── 孤兒部位：幣安上有，但 S3（Redis）與舊策略（DB）都不知道 ──
  //
  // 2026-09-01 ARBUSDT：限價單部分成交後被當成過期撤單，已成交那部分變成沒人管的裸倉。
  // 孤兒部位不移動止損、不掛止盈、不計入風險額度，所以用帳戶級查詢反過來比對
  // （拿交易所的部位去找紀錄，而不是拿紀錄去找部位）。
  // 2026-10-12：S3 持倉記在 Redis 不在 trades 表，舊版會把每一筆 S3 持倉都報成孤兒。
  if (exPos) {
    const known = new Set([...open.map(o => o.symbol), ...(s3Symbols ?? [])]);
    const orphans = exPos.filter(p => !known.has(p.symbol));
    if (orphans.length > 0) {
      console.log(`\n⚠⚠ 孤兒部位 ${orphans.length} 筆——幣安上有部位，但 S3 與舊策略都沒有對應的紀錄`);
      for (const p of orphans) {
        console.log(`  ${p.symbol.replace('USDT', '').padEnd(8)} ${p.positionAmt} @ ${p.entryPrice}`
          + `  未實現 ${parseFloat(p.unRealizedProfit).toFixed(2)} USDT`);
      }
      console.log(s3Symbols == null
        ? `  （Redis 讀不到，S3 持倉也會出現在這裡，不一定是孤兒）`
        : `  這些部位沒有任何自動化在管。常見成因：手機 App 手動下單、限價單部分成交後被判定過期。`);
    } else if (exPos.length > 0) {
      console.log(`\n幣安上 ${exPos.length} 個部位全部對得上紀錄，無孤兒。`);
    }
  }

  if (!showLegacy) {
    console.log(`\n舊策略：0 筆未平倉，已停開新倉（它的回撤停機／沒訊號狀態與 S3 無關；加 --legacy 看細節）\n`);
    return;
  }

  console.log(`\n${'='.repeat(60)}\n舊策略（已停開新倉，管到出場）`);
  console.log(`最後產生訊號    ${ago(lastOpened)}`);
  console.log(`過去 24h        新單 ${last24.length} 筆 / 平倉 ${closed24.length} 筆`);
  console.log(`目前未平倉      ${open.length} 筆`
    + (open.length > 0 ? `（${open.map(o => o.symbol.replace('USDT', '')).join(', ')}）` : ''));
  console.log(`  其中真倉      ${open.filter(o => o.exchange_entry_order_id != null).length} 筆`);
  // 這個欄位需要 migration。讀不到就是還沒跑 ALTER TABLE——那代表回撤停機
  // 在 Redis 掛掉時解除不了。
  console.log(`回撤停機確認時間 ${ack === undefined ? '⚠ 欄位不存在（migration 未跑）' : ago(ack as number)}`);

  // ── trades 那邊的 migration（2026-09-07 補）────────────────────────────
  //
  // profiles 的兩個欄位上面已經檢查了，trades 的沒有——而漏掉的後果更難察覺：
  // insert 對缺欄位有兩段式 fallback（剝掉欄位重送），所以**寫入不會失敗，
  // 只是那個功能靜默地不存在**。`exchange_tp2_algo_id` 沒跑的話策略A的 TP2
  // 條件單根本掛不上去，而 TP2 正是 2026-09-06 才修好的東西——修了程式碼卻
  // 沒跑 migration，等於沒修。
  const cols: Array<[string, string]> = [
    ['exchange_tp2_algo_id', 'TP2 條件單（沒有的話策略A的最終止盈不會掛上）'],
    ['audit_verdict', '對帳標記（apply-audit-marks.ts 需要）'],
  ];
  for (const [col, why] of cols) {
    const { error } = await db.from('trades').select(col).limit(1);
    console.log(`trades.${col.padEnd(22)} ${error ? `⚠ 不存在（migration 未跑）— ${why}` : '✅'}`);
  }

  // 真正該問的是「那些真倉現在有保護單嗎」，那個只有交易所答得出來。
  const liveOpen = open.filter(o => o.exchange_entry_order_id != null);
  if (liveOpen.length > 0 && process.env.BINANCE_TESTNET_API_KEY) {
    console.log(`\n── 真倉的交易所保護單 ──`);
    const { BinanceFuturesClient, loadBinanceConfigFromEnv } = await import('../src/engine/binanceClient');
    const client = new BinanceFuturesClient(loadBinanceConfigFromEnv(true));
    // 已經送出進場單但**還沒成交**的單，在交易所端沒有部位，當然也不會有
    // 止損／止盈條件單——那是正常狀態，不是裸倉。
    //
    // 2026-09-05 實測誤報：XRP 掛單未成交，被印成「有倉位但沒有止損單，下檔
    // 沒有任何保護」。**會喊狼來了的診斷工具比沒有工具更糟**——真的出事時
    // 那行警告已經被當成雜訊了。所以先把有部位的 symbol 撈出來當閘門。
    const posNow = new Map<string, number>();
    for (const p of await client.getPositionRisk()) {
      const amt = Math.abs(parseFloat(p.positionAmt));
      if (amt > 0) posNow.set(p.symbol, amt);
    }
    // 條件單要用 openAlgoOrders 查，getOpenOrders 查不到（2025-12 幣安遷移後
    // STOP_MARKET / TAKE_PROFIT_MARKET 都活在 algo 端點）。而且 account 級
    // 不帶 symbol 才查得到，帶了會是空——見 binanceClient.ts 的實測註解。
    const algos = await client.getOpenAlgoOrders();
    // decideTp1OrderPlacement 有一條 skip：positionQty × 0.5 用 stepSize 取整
    // 後為 0 就跳過 TP1 單。小部位配上粗 stepSize（例如整數）會中這條，而且
    // 是靜默的。把部位量與 stepSize 一起印出來，才分得出「沒掛上」是這個原因
    // 還是別的。
    const info = await client.getExchangeInfo();
    const steps = new Map<string, number>();
    for (const s of info.symbols as Array<{ symbol: string; filters: Array<{ filterType: string; stepSize?: string }> }>) {
      const lot = s.filters?.find(f => f.filterType === 'LOT_SIZE');
      if (lot?.stepSize) steps.set(s.symbol, parseFloat(lot.stepSize));
    }

    for (const o of liveOpen) {
      const qtyNow = posNow.get(o.symbol) ?? 0;

      // 沒部位＝掛單還沒成交，沒有保護單是正常的。不要印警告。
      if (qtyNow <= 0) {
        console.log(`  ⏳ ${o.symbol.replace('USDT', '').padEnd(6)} 掛單等待成交中（交易所端無部位，故無保護單）`);
        continue;
      }

      const mine = algos.filter(a => a.symbol === o.symbol);
      const sl = mine.filter(a => a.orderType.includes('STOP'));
      const tp = mine.filter(a => a.orderType.includes('TAKE_PROFIT'));
      // 「有倉沒止盈」有兩種完全不同的意思，不講清楚會誤判：
      //   status='tp1_hit' → TP1 已經觸發、50% 已平，條件單被消耗掉，正常
      //   status 還是 active → TP1 單根本沒掛上，價格穿過 TP1 不會有動作
      // 後者正是 2026-08-23 Redis 空窗期那個「打到 TP1 卻沒出 50%」的形狀。
      const tp1Fired = o.status === 'tp1_hit';
      const stopOk = sl.length > 0;
      const tpOk = tp.length > 0 || tp1Fired;
      const flag = !stopOk ? '⚠' : !tpOk ? '⚠' : '✅';
      let note = '';
      if (!stopOk) note = '  ← 有倉位但沒有止損單，下檔沒有任何保護';
      else if (tp1Fired && tp.length === 0) note = '  （TP1 已觸發、50% 已平，條件單被消耗掉是正常的）';
      else if (!tpOk) {
        const step = steps.get(o.symbol);
        const qty = qtyNow;
        const halfFloored = step ? Math.floor((qty * 0.5) / step) * step : null;
        note = `  ← TP1 條件單沒掛上（status=${o.status ?? '?'}），價格穿過 TP1 不會自動平 50%`
          + `\n       部位 ${qty} / stepSize ${step ?? '?'} → 一半取整後 ${halfFloored ?? '?'}`
          + (halfFloored === 0 ? '　**這就是原因：取整後為 0 所以被跳過**' : '');
      }
      // ── 形狀，不只張數（2026-09-07 補）──────────────────────────────
      //
      // 舊版只數張數，所以 `closePosition=true` 的止損單掛在那裡也照樣印
      // 「止損 1 張 ✅」——而那正是 2026-09-06 UNI 翻倉的成因：closePosition
      // 把「要平多少」交給交易所決定，幣安 testnet 連續四次算錯，最後把
      // 剩 1 張的多單平成 -39 的空單（見 orderLifecycle.ts 的事故說明）。
      //
      // 程式碼已全面改成 quantity + reduceOnly，但**已經掛在交易所上的舊單
      // 不會自己變形狀**，要等它被觸發或被取代。所以「修好了」跟「現在掛著
      // 的單是安全的」是兩件事，status 必須分得出來。
      const staleSl = sl.filter(a => a.closePosition);
      const shapeNote = staleSl.length > 0
        ? `\n       🔴 其中 ${staleSl.length} 張止損是舊形狀（closePosition=true，數量由交易所決定）。`
          + `\n          這是 2026-09-06 UNI 翻倉的形狀。修復只對「之後新掛的單」生效，`
          + `\n          這張要等它觸發或被移動止損取代才會換成 quantity+reduceOnly。`
        : '';
      console.log(`  ${flag} ${o.symbol.replace('USDT', '').padEnd(6)} `
        + `止損 ${sl.length} 張 / 止盈 ${tp.length} 張${note}${shapeNote}`);
    }
  }

  // 「為什麼沒訊號」最常見的答案是回撤停機，而它是從 Supabase 已平倉交易算的
  // ——不需要 Redis，也不需要打 /api/analyze（那會真的跑一輪完整掃描，在 CPU
  // 額度吃緊時不該為了診斷去燒）。用線上同一個 calcDrawdown 與同一套口徑
  // （R 倍數 × tier 權重），算出來的數字才跟關卡實際看到的一致。
  const { calcDrawdown } = await import('../src/lib/monitorMath');
  // 門檻從 drawdownHalt.ts 讀，不要在這裡另寫一個預設值——診斷工具報的數字
  // 必須跟關卡實際用的是同一個，否則會出現「status 說沒事、系統卻停著」。
  const { readMaxDrawdownR } = await import('../src/lib/drawdownHalt');
  const limit = readMaxDrawdownR();
  let q = db.from('trades').select('closed_at, pnl_percent, entry, stop_loss, tier')
    .eq('user_id', uid).not('closed_at', 'is', null).not('result', 'is', null);
  if (ack != null && Number(ack) > 0) q = q.gt('closed_at', Number(ack));
  const { data: eq } = await q.order('closed_at', { ascending: true });

  const points = (eq ?? []).flatMap(t => {
    if (t.pnl_percent == null || !t.entry || !t.stop_loss) return [];
    const stopPct = Math.abs(t.entry - t.stop_loss) / t.entry * 100;
    if (stopPct <= 0) return [];
    return [{ closedAt: t.closed_at as number, accountR: (t.pnl_percent / stopPct) * (t.tier === 'B' ? 0.5 : 1.0) }];
  });

  if (points.length > 0) {
    const d = calcDrawdown(points);
    const halted = d.drawdown >= limit;
    console.log(`\n回撤（確認時間之後 ${points.length} 筆）`);
    console.log(`  高點 ${d.peak.toFixed(2)}R → 目前 ${d.current.toFixed(2)}R，回撤 ${d.drawdown.toFixed(2)}R / 上限 ${limit}R`);
    if (halted) {
      console.log(`  ⚠ 已達上限 → **回撤停機中，不會發任何新推薦單**`);
      console.log(`     設定頁「手動觸發分析」下方有解除按鈕。`);
    }
  }

  if (lastOpened != null && Date.now() - lastOpened > 12 * H) {
    console.log(`\n⚠ 超過 12 小時沒有新訊號。上面的回撤沒超標的話，`);
    console.log(`  就是熔斷／事件窗口／單純沒有合格訊號——設定頁「手動觸發分析」會直接說是哪一個。`);
  }
  console.log('');
}

main().catch(e => {
  console.error('查詢失敗：', e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
