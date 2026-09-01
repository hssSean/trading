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
 * 這支只讀 Supabase，**不需要 Redis**——刻意如此，因為 Redis 掛掉正是最
 * 需要看狀態的時候。
 *
 *   ENV_FILE=env.txt npm run status
 *
 * 需要 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / TRADING_USER_ID。
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

  console.log(`\n${'='.repeat(60)}`);
  console.log(`最後產生訊號    ${ago(lastOpened)}`);
  console.log(`過去 24h        新單 ${last24.length} 筆 / 平倉 ${closed24.length} 筆`);
  console.log(`目前未平倉      ${open.length} 筆`
    + (open.length > 0 ? `（${open.map(o => o.symbol.replace('USDT', '')).join(', ')}）` : ''));
  console.log(`  其中真倉      ${open.filter(o => o.exchange_entry_order_id != null).length} 筆`);

  console.log(`\nlive_trading_enabled   ${prof?.live_trading_enabled ?? '（讀不到）'}`);
  // 這兩個欄位需要 migration。讀不到就是還沒跑 ALTER TABLE——那代表回撤停機
  // 在 Redis 掛掉時解除不了，是這輪最容易被漏掉的一步。
  const ack = prof && 'drawdown_ack_at' in prof ? prof.drawdown_ack_at : undefined;
  const hb  = prof && 'live_runner_heartbeat_at' in prof ? prof.live_runner_heartbeat_at : undefined;
  console.log(`回撤停機確認時間        ${ack === undefined ? '⚠ 欄位不存在（migration 未跑）' : ago(ack as number)}`);
  console.log(`live-runner 心跳        ${hb === undefined ? '⚠ 欄位不存在（migration 未跑）' : ago(hb as number)}`);

  // 心跳「從未」不代表 live-runner 死了——舊版只寫 Redis，而 Redis 掛掉時
  // 那筆寫入會失敗。真正該問的是「那些真倉現在有保護單嗎」，那個只有交易所
  // 答得出來，而且是唯讀查詢。有倉沒止損 = 有錢在冒險而且沒人看著。
  const liveOpen = open.filter(o => o.exchange_entry_order_id != null);
  if (liveOpen.length > 0 && process.env.BINANCE_TESTNET_API_KEY) {
    console.log(`\n── 真倉的交易所保護單 ──`);
    const { BinanceFuturesClient, loadBinanceConfigFromEnv } = await import('../src/engine/binanceClient');
    const client = new BinanceFuturesClient(loadBinanceConfigFromEnv(true));
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
        const pos = await client.getPositionRisk(o.symbol);
        const qty = Math.abs(parseFloat(pos.find(p => p.symbol === o.symbol)?.positionAmt ?? '0'));
        const halfFloored = step ? Math.floor((qty * 0.5) / step) * step : null;
        note = `  ← TP1 條件單沒掛上（status=${o.status ?? '?'}），價格穿過 TP1 不會自動平 50%`
          + `\n       部位 ${qty} / stepSize ${step ?? '?'} → 一半取整後 ${halfFloored ?? '?'}`
          + (halfFloored === 0 ? '　**這就是原因：取整後為 0 所以被跳過**' : '');
      }
      console.log(`  ${flag} ${o.symbol.replace('USDT', '').padEnd(6)} `
        + `止損 ${sl.length} 張 / 止盈 ${tp.length} 張${note}`);
    }
  }

  // 「為什麼沒訊號」最常見的答案是回撤停機，而它是從 Supabase 已平倉交易算的
  // ——不需要 Redis，也不需要打 /api/analyze（那會真的跑一輪完整掃描，在 CPU
  // 額度吃緊時不該為了診斷去燒）。用線上同一個 calcDrawdown 與同一套口徑
  // （R 倍數 × tier 權重），算出來的數字才跟關卡實際看到的一致。
  const { calcDrawdown } = await import('../src/lib/monitorMath');
  const limit = parseFloat(process.env.MAX_DRAWDOWN_R ?? '12');
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
