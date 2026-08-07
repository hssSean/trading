#!/usr/bin/env npx tsx
/**
 * 常駐執行迴圈 entrypoint —— runner.ts 頭部註解寫明「刻意不接 Next.js route/
 * cron」的那個獨立 process，就是這支。Vercel 撐不住這種活：沒有固定 IP、
 * function 會被中途砍斷、5 分鐘 cron 間隔對移動止損維護太粗糙。
 *
 * 用法：
 *   npm run live-runner            # testnet，預設
 *   npm run live-runner -- --live  # 正式帳戶（目前不會走到這裡，見下方說明）
 *
 * 環境變數（跟 testnet-reconcile.ts 同一套，不要貼在 chat 裡，只設在主機上）：
 *   BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN（跟 Vercel 專案同一個
 *   Upstash 執行個體 —— kill switch 是共用狀態，Vercel 那邊的 /api/analyze
 *   跟這支 process 要看到同一個開關）
 *
 * ── 現在這版本能做到什麼、不能做到什麼 ──────────────────────────────────
 * 能做：跑起來會持續讀 kill switch 狀態、拉真實 testnet 持倉/掛單、跑
 * watchdog.reconcilePositionsAndOrders 對帳、把結果印出來。這部分本身就有
 * 用：能看見「裸倉」（有倉位沒止損）這類異常，不需要等下單邏輯完成。
 *
 * 不能做：目前不會真的下單/改單/平倉。runMonitorCycle 需要的
 * RunnerCycleInput（哪些單要 TP1 部分平倉、哪些要移動止損）目前傳空陣列——
 * 因為「用真實交易所倉位狀態算出該做什麼動作」這層橋接邏輯還沒寫（策略層
 * api/analyze/route.ts 目前只對接 Supabase 的推薦單狀態，從沒讀過真實
 * 交易所倉位）。且 binanceClient.ts 的 placeOrder 對 STOP_MARKET/
 * TAKE_PROFIT_MARKET 還是打舊版 /v1/order，撞得到 -4120（幣安 2025-12
 * 條件單遷移到 /fapi/v1/algoOrder，新端點路徑待確認）。這兩塊都補上之前，
 * --live 旗標刻意不接真實帳戶 —— 現在跑這支腳本不會有下單風險，純觀察。
 */

import { BinanceFuturesClient, loadBinanceConfigFromEnv } from '../src/engine/binanceClient';
import { runMonitorCycle, RunnerClient } from '../src/engine/runner';
import { getKillSwitchState } from '../src/engine/killSwitch';
import { Redis } from '@upstash/redis';

const isLive = process.argv.includes('--live');
if (isLive) {
  console.error('❌ --live 尚未開放：下單橋接邏輯還沒寫，目前只支援 testnet 觀察模式。');
  process.exit(1);
}

const CYCLE_MS = 15_000; // 15 秒一輪，比 Vercel 5 分鐘 cron 細很多

function nowStr(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

async function main() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    console.error('❌ UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 未設定');
    process.exit(1);
  }
  const redis = Redis.fromEnv();
  const config = loadBinanceConfigFromEnv(true); // testnet 固定 true，直到 --live 開放
  const binance = new BinanceFuturesClient(config);

  const client: RunnerClient = {
    getPositionRisk: (symbol) => binance.getPositionRisk(symbol),
    getOpenOrders:   (symbol) => binance.getOpenOrders(symbol),
    placeOrder:      (params) => binance.placeOrder(params),
    cancelOrder:     (symbol, orderId) => binance.cancelOrder(symbol, orderId),
  };

  console.log(`[${nowStr()}] live-runner 啟動（testnet 觀察模式，${CYCLE_MS / 1000}秒/輪）`);

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    console.log(`\n[${nowStr()}] 收到停止信號，結束迴圈`);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopped) {
    const cycleStart = Date.now();
    try {
      const result = await runMonitorCycle(
        { client, getKillSwitchState: () => getKillSwitchState(redis) },
        { pendingCancels: [], tp1Closes: [], trailingStopUpdates: [] }, // 見上方說明：橋接邏輯待補
      );

      if (result.killSwitchActive) {
        console.log(`[${nowStr()}] kill switch 啟動中`);
      }
      if (result.reconcileAnomalies.length > 0) {
        console.log(`[${nowStr()}] ⚠ 對帳異常 ${result.reconcileAnomalies.length} 筆:`);
        for (const a of result.reconcileAnomalies) console.log(`   ${JSON.stringify(a)}`);
      }
      for (const e of result.errors) console.log(`[${nowStr()}] ❌ ${e}`);

      if (result.reconcileAnomalies.length === 0 && result.errors.length === 0 && !result.killSwitchActive) {
        console.log(`[${nowStr()}] OK，無異常`);
      }
    } catch (e) {
      console.log(`[${nowStr()}] ❌ 這輪整個失敗（不影響下一輪）: ${String(e)}`);
    }

    const elapsed = Date.now() - cycleStart;
    const wait = Math.max(0, CYCLE_MS - elapsed);
    await new Promise(r => setTimeout(r, wait));
  }
}

main().catch(e => {
  console.error(`[${nowStr()}] 致命錯誤，process 結束: ${String(e)}`);
  process.exit(1);
});
