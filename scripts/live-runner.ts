#!/usr/bin/env npx tsx
/**
 * 常駐執行迴圈（跑在 AWS EC2）——Vercel 撐不住這種活：沒有固定 IP、function 會被中途砍斷、
 * cron 間隔對移動止損維護太粗糙。
 *
 * 用法：
 *   npm run live-runner            # testnet，預設
 *   npm run live-runner -- --live  # 正式帳戶（目前刻意 exit(1) 拒絕，見下方）
 *
 * 環境變數（只設在主機上，不要貼在 chat 裡；這支不會載入 .env）：
 *   BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN（跟 Vercel 同一個 Upstash——kill switch 與
 *     S3 狀態 s3a-live:* 是共用的）
 *   NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY（只用來寫心跳 profiles.live_runner_heartbeat_at）
 *   TRADING_USER_ID：Supabase profiles.id（心跳與推播對象）
 *   NEXT_PUBLIC_VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY（Web Push；必須跟 Vercel 同一組）
 *   S3A_DRY_RUN=1（選用）：S3 只印出會做的動作、不下單
 *
 * ── 每 15 秒一輪做的事 ──────────────────────────────────────────────────
 * 1. 心跳：雙寫 Redis＋Supabase。Vercel 的 /api/analyze 用它判斷這支停了沒，停超過 10 分鐘推播告警。
 * 2. Kill switch（fail closed）：啟動中整輪不做任何下單／改單。
 * 3. 全帳戶對帳：撤掉「沒有對應持倉的條件單」（S3 出場後殘留的止盈／加碼單也靠這個清），
 *    以及舊策略格式 `trade-…-entry` 的殘留進場單；「有倉沒止損」只記 log。
 * 4. S3-A＋S3-B 真倉（src/engine/s3aLive.ts）：每天 UTC 00:00:30～02:00 進場、每輪管理持倉。
 *
 * 2026-10-12：舊的 v2.1 評分策略（逐筆管理 Supabase trades：進場、TP1、移動止損、時間止損、
 * 裸倉看門狗、日虧損上限、回撤停機）已移除——2026-10-07 起停開新倉，持倉與掛單已歸零。
 * 舊版最後的完整程式在 commit 684fed6。
 *
 * --live 旗標刻意 exit(1)：確保這支目前只會碰 testnet 帳戶。
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Redis } from '@upstash/redis';
import { BinanceFuturesClient, loadBinanceConfigFromEnv } from '../src/engine/binanceClient';
import { getKillSwitchState, type KillSwitchState } from '../src/engine/killSwitch';
import { reconcilePositionsAndOrders } from '../src/engine/watchdog';
import { parseSymbolFilters } from '../src/engine/precision';
import { findOrphanEntryOrders } from '../src/lib/orphanEntry';
import { sendWebPushToUser } from '../src/lib/webpush';
import { runS3aLive } from '../src/engine/s3aLive';
import { runPrep } from '../src/lib/s3s1/engine';
import { binanceS3S1Deps } from '../src/lib/s3s1/deps';
import { fetchClosedBars, fetchFundingHistory } from '../src/api/binance';

const isLive = process.argv.includes('--live');
if (isLive) {
  console.error('❌ --live 尚未開放：目前只支援 testnet。');
  process.exit(1);
}

const CYCLE_MS = 15_000;
// 2026-08-23：TTL 240 秒、60 秒寫一次（原本每 15 秒寫、TTL 90 秒，一天吃掉 11,520 次 Redis 指令，
// 佔 Upstash 免費額度 69%，額度真的被燒完過）。
const HEARTBEAT_KEY_PREFIX = 'live-runner:heartbeat:';
const HEARTBEAT_TTL_SEC = 240;
const HEARTBEAT_WRITE_MS = 60_000;
// kill switch 是人工緊急開關，快取 60 秒（按下後最多 60 秒生效），換掉每天 4,320 次 Redis 讀取。
const KILLSWITCH_POLL_MS = 60_000;

function nowStr(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// axios 錯誤的 String(e) 只有泛用訊息，幣安真正的錯誤代碼在 err.response.data。
function describeError(e: unknown): string {
  const resp = (e as { response?: { data?: { code?: number; msg?: string } } })?.response;
  if (resp?.data) return `幣安回應 [${resp.data.code}] ${resp.data.msg}`;
  return String(e).slice(0, 200);
}

// ── 心跳 ─────────────────────────────────────────────────────────────
// kill switch 啟動中也要寫（「暫停交易」不等於「process 死了」）。
// 2026-08-26 起雙寫 Redis＋Supabase：8/23 Upstash 額度用盡時只靠 Redis 一個來源，
// 整整三天沒有任何東西在監控持倉，而且完全無聲。兩個來源獨立失敗才會判斷不了。
let lastHeartbeatAt = 0;
let dbHeartbeatColumnMissing = false;
async function writeHeartbeat(redis: Redis, supabase: SupabaseClient, userId: string): Promise<void> {
  if (Date.now() - lastHeartbeatAt < HEARTBEAT_WRITE_MS) return;
  const at = Date.now();
  let redisOk = false;
  try {
    await redis.set(`${HEARTBEAT_KEY_PREFIX}${userId}`, at, { ex: HEARTBEAT_TTL_SEC });
    redisOk = true;
  } catch (e) {
    console.error(`[heartbeat] Redis 寫入失敗: ${String(e).slice(0, 150)}`);
  }
  let dbOk = false;
  if (!dbHeartbeatColumnMissing) {
    const { error } = await supabase.from('profiles').update({ live_runner_heartbeat_at: at }).eq('id', userId);
    if (error) {
      if (error.code === '42703' || error.code === 'PGRST204') {
        dbHeartbeatColumnMissing = true;
        console.error('⚠  profiles.live_runner_heartbeat_at 欄位不存在——Redis 掛掉時 Vercel 判斷不了這支死活。');
        console.error('⚠  請執行：ALTER TABLE profiles ADD COLUMN IF NOT EXISTS live_runner_heartbeat_at BIGINT;');
      } else {
        console.error(`[heartbeat] Supabase 寫入失敗: [${error.code}] ${error.message}`);
      }
    } else {
      dbOk = true;
    }
  }
  // 任一邊成功才推進節流時戳；兩邊都失敗時下一輪立刻重試，不讓心跳靜默斷掉。
  if (redisOk || dbOk) lastHeartbeatAt = at;
}

// ── kill switch ─────────────────────────────────────────────────────
// Redis 讀不到時保留上一次讀到的值，沒讀過就當作未啟動（見 killSwitch.ts 對這個取捨的說明）。
let lastKsAt = 0;
let cachedKs: KillSwitchState = { active: false, reason: null, activatedAt: null, readable: false };
let ksWarnedAt = 0;
async function pollKillSwitch(redis: Redis): Promise<KillSwitchState> {
  if (Date.now() - lastKsAt < KILLSWITCH_POLL_MS) return cachedKs;
  const ks = await getKillSwitchState(redis);
  lastKsAt = Date.now();
  if (ks.readable) {
    cachedKs = ks;
  } else if (Date.now() - ksWarnedAt > 10 * 60_000) {
    ksWarnedAt = Date.now();
    console.error(`[killswitch] ⚠ 讀取失敗（Redis 異常）——當作未啟動，持倉監控照常進行。`);
  }
  return cachedKs;
}

// ── 全帳戶對帳 ───────────────────────────────────────────────────────
// 涵蓋所有 symbol（不分策略、也看得到手機 App 手動下的單），抓「交易所上有、但沒人在管」的殘留。
//   - orphan_stop_order：沒有持倉的條件單。2026-08-18 XRPUSDT 一張殘留的止盈單被重複回報一整天——
//     等那個幣下次進場，它會用舊價位把新部位平掉。撤掉不會讓任何部位失去保護（定義上沒有持倉）。
//   - 舊策略的殘留進場單（clientOrderId `trade-…-entry`）：2026-09-23 SOL/ZEC 兩張從 09-01 掛到 09-23，
//     成交就是沒人管的裸倉。舊策略已移除，這種格式的單一律是孤兒。手動下的單格式不同，不碰。
//   - position_without_stop：只記 log（S3 自己會補止損；手動部位不該被自動處理）。
async function runAccountWatch(binance: BinanceFuturesClient, redis: Redis, supabase: SupabaseClient, userId: string): Promise<void> {
  await writeHeartbeat(redis, supabase, userId);
  const ks = await pollKillSwitch(redis);
  if (ks.active) {
    console.log(`[${nowStr()}] kill switch 啟動中（${ks.reason ?? '無原因記錄'}）— 跳過整輪`);
    return;
  }
  const [positions, openOrders, openAlgoOrders] = await Promise.all([
    binance.getPositionRisk(), binance.getOpenOrders(), binance.getOpenAlgoOrders(),
  ]);
  const anomalies = reconcilePositionsAndOrders(positions, openOrders, openAlgoOrders);
  if (anomalies.length > 0) {
    console.log(`[${nowStr()}] ⚠ 全帳戶對帳異常 ${anomalies.length} 筆:`);
    for (const a of anomalies) console.log(`   ${JSON.stringify(a)}`);
    for (const a of anomalies) {
      if (a.kind !== 'orphan_stop_order' || a.orderId === undefined) continue;
      try {
        await binance.cancelOrder(a.symbol, a.orderId, true);
        console.log(`[${nowStr()}] 🧹 已撤銷孤兒條件單 ${a.symbol} orderId=${a.orderId}（沒有對應持倉）`);
      } catch (e) {
        console.error(`[${nowStr()}] 撤銷孤兒條件單 ${a.symbol} orderId=${a.orderId} 失敗（下輪會再試）: ${describeError(e)}`);
      }
    }
  }
  for (const o of findOrphanEntryOrders(openOrders, new Set())) {
    try {
      await binance.cancelOrder(o.symbol, o.orderId, false);
      console.log(`[${nowStr()}] 🧹 已撤銷舊策略殘留進場單 ${o.symbol} orderId=${o.orderId}（${o.tradeId}）`);
    } catch (e) {
      console.error(`[${nowStr()}] 撤銷殘留進場單 ${o.symbol} orderId=${o.orderId} 失敗（下輪會再試）: ${describeError(e)}`);
    }
  }
}

// ── S3-A＋S3-B（研究端 2026-10-06 部署文件；同一個 testnet 帳戶真的下單、內部分帳）──────────────────
// S3 的單在 Redis s3a-live:*。S3A_DRY_RUN=1：只印出會做的動作、不下單。
let s3aFilters: Map<string, { stepSize: number; tickSize: number; minNotional: number; minQty?: number }> | null = null;
let s3aFiltersAt = 0;
let s3aPrepTriedAt = 0;
async function runS3aCycle(binance: BinanceFuturesClient, redis: Redis, userId: string): Promise<void> {
  const ks = await pollKillSwitch(redis);
  if (ks.active) return; // kill switch 啟動中不做任何下單／改單
  if (!s3aFilters || Date.now() - s3aFiltersAt > 3_600_000) {
    s3aFilters = parseSymbolFilters(await binance.getExchangeInfo() as Parameters<typeof parseSymbolFilters>[0]);
    s3aFiltersAt = Date.now();
  }
  await runS3aLive({
    client: binance,
    store: redis,
    filters: s3aFilters,
    mainnetDaily: s => fetchClosedBars(s, '1d', 499),
    mainnetFunding: (s, t) => fetchFundingHistory(s, 100, t),
    ensurePrep: async now => {
      const X = Math.floor(now / 86_400_000) * 86_400_000;
      if (await redis.get(`s3s1:prep:${X}`)) return;
      if (Date.now() - s3aPrepTriedAt < 10 * 60_000) return; // 很重（全市場日線），10 分鐘最多試一次
      s3aPrepTriedAt = Date.now();
      console.log(`[${nowStr()}] S3：今天的 prep 快照還沒有，自己算（約 10 秒）`);
      await runPrep(redis, binanceS3S1Deps, now);
    },
    notify: async (title, body) => { await sendWebPushToUser(userId, { title, body, tag: 's3a' }).catch(() => undefined); },
    log: msg => console.log(`[${nowStr()}]${msg.startsWith(' ') ? '' : ' '}${msg}`),
    dryRun: process.env.S3A_DRY_RUN === '1',
    killSwitch: false,
    now: Date.now(),
  });
}

async function main() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    console.error('❌ UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 未設定');
    process.exit(1);
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌ NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 未設定');
    process.exit(1);
  }
  if (!process.env.TRADING_USER_ID) {
    console.error('❌ TRADING_USER_ID 未設定（Supabase profiles.id）');
    process.exit(1);
  }
  // 2026-08-12：VAPID 沒設時這支的推播全部靜默失敗（「只收得到推薦單」事件）。刻意不 exit：
  // 推播是輔助，不該擋掉真倉監控；改成啟動時大聲講。
  if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    console.error('');
    console.error('⚠️  ════════════════════════════════════════════════════════');
    console.error('⚠️   VAPID 金鑰未設定 —— 這支不會發出任何推播通知');
    console.error('⚠️   （S3 進場／止盈／加碼／移動止損／出場 全部收不到）');
    console.error('⚠️   補救：把 Vercel 專案裡這兩個環境變數設到這台機器再重啟');
    console.error('⚠️     NEXT_PUBLIC_VAPID_PUBLIC_KEY');
    console.error('⚠️     VAPID_PRIVATE_KEY');
    console.error('⚠️   （必須跟 Vercel 上同一組——換一組會讓手機既有訂閱失效）');
    console.error('⚠️  ════════════════════════════════════════════════════════');
    console.error('');
  } else {
    console.log(`[${nowStr()}] ✅ Web Push 已啟用（VAPID 金鑰已設定）`);
  }

  const redis = Redis.fromEnv();
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const binance = new BinanceFuturesClient(loadBinanceConfigFromEnv(true)); // testnet 固定 true，直到 --live 開放
  const userId = process.env.TRADING_USER_ID;

  console.log(`[${nowStr()}] live-runner 啟動（testnet，${CYCLE_MS / 1000}秒/輪，會真的下單）`);
  console.log(`[${nowStr()}] S3-A＋S3-B：${process.env.S3A_DRY_RUN === '1' ? '試跑模式（S3A_DRY_RUN=1，只印出動作、不下單）' : '真的下單（testnet）'}`);

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
      await runAccountWatch(binance, redis, supabase, userId);
    } catch (e) {
      console.log(`[${nowStr()}] ❌ 心跳／對帳這輪失敗（不影響 S3、不影響下一輪）: ${describeError(e)}`);
    }
    try {
      await runS3aCycle(binance, redis, userId);
    } catch (e) {
      console.log(`[${nowStr()}] ❌ S3 這輪失敗（不影響下一輪）: ${String(e).slice(0, 200)}`);
    }
    await new Promise(r => setTimeout(r, Math.max(0, CYCLE_MS - (Date.now() - cycleStart))));
  }
}

main().catch(e => {
  console.error(`[${nowStr()}] 致命錯誤，process 結束: ${String(e)}`);
  process.exit(1);
});
