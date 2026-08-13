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
 * 環境變數（不要貼在 chat 裡，只設在主機/本機上）：
 *   BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN（跟 Vercel 專案同一個
 *     Upstash 執行個體 —— kill switch 是共用狀態，Vercel 那邊的 /api/analyze
 *     跟這支 process 要看到同一個開關）
 *   NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY（跟 Vercel 專案同一個
 *     Supabase 專案，走 service role 不是 anon key，跟 route.ts 對 DB 的權限
 *     一致）
 *   TRADING_USER_ID：Supabase 的 profiles.id（UUID）——這支只服務單一使用者，
 *     不走完整的登入流程，直接指定要監控誰的 trades
 *   NEXT_PUBLIC_VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY（Web Push 推播用，跟
 *     Vercel 專案同一組金鑰——換一組會讓手機上既有的推播訂閱全部失效）。
 *     2026-08-12 補上這一行：先前這裡漏列，導致使用者照文件設好其餘變數後
 *     「進場/出場通知全部收不到、只收得到推薦單」（推薦單是 Vercel 發的，
 *     不受影響）。沒設不會擋住交易，但啟動時會印出明顯警告，見 main()。
 *
 * ── 這版本做的事 ────────────────────────────────────────────────────────
 * 1. Kill switch 檢查（fail closed）——啟動中就整輪跳過，不做任何下單/改單。
 * 2. 全帳戶對帳（watchdog.reconcilePositionsAndOrders）——涵蓋所有 symbol，
 *    不只 DB 追蹤範圍內的，抓「DB 寫入失敗導致行方不明」這類 DB 追蹤不到的
 *    裸倉異常。純觀察 log，不在這裡自動修復（不知道該修哪個 trade_id）。
 * 3. 逐筆處理 Supabase 裡這個使用者所有還沒結束的 trades：組出交易所快照
 *    （倉位/掛單/條件單/現價，需要時才查 ATR/歷史成交）→ decideTradeAction
 *    決定該做什麼（含時間止損／盤整停滯）→ executeTradeAction 真的送出去
 *    + 寫回 DB → TP1 部分平倉/最終出場時推播 Web Push 通知。
 *
 * 2026-08-09：使用者一旦設定 profiles.live_trading_enabled=true，route.ts
 * 的 DB 模擬監控會完全排除這個使用者（見 route.ts 頂部說明），包括它原本
 * 的推播邏輯——這支必須自己補上通知，不然使用者完全不會知道 TP1/關單發生
 * 過（實測撞到：使用者是自己開 App 才發現 TP2 已經達標，不是被動收到推播）。
 *
 * 2026-08-10：這支每輪會寫一個 Redis 心跳（TTL 90秒）。route.ts 用這個
 * 心跳判斷「live_trading_enabled=true 是不是還有對應的 process 真的在
 * 跑」——使用者可能把這支關掉卻忘記把那個欄位改回 false，沒有心跳的話
 * route.ts 會自動接手，不然兩邊都不管，比使用者根本沒開自動交易還危險。
 *
 * 2026-08-10：TP1 從「輪詢比價、觸價才送 MARKET 單」改成「一有止損就順便
 * 預掛 TAKE_PROFIT_MARKET 條件單」——輪詢式如果價格插針式碰到 tp1 又馬上
 * 彈回去（兩輪之間 15 秒），下一輪就再也偵測不到，TP1 部分平倉的機會真的
 * 會錯過；改成掛在交易所端，觸發跟止損一樣即時，不怕插針。詳見
 * src/engine/orderLifecycle.ts 的 decideTp1OrderPlacement 說明。
 *
 * --live 旗標刻意 exit(1) 拒絕——這是本次改動唯一保留的安全閥，確保這支
 * 腳本目前只會碰 testnet 帳戶，不會不小心連到正式帳戶。
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Redis } from '@upstash/redis';
import {
  BinanceFuturesClient, loadBinanceConfigFromEnv, MarginBracket,
} from '../src/engine/binanceClient';
import { getKillSwitchState } from '../src/engine/killSwitch';
import { reconcilePositionsAndOrders } from '../src/engine/watchdog';
import { findMarginBracket } from '../src/engine/liquidation';
import { SymbolFilters, parseSymbolFilters } from '../src/engine/precision';
import {
  decideTradeAction, deriveLiveCloseReason, BridgeTradeRow, BridgeExchangeSnapshot, RiskCheckInput, TradeAction,
} from '../src/engine/tradeBridge';
import { extractBinanceErrorCode } from '../src/engine/pendingOrderLifecycle';
import { TimeStopCloseReason } from '../src/engine/timeStop';
import { executeTradeAction, TradeExecutorClient, TradePersistence } from '../src/engine/tradeExecutor';
import { calcSimpleAtr, TP1_PARTIAL_FRACTION, updateMfeMae } from '../src/lib/monitorMath';
import { calcPositionPlan, MAX_TOTAL_RISK_PCT } from '../src/lib/position';
import { fetchCandles, fetchCurrentPrice } from '../src/api/binance';
import { sendWebPushToUser } from '../src/lib/webpush';

const isLive = process.argv.includes('--live');
if (isLive) {
  console.error('❌ --live 尚未開放：目前只支援 testnet。');
  process.exit(1);
}

const CYCLE_MS = 15_000; // 15 秒一輪，比 Vercel 5 分鐘 cron 細很多
const DEFAULT_MAX_LEVERAGE = 10;
// route.ts 用同一個 key 前綴判斷這支還活著沒有。90 秒 ≈ 6 輪緩衝，避免
// 單輪因為 API 延遲稍微拖長就被誤判成「process 已經停了」。
const HEARTBEAT_KEY_PREFIX = 'live-runner:heartbeat:';
const HEARTBEAT_TTL_SEC = 90;

// 這些幣安錯誤代碼代表「這筆單本質上就不可能成功」——不是網路抖動、不是
// 暫時性 rate limit，重試沒有意義，只會每輪浪費一次 API 呼叫、洗版 log。
// 見到就把這筆推薦單標記取消，不要無限重試。
//   -4141 Symbol is closed（這個交易對目前不接受新單，2026-08-09 實測
//         MMTUSDT 在 demo trading 撞到）
//   -1121 Invalid symbol（symbol 打錯或這個交易對根本不存在）
const NON_RETRYABLE_BINANCE_CODES = new Set([-4141, -1121]);

