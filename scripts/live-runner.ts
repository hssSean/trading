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
  decideTradeAction, BridgeTradeRow, BridgeExchangeSnapshot, RiskCheckInput, TradeAction,
} from '../src/engine/tradeBridge';
import { extractBinanceErrorCode } from '../src/engine/pendingOrderLifecycle';
import { executeTradeAction, TradeExecutorClient, TradePersistence } from '../src/engine/tradeExecutor';
import { calcSimpleAtr } from '../src/lib/monitorMath';
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

// 這些幣安錯誤代碼代表「這筆單本質上就不可能成功」——不是網路抖動、不是
// 暫時性 rate limit，重試沒有意義，只會每輪浪費一次 API 呼叫、洗版 log。
// 見到就把這筆推薦單標記取消，不要無限重試。
//   -4141 Symbol is closed（這個交易對目前不接受新單，2026-08-09 實測
//         MMTUSDT 在 demo trading 撞到）
//   -1121 Invalid symbol（symbol 打錯或這個交易對根本不存在）
const NON_RETRYABLE_BINANCE_CODES = new Set([-4141, -1121]);

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
  exchange_entry_order_id: number | null;
  exchange_stop_algo_id: number | null;
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
    exchangeEntryOrderId: row.exchange_entry_order_id,
    exchangeStopAlgoId: row.exchange_stop_algo_id,
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
      const { error } = await supabase.from('trades').update({
        result: result.result,
        exit_price: result.exitPrice,
        pnl_percent: parseFloat(pnlPercent.toFixed(2)),
        closed_at: Date.now(),
        close_reason: 'live_auto_sync',
      }).eq('id', tradeId);
      logErr('finalizeClosed', error);
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
): Promise<RiskCheckInput | null> {
  const balances = await binance.getBalance();
  const usdt = balances.find(b => b.asset === 'USDT');
  const accountEquity = usdt ? parseFloat(usdt.availableBalance) : 0;
  const riskPct = row.suggested_risk_pct ?? 1;

  const plan = calcPositionPlan(accountEquity, riskPct, row.entry, row.stop_loss, DEFAULT_MAX_LEVERAGE);
  const positionUSDT = plan?.positionUSDT ?? 0;
  const marginUSDT = plan?.marginUSDT ?? 0;

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
  };
}

// route.ts 沒了這個使用者之後不會再推播——見檔案頂部說明。只有兩個時刻值得
// 通知：TP1 部分平倉（第一次獲利了結）、最終出場（sync_closed_position，
// 這時候才有真實成交價/損益可以講，close_full_position 本身只是送出關單，
// 還不知道最終結果，不在那個分支推播）。
async function notifyIfNeeded(userId: string, row: DbTradeRow, action: TradeAction): Promise<void> {
  const sym = row.symbol.replace('USDT', '/USDT');
  const dir = row.direction === 'LONG' ? '▲ 做多' : '▼ 做空';

  if (action.kind === 'tp1_partial_close') {
    await sendWebPushToUser(userId, {
      title: `🎯 TP1 達標 ${sym}`,
      body: `${dir} 部分平倉已送出，剩餘倉位交給 live-runner 自動管理移動止損`,
      tag: `tp1-${row.id}`,
    });
  } else if (action.kind === 'sync_closed_position') {
    const label = action.result === 'WIN_TP1' ? '✅ 出場獲利' : '❌ 止損出場';
    const pnlStr = `${action.realizedPnl >= 0 ? '+' : ''}${action.realizedPnl.toFixed(2)} USDT`;
    await sendWebPushToUser(userId, {
      title: `${label} ${sym}`,
      body: `${dir} 出場 $${action.avgExitPrice.toFixed(4)} ｜ 實現損益 ${pnlStr}`,
      tag: `close-${row.id}`,
    });
  }
}

async function runCycle(
  supabase: SupabaseClient,
  binance: BinanceFuturesClient,
  redis: Redis,
  userId: string,
): Promise<void> {
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
    .select('id,symbol,direction,entry,stop_loss,tp1,tp2,strategy,timeframe,status,suggested_risk_pct,filled_at,opened_at,exchange_entry_order_id,exchange_stop_algo_id')
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

      // 風險輸入只有「還沒下過進場單」才需要（余額/槓桿分級都是額外的 API
      // 呼叫，其他狀態下這筆單不會走到 decideTradeAction 的風險檢查分支）。
      let risk: RiskCheckInput;
      if (row.exchange_entry_order_id === null) {
        const built = await buildRiskInput(binance, row, totalOpenRiskPct - (row.suggested_risk_pct ?? 1));
        if (!built) continue; // 抓不到分級資料，這輪跳過，見 buildRiskInput 說明
        risk = built;
      } else {
        risk = { positionUSDT: 0, totalOpenRiskPct: 0, thisTradeRiskPct: 0, liquidation: { isolatedMarginUSDT: 0, maintMarginRatio: 0, maintAmount: 0 } };
      }

      const action = decideTradeAction(trade, snapshot, risk);
      const result = await executeTradeAction(client, makePersistence(supabase, row), row.id, action);

      if (result.executed) {
        console.log(`[${nowStr()}] ${row.symbol} [${action.kind}] ${result.note}`);
        await notifyIfNeeded(userId, row, action);
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
