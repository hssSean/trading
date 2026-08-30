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
    .select('symbol, direction, result, opened_at, closed_at, exchange_entry_order_id')
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
    for (const o of liveOpen) {
      const mine = algos.filter(a => a.symbol === o.symbol);
      const sl = mine.filter(a => a.orderType.includes('STOP'));
      const tp = mine.filter(a => a.orderType.includes('TAKE_PROFIT'));
      const ok = sl.length > 0;
      console.log(`  ${ok ? '✅' : '⚠'} ${o.symbol.replace('USDT', '').padEnd(6)} `
        + `止損 ${sl.length} 張 / 止盈 ${tp.length} 張`
        + (ok ? '' : '  ← 有倉位但沒有止損單，這筆的下檔沒有任何保護'));
    }
  }

  if (lastOpened != null && Date.now() - lastOpened > 12 * H) {
    console.log(`\n⚠ 超過 12 小時沒有新訊號。可能原因：回撤停機、熔斷、或掃描根本沒在跑。`);
    console.log(`  設定頁按「手動觸發分析」會直接顯示是哪一個。`);
  }
  console.log('');
}

main().catch(e => {
  console.error('查詢失敗：', e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