// finalizeClosed 用來判斷 row.close_reason 是不是 markForceCloseReason 先寫
// 進去的合法 pending 值（見該函式說明），不是隨便什麼字串都當真。
const PENDING_CLOSE_REASONS = new Set<string>(['time_stop_stall', 'time_stop_expiry', 'time_stop_expiry_post_tp1']);

// 推播標題用的關單原因文案。跟 trades/page.tsx 的 CLOSE_REASON_LABEL 是
// 兩套刻意分開的東西：那邊是紀錄頁的完整敘述（「時間止損（盤面停滯）」），
// 這邊要塞進推播標題跟 symbol 併排，得短。共用同一組 key 值以免對不上。
const CLOSE_REASON_PUSH_LABEL: Record<string, string> = {
  time_stop_stall:           '⏱ 盤整停滯平倉',
  time_stop_expiry:          '⏱ 到期平倉',
  time_stop_expiry_post_tp1: '⏱ 到期平倉(TP1已達標)',
};

function nowStr(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

interface DbTradeRow {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entry: number;
  stop_loss: number;
  tp1: number;
  tp2: number;
  strategy: string | null;
  timeframe: string | null;
  status: string;
  suggested_risk_pct: number | null;
  filled_at: number | null;
  opened_at: number;
  entry_qty: number | null;
  exchange_entry_order_id: number | null;
  exchange_stop_algo_id: number | null;
  exchange_tp1_algo_id: number | null;
  mfe_price: number | null;
  mae_price: number | null;
  close_reason: string | null;
}

const VALID_TIMEFRAMES = new Set(['5m', '15m', '1h', '4h', '1d']);

function toBridgeTradeRow(row: DbTradeRow): BridgeTradeRow {
  return {
    id: row.id,
    symbol: row.symbol,
    isLong: row.direction === 'LONG',
    entry: row.entry,
    stopLoss: row.stop_loss,
    tp1: row.tp1,
    strategy: row.strategy === 'B' ? 'B' : 'A',
    // 資料庫欄位是自由字串，時間止損只認得這五種——不認得的一律當 1h
    // （route.ts tfBarMinutes 的 default 分支同一個處理方式，不是另外發明的）。
    timeframe: (VALID_TIMEFRAMES.has(row.timeframe ?? '') ? row.timeframe : '1h') as BridgeTradeRow['timeframe'],
    filledAt: row.filled_at ?? row.opened_at ?? null,
    openedAt: row.opened_at,
    entryQty: row.entry_qty,
    exchangeEntryOrderId: row.exchange_entry_order_id,
    exchangeStopAlgoId: row.exchange_stop_algo_id,
    exchangeTp1AlgoId: row.exchange_tp1_algo_id,
  };
}

// 每筆 trade 各自建立一個 persistence——比共用一個全域物件簡單，執行層本來
// 就是逐筆呼叫，不需要跨 trade 共享狀態。
function makePersistence(supabase: SupabaseClient, row: DbTradeRow): TradePersistence {
  const logErr = (op: string, error: { code?: string; message: string } | null) => {
    if (error) console.error(`[persist] ${op} ${row.id} 失敗: [${error.code}] ${error.message}`);
  };
  return {
    async setEntryOrderId(tradeId, orderId) {
      const { error } = await supabase.from('trades').update({ exchange_entry_order_id: orderId }).eq('id', tradeId);
      logErr('setEntryOrderId', error);
    },
    async setStopAlgoId(tradeId, algoId) {
      const { error } = await supabase.from('trades').update({ exchange_stop_algo_id: algoId }).eq('id', tradeId);
      logErr('setStopAlgoId', error);
    },
    async setTp1AlgoId(tradeId, algoId) {
      const { error } = await supabase.from('trades').update({ exchange_tp1_algo_id: algoId }).eq('id', tradeId);
      logErr('setTp1AlgoId', error);
    },
    async markTp1Hit(tradeId) {
      const { error } = await supabase.from('trades').update({ status: 'tp1_hit' }).eq('id', tradeId);
      logErr('markTp1Hit', error);
    },
    async finalizeClosed(tradeId, result) {
      // pnl_percent 維持跟 DB 模擬版同一個計算基礎（價格百分比，不是保證金
      // ROI）——CLAUDE.md「損益一律用 R 倍數」，R = pnl_percent ÷ 止損距離%，
      // 這個換算全站通用，這裡如果改用 realizedPnl/margin 算出來的 ROI%，
      // 下游所有 R 倍數計算會全部跟著失真。realizedPnl（真實 USDT 金額）
      // 另外沒有欄位可存，先不寫，之後要看要不要加欄位。
      const pnlPercent = row.direction === 'LONG'
        ? (result.exitPrice - row.entry) / row.entry * 100
        : (row.entry - result.exitPrice) / row.entry * 100;
      // 2026-08-12：close_reason 原本無論如何都硬寫 'live_auto_sync'，看不出
      // 真倉是被止損掃到還是時間止損強制平倉——row.close_reason 如果已經是
      // markForceCloseReason 先寫進去的 pending 值，代表是我們自己主動關的，
      // 直接採用；不是的話（包含舊資料殘留的非預期字串，防呆用 Set 檢查）
      // 才退回 deriveLiveCloseReason 用既有事實（策略/輸贏）推論，見
      // tradeBridge.ts 該函式的說明——不是用出場價猜。
      const pending = row.close_reason !== null && PENDING_CLOSE_REASONS.has(row.close_reason)
        ? row.close_reason as TimeStopCloseReason
        : null;
      const closeReason = deriveLiveCloseReason({ pendingCloseReason: pending, strategy: row.strategy === 'B' ? 'B' : 'A', result: result.result });
      const { error } = await supabase.from('trades').update({
        result: result.result,
        exit_price: result.exitPrice,
        pnl_percent: parseFloat(pnlPercent.toFixed(2)),
        closed_at: Date.now(),
        close_reason: closeReason,
      }).eq('id', tradeId);
      logErr('finalizeClosed', error);
    },
    async markForceCloseReason(tradeId, reason) {
      const { error } = await supabase.from('trades').update({ close_reason: reason }).eq('id', tradeId);
      logErr('markForceCloseReason', error);
    },
    async markEntryNeverFilled(tradeId) {
      // 進場單消失但查無任何成交紀錄——從未真的開過倉，result 用
      // CANCELLED（既有 enum 值，跟 route.ts 的「掛單過期」同一個語意），
      // 不用 WIN_TP1/LOSS（那兩個是「真的開過倉」才有意義的分類）。
      const { error } = await supabase.from('trades').update({
        status: 'cancelled', result: 'CANCELLED', closed_at: Date.now(), close_reason: 'live_entry_expired',
      }).eq('id', tradeId);
      logErr('markEntryNeverFilled', error);
    },
    async markFilled(tradeId, filledAt) {
      // status='active' 是 trades/page.tsx 判斷「已經進場、脫離等待進場」
      // 的欄位——跟 route.ts 的 Phase 1 fill-detection 寫的是同一個值，
      // filled_at 也是同一個欄位，全站對「進場了沒」的判斷方式維持一致。
      const { error } = await supabase.from('trades').update({
        status: 'active', filled_at: filledAt,
      }).eq('id', tradeId);
      logErr('markFilled', error);
    },
    async setEntryQty(tradeId, entryQty) {
      const { error } = await supabase.from('trades').update({ entry_qty: entryQty }).eq('id', tradeId);
      logErr('setEntryQty', error);
    },
  };
}

async function buildSnapshot(
  binance: BinanceFuturesClient,
  row: DbTradeRow,
  filters: SymbolFilters,
): Promise<BridgeExchangeSnapshot> {
  const [positions, openOrders, openAlgoOrders, markPrice] = await Promise.all([
    binance.getPositionRisk(row.symbol),
    binance.getOpenOrders(row.symbol),
    binance.getOpenAlgoOrders(row.symbol),
    fetchCurrentPrice(row.symbol),
  ]);

  const positionQty = positions[0] ? Math.abs(parseFloat(positions[0].positionAmt)) : 0;
  const entryOrderStillOpen = row.exchange_entry_order_id !== null
    && openOrders.some(o => o.orderId === row.exchange_entry_order_id);

  const stopOrder = row.exchange_stop_algo_id !== null
    ? openAlgoOrders.find(a => a.algoId === row.exchange_stop_algo_id)
    : undefined;
  const currentStop = stopOrder
    ? { algoId: stopOrder.algoId, triggerPrice: parseFloat(stopOrder.triggerPrice) }
    : null;

  // ATR 只有「策略A + 已經過 TP1」需要（移動止損棘輪）——其他情況不用多打
  //一次 K 線請求。
  let atr1h: number | undefined;
  if (row.status === 'tp1_hit' && (row.strategy ?? 'A') === 'A') {
    try {
      const candles = await fetchCandles(row.symbol, '1h', 20);
      atr1h = calcSimpleAtr(candles, 14);
    } catch (e) {
      console.error(`[snapshot] ${row.symbol} ATR 抓取失敗，這輪移動止損跳過: ${String(e).slice(0, 150)}`);
    }
  }

  // recentTrades 只在「部位消失、需要對帳」那一刻才查——用 filled_at（沒有
  // 就退回 opened_at）當時間下限，避免抓到同一個 symbol 更早、不相關的
  // 歷史成交（trades 表有 one-open-per-symbol 限制，但關閉後同 symbol 可能
  // 再開新單）。
  let recentTrades;
  if (positionQty === 0 && !entryOrderStillOpen && row.exchange_entry_order_id !== null) {
    try {
      const startTime = row.filled_at ?? row.opened_at;
      recentTrades = await binance.getUserTrades(row.symbol, { startTime });
    } catch (e) {
      console.error(`[snapshot] ${row.symbol} getUserTrades 失敗，這輪標記需要對帳: ${String(e).slice(0, 150)}`);
    }
  }

  return { positionQty, entryOrderStillOpen, currentStop, markPrice, filters, recentTrades, atr1h, now: Date.now() };
}

async function buildRiskInput(
  binance: BinanceFuturesClient,
  row: DbTradeRow,
  totalOpenRiskPct: number,
): Promise<(RiskCheckInput & { leverage: number }) | null> {
  const balances = await binance.getBalance();
  const usdt = balances.find(b => b.asset === 'USDT');
  const accountEquity = usdt ? parseFloat(usdt.availableBalance) : 0;
  const riskPct = row.suggested_risk_pct ?? 1;

  const plan = calcPositionPlan(accountEquity, riskPct, row.entry, row.stop_loss, DEFAULT_MAX_LEVERAGE);
  const positionUSDT = plan?.positionUSDT ?? 0;
  const marginUSDT = plan?.marginUSDT ?? 0;
  // checkLiquidationSafety（下面呼叫端）用這個 marginUSDT 當 isolatedMarginUSDT
  // 去預測強平價，這個預測只有在幣安帳戶端真的用同一個槓桿倍數下單時才成立
  // ——leverage 帶出去讓呼叫端在真的送出第一張進場單前呼叫 setLeverage 對齊。
  const leverage = plan?.leverage ?? 1;

  const bracketsRes = await binance.getLeverageBrackets(row.symbol);
  const brackets: MarginBracket[] = bracketsRes[0]?.brackets ?? [];
  if (brackets.length === 0) {
    // 抓不到分級資料時寧可整個跳過這筆（下一輪重試），不要用 0 或任何猜測值
    // 硬填——maintMarginRatio 填低了會讓 checkLiquidationSafety 算出的強平價
    // 比實際更寬鬆（誤判成更安全），這是危險方向的錯誤，比「這筆晚一輪才
    // 進場」嚴重得多。
    console.error(`[risk] ${row.symbol} 抓不到 leverageBrackets 分級資料，這輪跳過進場判斷`);
    return null;
  }
  const bracket = findMarginBracket(brackets, positionUSDT);

  return {
    positionUSDT,
    totalOpenRiskPct,
    thisTradeRiskPct: riskPct,
    liquidation: {
      isolatedMarginUSDT: marginUSDT,
      maintMarginRatio: bracket.maintMarginRatio,
      maintAmount: bracket.cum,
    },
    leverage,
  };
}

// route.ts 沒了這個使用者之後不會再推播——見檔案頂部說明。只有兩個時刻值得
// 通知：TP1 達標（第一次獲利了結）、最終出場（sync_closed_position，這時候
// 才有真實成交價/損益可以講，close_full_position 本身只是送出關單，還不
// 知道最終結果，不在那個分支推播）。
//
// 2026-08-10：TP1 改成預掛條件單後，「TP1 達標」不再是某個 action 執行完
// 當下就知道的事（見 tradeBridge.ts 第5步說明）——是主迴圈自我修復偵測到
// 部位變小才發現，通知呼叫點跟著搬到那裡，這裡只保留 sync_closed_position。
// 2026-08-10：實測撞到——使用者開了 live_trading_enabled 後完全收不到任何
// 推播。route.ts 的「掛單成交」通知（第 562 行附近）因為這個使用者被
// excludeLiveUsers 排除而不會跑；這支原本只補了 TP1 達標跟最終出場兩個
// 時機，漏掉「進場成交」這個最先觸發、使用者最常見到的通知——如果一筆單
// 進場後還沒到 TP1、也還沒出場，使用者會覺得「開了自動交易後什麼通知都
// 沒有」，其實是這個時機點沒補上，不是推播機制本身壞了。
async function notifyFilled(userId: string, row: DbTradeRow, fillPrice: number): Promise<void> {
  const sym = row.symbol.replace('USDT', '/USDT');
  const dir = row.direction === 'LONG' ? '▲ 做多' : '▼ 做空';
  await sendWebPushToUser(userId, {
    title: `✅ 掛單成交 ${sym}`,
    body: `${dir} 成交價 $${fillPrice} ｜ TP1 $${row.tp1} ｜ SL $${row.stop_loss}`,
    tag: `fill-${row.id}`,
  });
}

async function notifyTp1Hit(userId: string, row: DbTradeRow): Promise<void> {
  const sym = row.symbol.replace('USDT', '/USDT');
  const dir = row.direction === 'LONG' ? '▲ 做多' : '▼ 做空';
  await sendWebPushToUser(userId, {
    title: `🎯 TP1 達標 ${sym}`,
    body: `${dir} 部分平倉已成交，剩餘倉位交給 live-runner 自動管理移動止損`,
    tag: `tp1-${row.id}`,
  });
}

// 2026-08-10：使用者要求「跟開自動交易之前一樣，每個通知都要有」——盤點
// route.ts 原本對這個使用者發過的所有推播時機，逐一補齊，不是只挑「看起來
// 重要」的兩三個。route.ts 的六個推播點：①掛單成交②推薦單失效（掛單過期）
// ③移動止損上移④TP1達標⑤最終出場⑥新訊號通知。⑥完全不受
// excludeLiveUsers 影響（新訊號推播跟這筆使用者是不是交給 live-runner 無
// 關），一直都在；①④已經補了（notifyFilled/notifyTp1Hit）；這裡補②③。
//
// prevStopTriggerPrice：只有 update_trailing_stop 用得到——算「這次移動
// 鎖住了多少 R」要跟移動前的止損價比較，這個值只存在於呼叫端手上的
// snapshot（action 本身沒有帶舊止損價），所以用參數傳進來而不是塞進
// TradeAction 型別（那個型別是 tradeBridge.ts 的純決策輸出，不該為了
// 通知這種副作用需求污染它的形狀）。
async function notifyIfNeeded(
  userId: string, row: DbTradeRow, action: TradeAction, prevStopTriggerPrice: number | null,
): Promise<void> {
  const sym = row.symbol.replace('USDT', '/USDT');
  const dir = row.direction === 'LONG' ? '▲ 做多' : '▼ 做空';

  if (action.kind === 'entry_never_filled') {
    await sendWebPushToUser(userId, {
      title: `推薦單失效 ${sym}`,
      body: `${dir} 未進場，掛單已取消（非持倉）`,
      tag: `cancel-${row.id}`,
    });
    return;
  }

  if (action.kind === 'update_trailing_stop') {
    // route.ts 同款節流：只在鎖住的 R 提升 ≥0.15 才推播，避免棘輪每輪
    // 微幅移動就洗版（見 route.ts:851 同一道門檻，數字照抄不是重新設計）。
    const isLong = row.direction === 'LONG';
    const riskDist = Math.abs(row.entry - row.stop_loss);
    if (riskDist > 0 && prevStopTriggerPrice !== null) {
      const rOf = (stop: number) => (isLong ? stop - row.entry : row.entry - stop) / riskDist;
      const prevR = rOf(prevStopTriggerPrice);
      const newR = rOf(action.place.stopPrice as number);
      if (newR > prevR + 0.15) {
        await sendWebPushToUser(userId, {
          title: `🛡 ${sym} 移動止損上移`,
          body: `${dir} 止損上移至 $${action.place.stopPrice}（鎖 +${newR.toFixed(1)}R），續抱等出場`,
          tag: `trail-${row.id}`,
        });
      }
    }
    return;
  }

  // 2026-08-13：以下三種 action 之前全部落到最後那行 `return`，一則通知都
  // 不會發——使用者實測回報「時間止損、時間取消掛單都收不到」，根因就是
  // 這裡。notifyIfNeeded 是對「所有已執行的 action」呼叫的（主迴圈
  // result.executed 分支），但函式本身只認得 3 種 kind，其餘靜默略過。

  // ① 掛單超過 4 根 K 線未成交，我方主動撤單（2026-08-11 新增的 action，
  //    當時只補了執行與清理，漏了通知）。跟 entry_never_filled 語意相同
  //    （從未開倉）但成因不同：那個是掛單在交易所端自己消失，這個是我們
  //    依規格 §3-A 主動撤掉的，文案要分得出來。
  if (action.kind === 'cancel_stale_entry') {
    await sendWebPushToUser(userId, {
      title: `⏱ 掛單逾期取消 ${sym}`,
      body: `${dir} 掛單超過 4 根 K 線未成交，已主動撤單（未進場，非持倉）`,
      tag: `stale-${row.id}`,
    });
    return;
  }

  // ② 時間止損／盤整停滯／到期平倉——我方主動送出 MARKET 平倉單的那一刻。
  //    這裡發的是「為什麼關」，下一輪 sync_closed_position 才有實際成交價與
  //    損益（MARKET 單 ACK 不保證帶精確成交價，見 tradeExecutor.ts 說明），
  //    兩則各自有用，不是重複：使用者需要立刻知道系統主動關了倉。
  if (action.kind === 'close_full_position') {
    await sendWebPushToUser(userId, {
      title: `${CLOSE_REASON_PUSH_LABEL[action.closeReason] ?? '⏱ 系統平倉'} ${sym}`,
      body: `${dir} 系統主動平倉中，成交結果稍後回報`,
      tag: `forceclose-${row.id}`,
    });
    return;
  }

  if (action.kind !== 'sync_closed_position') return;

  // ③ 出場通知原本只用損益正負分「出場獲利 / 止損出場」，時間止損關掉的單
  //    因此被標成「❌ 止損出場」——使用者看到會以為是價格碰到止損價，分不出
  //    是系統主動關的。2026-08-12 起 markForceCloseReason 會把真正的關單原因
  //    先寫進 DB，而 row 是每輪重新查的（select 已含 close_reason），所以這裡
  //    讀得到那個 pending 值，可以標對。讀不到才退回原本的損益正負判斷。
  const pending = row.close_reason !== null && PENDING_CLOSE_REASONS.has(row.close_reason)
    ? row.close_reason as TimeStopCloseReason
    : null;
  const label = pending
    ? (CLOSE_REASON_PUSH_LABEL[pending] ?? '⏱ 系統平倉')
    : (action.result === 'WIN_TP1' ? '✅ 出場獲利' : '❌ 止損出場');
  const pnlStr = `${action.realizedPnl >= 0 ? '+' : ''}${action.realizedPnl.toFixed(2)} USDT`;
  await sendWebPushToUser(userId, {
    title: `${label} ${sym}`,
    body: `${dir} 出場 $${action.avgExitPrice.toFixed(4)} ｜ 實現損益 ${pnlStr}`,
    tag: `close-${row.id}`,
  });
}

// 2026-08-11：實測撞到兩個「善後沒收尾」的問題——①時間止損／到期平倉
// (close_full_position 送出 MARKET 單) 後，原本掛著的止盈/止損條件單
// 完全沒被撤銷，殘留在交易所端；使用者截圖看到 BTCUSDT/ZECUSDT/BNBUSDT
// 都還掛著「市價止盈」，即使部位早就不在了——這些殘留的 reduceOnly 條件
// 單如果同一個 symbol 之後又開新倉，觸價時會拿新倉位的部位去執行，等於
// 平白無故被意外減倉。②route.ts 的 tlock:{symbol} 是全站共用的 Redis
// 鎖（不分使用者），insert 新訊號時 setLock，正常應該在關單時
// unlockSymbol——但這支從沒實作過對應的解鎖邏輯，route.ts 排除了這個
// 使用者的 trades 之後（見 excludeLiveUsers），沒有任何一方會釋放這把
// 鎖，導致 symbol 永遠卡在「持倉中」，即使 live-runner 這邊早就平倉了
// （使用者截圖：幣種監控清單 BTC/SOL/PUMP 顯示「跳過—持倉中(LONG)」，
// 但這幾個 symbol 根本沒有真實部位）。
//
// 兩個清理動作合併成一個函式，在「這筆 trade 確定結束」的兩個時間點
// （sync_closed_position 真的平倉過、entry_never_filled 從未成交）都要
// 呼叫——解鎖不看是不是曾經真的開過倉，只要這筆 trade 的生命週期正式
// 結束就該放手；撤條件單只有真的開過倉的情況需要（entry_never_filled
// 從未成交，不會有掛著的條件單）。
//
// 撤單/解鎖都是清理性質，失敗只記 log 不中斷——訂單可能已經因為觸發而
// 自然消失（比如止損被打到才走到這個分支），撤一個不存在的訂單本來就
// 該失敗，那不是需要处理的錯誤。
//
// 2026-08-11：同一輪順手補上另一個對照 route.ts 才發現的遺漏——
// route.ts 的 Phase 2（LOSS 結果或時間止損觸發）都會 setLossCooldown
// （同 symbol+方向 24 小時內不再進場，避免連續在同一個爛 setup 上重複
// 虧損），但這支真倉止損出場後從沒做過這件事。route.ts 的新訊號產生
// 流程本來就會查 loss_cd:{symbol}:{direction} 這個 key（isOnLossCooldown），
// 只要這裡把 key 寫進去，下一次 route.ts 想對這個 symbol/方向重新出訊號
// 就會被正確擋下——不需要 live-runner 自己也去檢查這個 key（它從不主動
// 產生新訊號，只執行 DB 裡已經有的 trade）。
async function cleanupAfterTradeClosed(
  binance: BinanceFuturesClient, redis: Redis, row: DbTradeRow, cancelOrders: boolean, lossResult: boolean,
): Promise<void> {
  if (cancelOrders) {
    for (const algoId of [row.exchange_stop_algo_id, row.exchange_tp1_algo_id]) {
      if (algoId === null) continue;
      try {
        await binance.cancelOrder(row.symbol, algoId, true);
      } catch (e) {
        console.error(`[cleanup] ${row.symbol} 撤條件單 algoId=${algoId} 失敗(可能已觸發/已撤銷,可忽略): ${String(e).slice(0, 120)}`);
      }
    }
  }
  try {
    const key = `tlock:${row.symbol}`;
    const entry = await redis.get<{ sentAt: number; candleBucket: number; direction: string; locked: boolean }>(key);
    if (entry) await redis.set(key, { ...entry, locked: false }, { ex: 24 * 3600 });
  } catch (e) {
    console.error(`[cleanup] ${row.symbol} 解鎖 tlock 失敗: ${String(e).slice(0, 120)}`);
  }
  if (lossResult) {
    try {
      await redis.set(`loss_cd:${row.symbol}:${row.direction}`, '1', { ex: 24 * 3600 });
    } catch (e) {
      console.error(`[cleanup] ${row.symbol} setLossCooldown 失敗: ${String(e).slice(0, 120)}`);
    }
  }
}

// 不管 kill switch 有沒有啟動、這輪有沒有真的做任何動作，只要 process
// 還活著就要回報心跳——kill switch 啟動中不代表「process 死了」，這兩件
// 事不能混在一起判斷，不然 route.ts 會在 kill switch 啟動期間誤判成
// live-runner 已經停止、搶著接手，兩邊同時碰同一批 trades。
async function writeHeartbeat(redis: Redis, userId: string): Promise<void> {
  try {
    await redis.set(`${HEARTBEAT_KEY_PREFIX}${userId}`, Date.now(), { ex: HEARTBEAT_TTL_SEC });
  } catch (e) {
    console.error(`[heartbeat] 寫入失敗: ${String(e).slice(0, 150)}`);
  }
}

async function runCycle(
  supabase: SupabaseClient,
  binance: BinanceFuturesClient,
  redis: Redis,
  userId: string,
): Promise<void> {
  await writeHeartbeat(redis, userId);

  const ks = await getKillSwitchState(redis);
  if (ks.active) {
    console.log(`[${nowStr()}] kill switch 啟動中（${ks.reason ?? '無原因記錄'}）— 跳過整輪`);
    return;
  }

  // 全帳戶對帳——涵蓋所有 symbol，抓 DB 追蹤不到的異常（見檔案頂部說明）。
  try {
    const [positions, openOrders, openAlgoOrders] = await Promise.all([
      binance.getPositionRisk(),
      binance.getOpenOrders(),
      binance.getOpenAlgoOrders(),
    ]);
    const anomalies = reconcilePositionsAndOrders(positions, openOrders, openAlgoOrders);
    if (anomalies.length > 0) {
      console.log(`[${nowStr()}] ⚠ 全帳戶對帳異常 ${anomalies.length} 筆:`);
      for (const a of anomalies) console.log(`   ${JSON.stringify(a)}`);
    }
  } catch (e) {
    console.error(`[${nowStr()}] 全帳戶對帳讀取失敗: ${String(e).slice(0, 150)}`);
  }

  const { data: rows, error } = await supabase
    .from('trades')
    .select('id,symbol,direction,entry,stop_loss,tp1,tp2,strategy,timeframe,status,suggested_risk_pct,filled_at,opened_at,entry_qty,exchange_entry_order_id,exchange_stop_algo_id,exchange_tp1_algo_id,mfe_price,mae_price,close_reason')
    .eq('user_id', userId)
    .is('closed_at', null);

  if (error) {
    console.error(`[${nowStr()}] 讀取 open trades 失敗: [${error.code}] ${error.message}`);
    return;
  }
  const openTrades = (rows ?? []) as DbTradeRow[];
  if (openTrades.length === 0) {
    console.log(`[${nowStr()}] OK，目前沒有開著的推薦單`);
    return;
  }

  const totalOpenRiskPct = openTrades.reduce((s, t) => s + (t.suggested_risk_pct ?? 1), 0);

  const client: TradeExecutorClient = {
    placeOrder: (params) => binance.placeOrder(params),
    cancelOrder: (symbol, orderId, isAlgoOrder) => binance.cancelOrder(symbol, orderId, isAlgoOrder),
  };

  // exchangeInfo 是全市場共用的靜態精度資料，同一輪所有 trade 共用一份，
  // 不用每筆各打一次。
  const exchangeInfo = await binance.getExchangeInfo();
  const filtersMap = parseSymbolFilters(exchangeInfo as Parameters<typeof parseSymbolFilters>[0]);

  for (const row of openTrades) {
    try {
      const filters = filtersMap.get(row.symbol);
      if (!filters) {
        console.error(`[${nowStr()}] ${row.symbol} 找不到 exchangeInfo 精度設定，跳過這筆`);
        continue;
      }

      const snapshot = await buildSnapshot(binance, row, filters);
      const trade = toBridgeTradeRow(row);
      const persist = makePersistence(supabase, row);

      // 自我修復：真的有部位（交易所端確認）但 DB 的 status 還停在
      // 'waiting'，同步一次。不是只靠 place_initial_stop 那一次性時機——
      // 那個時機點在這次修復上線前就已經發生過的舊資料（實測撞到
      // ACEUSDT），永遠不會再觸發，只能靠這種「發現不一致就修」的機制
      // 補回來，之後任何原因造成的同類不一致（比如 DB 寫入當下失敗）也
      // 一併自我修復，不用每種情況各寫一次特殊處理。
      if (snapshot.positionQty > 0 && row.status === 'waiting') {
        await persist.markFilled(row.id, row.filled_at ?? Date.now());
        row.status = 'active'; // 這一輪剩下的邏輯（例如 ATR 抓取判斷）跟著用新狀態
        await notifyFilled(userId, row, snapshot.markPrice);
      }

      // 自我修復：entry_qty 是 tradeBridge.ts 判斷「TP1 是否已發生」的基準
      // 值（部位比這個值小才算數），null 代表還沒記過——涵蓋兩種情況：這筆
      // 剛確認成交（上面那段自我修復第一次跑），或者是這次改動上線前就已經
      // active 的舊資料（永遠不會再進 status==='waiting' 那個分支）。
      //
      // 舊資料裡如果止損已經不是原始值（trailingStop !== stop_loss），代表
      // 舊邏輯下 TP1 早就發生過、部位已經打折——這種情況直接用目前部位反推
      // 回「打折前」的量（÷(1-50%)），讓 tp1Happened 立刻判定為 true，避免
      // 誤判成「還沒發生」而重新掛一次 TP1 條件單：如果之後價格真的又碰到
      // tp1，用打折後的部位再算一次 50% 會變成部位只剩 25%，跟移動止損棘輪
      // 的語意（TP1 後只剩「棘輪保護」不再減倉）互相打架。
      if (snapshot.positionQty > 0 && row.entry_qty === null) {
        const stopAlreadyMoved = snapshot.currentStop !== null
          && Math.abs(snapshot.currentStop.triggerPrice - row.stop_loss) > 1e-8;
        const entryQty = stopAlreadyMoved
          ? snapshot.positionQty / (1 - TP1_PARTIAL_FRACTION)
          : snapshot.positionQty;
        await persist.setEntryQty(row.id, entryQty);
        row.entry_qty = entryQty;
      }

      // 自我修復：部位比 entry_qty 小（TP1 真的發生了）但 DB 還沒標記——
      // 跟上面 waiting→active 同一種模式，不依賴「我們自己主動下單」這個
      // 時機點，只要事實跟記錄不一致就修正。
      if (
        row.entry_qty !== null && snapshot.positionQty > 0
        && snapshot.positionQty < row.entry_qty * 0.99 && row.status !== 'tp1_hit'
      ) {
        await persist.markTp1Hit(row.id);
        row.status = 'tp1_hit';
        await notifyTp1Hit(userId, row);
      }

      // MFE/MAE（2026-08-12）：真倉監控從來沒記過——DB 模擬版（route.ts）
      // 早就在記，理由同一個：只看出場價分不出「衝到 +1.8R 才拉回 +0.2R
      // 出場」跟「從沒衝過 +0.3R」，這兩種是完全不同的問題（TP1 太遠 vs.
      // 進場當下的判斷本身就不成立），CSV 診斷 8/11 三筆止損時發現這個
      // 缺口——沒有 MFE 就看不出這幾筆是曾經浮盈又跌回去，還是直接反向。
      // 用 updateMfeMae 同一個純函數（src/lib/monitorMath.ts），只是這裡
      // 沒有 K 線陣列，只有輪詢到的單一 markPrice——包成 high=low=markPrice
      // 的單根「K線」餵進去，跟 route.ts 用真實高低價比起來會略低估振幅，
      // 但這支輪詢頻率（15秒）比 route.ts 的 5 分鐘 cron 密集得多，足夠打平。
      // 純被動量測，不是交易決策，跟下面 decideTradeAction 的判斷完全獨立，
      // 失敗也不能擋到正常監控——同 route.ts 的 try/catch 防護。
      if (snapshot.positionQty > 0) {
        try {
          const mm = updateMfeMae(
            [{ high: snapshot.markPrice, low: snapshot.markPrice }],
            row.direction === 'LONG',
            row.mfe_price,
            row.mae_price,
          );
          if (mm.changed) {
            const { error } = await supabase.from('trades')
              .update({ mfe_price: mm.mfePrice, mae_price: mm.maePrice })
              .eq('id', row.id);
            if (error) console.error(`[mfe/mae] ${row.symbol} 更新失敗: [${error.code}] ${error.message}`);
            else { row.mfe_price = mm.mfePrice; row.mae_price = mm.maePrice; }
          }
        } catch (e) {
          console.error(`[mfe/mae] ${row.symbol} 計算失敗: ${String(e).slice(0, 150)}`);
        }
      }

      // 風險輸入只有「還沒下過進場單」才需要（余額/槓桿分級都是額外的 API
      // 呼叫，其他狀態下這筆單不會走到 decideTradeAction 的風險檢查分支）。
      let risk: RiskCheckInput & { leverage: number };
      if (row.exchange_entry_order_id === null) {
        const built = await buildRiskInput(binance, row, totalOpenRiskPct - (row.suggested_risk_pct ?? 1));
        if (!built) continue; // 抓不到分級資料，這輪跳過，見 buildRiskInput 說明
        risk = built;
      } else {
        // leverage 只有 place_entry 分支會用到（見下方），這裡永遠不會走到
        // 那個分支（exchangeEntryOrderId !== null 代表已經下過進場單），
        // 1 只是型別要求的佔位值。
        risk = { positionUSDT: 0, totalOpenRiskPct: 0, thisTradeRiskPct: 0, liquidation: { isolatedMarginUSDT: 0, maintMarginRatio: 0, maintAmount: 0 }, leverage: 1 };
      }

      const action = decideTradeAction(trade, snapshot, risk);

      // 2026-08-11：資金安全缺口——checkLiquidationSafety（tradeBridge.ts
      // 第1步風控閘門）整套強平價公式是為 isolated margin + 這裡算好的
      // leverage 設計的（見 src/engine/liquidation.ts 頂部說明，含
      // TMM=0/UPNL=0 化簡），但這支從沒真的呼叫過 setMarginType/setLeverage
      // 讓幣安帳戶端符合這個假設——如果帳戶這個 symbol 預設是 cross margin
      // 或槓桿倍數對不上，強平價算出來的數字跟真實情況會有落差，實測撞到：
      // 使用者 ACEUSDT 那筆倉位幣安介面顯示「保證金 11.40 USDT（全倉）」。
      //
      // 只在真的要送出第一張進場單那一刻呼叫——setMarginType 有部位/掛單
      // 時會被幣安拒絕（-4046），這個時間點（action.kind==='place_entry'）
      // 保證 symbol 還是空手，是唯一安全的呼叫窗口。已經開著的舊倉位（下單
      // 當時是 cross margin）不會被這裡追溯修正，checkLiquidationSafety
      // 只在進場前的一次性風控閘門用到，不會對已開部位持續套用，所以舊倉位
      // 不會被這個公式誤判——只是它們的強平風險本來就沒有被這套系統持續
      // 追蹤（另一個可以做的加強，這次先只處理「新倉位開始前先鎖定假設
      // 成立」這一步）。
      if (action.kind === 'place_entry') {
        try {
          await binance.setMarginType(row.symbol, 'ISOLATED');
        } catch (e) {
          const code = extractBinanceErrorCode(e);
          if (code !== -4046) { // -4046 = 已經是 ISOLATED，不算錯誤
            console.error(`[${nowStr()}] ${row.symbol} setMarginType 失敗，這輪跳過進場（強平價假設不成立前不安全下單）: ${describeError(e)}`);
            continue;
          }
        }
        try {
          // 2026-08-12 實測撞到：risk.leverage 是 calcPositionPlan 算出來的
          // 倉位試算值，刻意留 1 位小數給使用者看（position.ts:31「槓桿, 1
          // decimal」），從來不是給交易所下單用的整數——幣安 /fapi/v1/leverage
          // 要求整數，送 7.6 這種小數會被拒絕（-1102 "was not sent, was
          // empty/null, or malformed"，這個錯誤訊息容易誤導成「沒送出去」，
          // 其實是型別不符）。無條件進位（不是四捨五入）：幣安這個設定是
          // 「上限」不是「強制值」，實際使用的槓桿由下單時的保證金/數量決定
          // 可以 ≤ 這個上限，進位到比試算值大的整數安全，捨去反而可能讓上限
          // 卡在試算值以下。maxLev 在 calcPositionPlan 裡已經是整數上限，
          // ceil 後不會超過它。
          const leverageInt = Math.ceil(risk.leverage);
          await binance.setLeverage(row.symbol, leverageInt);
        } catch (e) {
          console.error(`[${nowStr()}] ${row.symbol} setLeverage(${risk.leverage}) 失敗，這輪跳過進場: ${describeError(e)}`);
          continue;
        }
      }

      const result = await executeTradeAction(client, persist, row.id, action);

      if (result.executed) {
        console.log(`[${nowStr()}] ${row.symbol} [${action.kind}] ${result.note}`);
        await notifyIfNeeded(userId, row, action, snapshot.currentStop?.triggerPrice ?? null);
        // 這筆 trade 生命週期正式結束——見 cleanupAfterTradeClosed 頂部
        // 說明：撤殘留條件單 + 解 Redis symbol 鎖，避免使用者實測撞到的
        // 「幣安端還掛著止盈單」「App 誤判持倉中」這兩個善後缺口重演。
        // cancel_stale_entry（掛單過期主動撤單）跟 entry_never_filled
        // 同一個語意——從未真的開過倉，一併觸發清理。
        if (
          action.kind === 'sync_closed_position' || action.kind === 'entry_never_filled'
          || action.kind === 'cancel_stale_entry'
        ) {
          await cleanupAfterTradeClosed(
            binance, redis, row,
            action.kind === 'sync_closed_position',
            action.kind === 'sync_closed_position' && action.result === 'LOSS',
          );
        }
      }
      // hold/wait_for_fill 這類 no-op 不印，避免每輪洗版；needs_reconcile 值得看見。
      else if (action.kind === 'needs_reconcile' || action.kind === 'skip_entry') {
        console.log(`[${nowStr()}] ${row.symbol} [${action.kind}] ${result.note}`);
      }
    } catch (e) {
      const code = extractBinanceErrorCode(e);
      // 只有「還沒真的開倉」的推薦單才適合直接標記取消——已經有真實部位的
      // 話，錯誤原因可能是別的操作（補止損/移動止損）失敗，部位還在，
      // 亂標成 CANCELLED 會讓帳目跟交易所實際狀態脫鉤，比放著重試更危險。
      if (code !== undefined && NON_RETRYABLE_BINANCE_CODES.has(code) && row.exchange_entry_order_id === null) {
        const { error } = await supabase.from('trades').update({
          status: 'cancelled', result: 'CANCELLED', closed_at: Date.now(), close_reason: 'symbol_unavailable',
        }).eq('id', row.id);
        if (error) {
          console.error(`[${nowStr()}] ${row.symbol}（${row.id}）標記取消失敗: [${error.code}] ${error.message}`);
        } else {
          console.log(`[${nowStr()}] ${row.symbol}（${row.id}）幣安回應 [${code}]，這個 symbol 目前不可交易，標記取消不再重試`);
          // 2026-08-11：實測撞到——這條路徑是獨立在 executeTradeAction 之外
          // 的 catch 分支（下單前就撞到 symbol 不可用），不會經過主迴圈那段
          // 「action.kind 是這三種才清理」的判斷，之前完全沒解鎖，導致這個
          // symbol 卡在「持倉中」（使用者截圖：PUMP 卡片本身已經顯示「交易
          // 對目前無法下單」，但幣種監控清單還是跳過持倉中）。
          // exchange_entry_order_id === null 保證沒下過任何單，不用撤條件單
          // （跟 entry_never_filled 同一個理由），也不是 LOSS，不用設冷卻。
          await cleanupAfterTradeClosed(binance, redis, row, false, false);
          // 2026-08-13：這條路徑同樣沒有推播——推薦單就這樣無聲消失，使用者
          // 只會在 App 裡看到卡片變成「交易對目前無法下單」。跟其他「推薦單
          // 沒進場就結束」的時機（entry_never_filled / cancel_stale_entry）
          // 一致補上，讓「這張單為什麼不見了」在手機上就答得出來。
          await sendWebPushToUser(userId, {
            title: `⚠️ 交易對無法下單 ${row.symbol.replace('USDT', '/USDT')}`,
            body: `幣安回應 [${code}]，這個交易對目前不可交易，推薦單已取消（未進場）`,
            tag: `unavailable-${row.id}`,
          });
        }
      } else {
        console.error(`[${nowStr()}] ${row.symbol}（${row.id}）這筆處理失敗，不影響其他筆: ${describeError(e)}`);
      }
    }
  }
}

// axios 錯誤的 String(e) 只會印出 "AxiosError: Request failed with status
// code 400" 這種泛用訊息——幣安真正的錯誤代碼/訊息在 err.response.data
// 裡（比如 -1013 精度錯誤、-4164 低於最小名目值、-1121 symbol 不存在），
// 不解開來看永遠不知道是哪一種。
function describeError(e: unknown): string {
  const resp = (e as { response?: { data?: { code?: number; msg?: string } } })?.response;
  if (resp?.data) {
    return `幣安回應 [${resp.data.code}] ${resp.data.msg}`;
  }
  return String(e).slice(0, 200);
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
  // 2026-08-12：實測撞到（使用者第二次回報「只收得到推薦單通知」）——
  // 2026-08-10 幫這支補上 Web Push（notifyFilled/notifyTp1Hit/notifyIfNeeded）
  // 時，只加了呼叫端程式碼，**沒有把 VAPID 金鑰列進上面的必要環境變數，也
  // 沒有做任何啟動檢查**。結果：使用者照著檔頭文件設好那 5 組變數，這支跑
  // 起來一切正常（下單、監控、關單都對），但 sendWebPushToUser 一進去就撞到
  // 「VAPID keys not configured」直接 return []，每一則進場/出場/TP1 通知
  // 全部靜默失敗。而「推薦單」通知是 Vercel 的 route.ts 發的（那邊 VAPID 設
  // 在 Vercel 環境變數裡），所以照樣會到——這就是「只收得到推薦單」的成因，
  // 不是推播機制壞掉，是這支的環境變數缺一半。
  //
  // 刻意**不** process.exit(1)：推播是輔助功能，不該讓它擋掉真倉監控（那會
  // 讓已開的倉位失去管理，比收不到通知嚴重得多）。改成啟動時大聲印出狀態，
  // 有設就明確說「已啟用」，沒設就印出完整補救指令——讓這件事不可能再被
  // 默默忽略一次。
  if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    console.error('');
    console.error('⚠️  ════════════════════════════════════════════════════════');
    console.error('⚠️   VAPID 金鑰未設定 —— 這支不會發出任何推播通知');
    console.error('⚠️   （進場成交／TP1達標／移動止損／出場／推薦單失效 全部收不到）');
    console.error('⚠️   注意：「新推薦單」通知由 Vercel 發送，不受影響——所以');
    console.error('⚠️   「只收得到推薦單」正是這個狀況，不是推播壞了。');
    console.error('⚠️');
    console.error('⚠️   補救：把 Vercel 專案裡這兩個環境變數設到本機再重啟這支');
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
  const config = loadBinanceConfigFromEnv(true); // testnet 固定 true，直到 --live 開放
  const binance = new BinanceFuturesClient(config);
  const userId = process.env.TRADING_USER_ID;

  console.log(`[${nowStr()}] live-runner 啟動（testnet，${CYCLE_MS / 1000}秒/輪，會真的下單）`);

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
      await runCycle(supabase, binance, redis, userId);
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
