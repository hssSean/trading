#!/usr/bin/env npx tsx
/**
 * Testnet reconciliation smoke test — validates src/engine/ against REAL
 * Binance Futures testnet responses before anything touches real money.
 *
 * Usage:
 *   1. 登入 https://demo.binance.com（你的一般幣安帳號，這是官方整合式
 *      Demo Trading，不是舊版獨立的 testnet.binancefuture.com/GitHub 登入）→
 *      API 管理頁面 → 建立新 API（合約權限）。secret 只顯示一次，自己複製，
 *      不要貼給任何人（含這個對話）。這組 key 對接的是 demo-fapi.binance.com，
 *      跟你正式帳戶的資產/API key 完全無關
 *   2. 設定環境變數（不要貼在 chat 裡，只在自己的終端機/檔案設定）：
 *        export BINANCE_TESTNET_API_KEY=你的key
 *        export BINANCE_TESTNET_API_SECRET=你的secret
 *   3. npx tsx scripts/testnet-reconcile.ts [SYMBOL]
 *      預設 SYMBOL=BTCUSDT，也可以指定別的（例如流動性較低的幣種更貼近實際單）
 *
 * 這支腳本會在 testnet 上真的下單（全部是假錢，零真實財務風險），走一輪完整的
 * 開倉→補止損→平倉流程，用來驗證三件單元測試測不到的事：
 *   - precision.ts 的 stepSize/tickSize 捨去邏輯，對上真實 exchangeInfo 回應
 *   - pendingOrderLifecycle.ts 的 extractBinanceErrorCode，對上真實 -2011
 *     錯誤格式（目前完全沒驗證過，是照 Binance 文件猜的）
 *   - watchdog.ts 的 reconcilePositionsAndOrders，對上真實持倉/掛單快照，
 *     走過「無止損」→「補止損後零異常」兩個狀態
 *
 * 不會碰 runner.ts 或任何 DB——這是交易所介面本身的獨立驗證，不是完整流程。
 * 每一步輸出 ✅/❌，全部 ✅ 才代表可以進到下一步（真帳戶 dry-run）。
 * 有任何 ❌，把完整輸出貼回來，不要自己猜是不是「應該沒差」。
 */

import { BinanceFuturesClient, loadBinanceConfigFromEnv } from '../src/engine/binanceClient';
import { parseSymbolFilters, roundToStepSize, roundToTickSize } from '../src/engine/precision';
import { reconcilePositionsAndOrders } from '../src/engine/watchdog';
import { extractBinanceErrorCode, BINANCE_ERR_UNKNOWN_ORDER } from '../src/engine/pendingOrderLifecycle';
import axios from 'axios';

const SYMBOL = process.argv[2] ?? 'BTCUSDT';

let passed = 0;
let failed = 0;

function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`✅ ${label}`);
    passed++;
  } else {
    console.log(`❌ ${label}`);
    if (detail !== undefined) console.log(`   詳情: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    failed++;
  }
}

function step(label: string): void {
  console.log(`\n── ${label} ──`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// Binance rejects newClientOrderId over 36 chars (-4015) — the original
// "testnet-reconcile-<tag>-<ms timestamp>" prefix was 38+ chars for several
// tags and only surfaced when actually run against demo-fapi (tsc/unit tests
// can't catch a string-length limit enforced server-side). Kept short with
// margin rather than truncating, since truncation risks silent collisions.
function mkId(tag: string): string {
  return `tnr-${tag}-${Date.now()}`;
}

async function fetchMarkPrice(symbol: string): Promise<number> {
  // Public endpoint — demo-fapi has its own price feed, separate from mainnet.
  const res = await axios.get('https://demo-fapi.binance.com/fapi/v1/ticker/price', { params: { symbol } });
  return parseFloat(res.data.price);
}

function errCode(e: unknown): number | undefined {
  return extractBinanceErrorCode(e);
}
function errDetail(e: unknown): unknown {
  if (e && typeof e === 'object' && 'response' in e) {
    return (e as { response?: { data?: unknown } }).response?.data;
  }
  return e instanceof Error ? e.message : e;
}

async function main() {
  const config = loadBinanceConfigFromEnv(true); // throws a clear error if env vars aren't set
  const client = new BinanceFuturesClient(config);

  step('1. exchangeInfo + precision filters');
  const info = await client.getExchangeInfo();
  const filters = parseSymbolFilters(info as Parameters<typeof parseSymbolFilters>[0]);
  const f = filters.get(SYMBOL);
  check(`${SYMBOL} 解析出 stepSize/tickSize/minNotional`, !!f, f);
  if (!f) {
    console.log('無法繼續 — 精度資料缺失，可能是幣種代碼打錯或這個幣種在 testnet 不存在');
    process.exitCode = 1;
    return;
  }

  step('2. 帳戶餘額 + 起始狀態');
  const balances = await client.getBalance();
  const usdt = balances.find(b => b.asset === 'USDT');
  check('有可用 USDT 餘額', !!usdt && parseFloat(usdt.availableBalance) > 0, usdt);

  const startPositions = await client.getPositionRisk(SYMBOL);
  const startOpenOrders = await client.getOpenOrders(SYMBOL);
  const startAnomalies = reconcilePositionsAndOrders(startPositions, startOpenOrders);
  check(
    '起始狀態沒有殘留持倉/掛單（若失敗，先手動去 testnet 網頁把這個幣種清空再重跑）',
    startAnomalies.length === 0 && startPositions.every(p => parseFloat(p.positionAmt) === 0) && startOpenOrders.length === 0,
    { startPositions, startOpenOrders },
  );

  step('3. 設定逐倉（ISOLATED）');
  try {
    const r = await client.setMarginType(SYMBOL, 'ISOLATED');
    check('逐倉設定成功', true, r);
  } catch (e) {
    const code = errCode(e);
    // -4046 = 已經是逐倉（重跑這支腳本時很正常，不是失敗）
    check('逐倉設定成功，或本來就已經是逐倉', code === -4046, errDetail(e));
  }

  step('4. 設定槓桿 5x');
  const lev = await client.setLeverage(SYMBOL, 5);
  check('槓桿設定為 5x', lev.leverage === 5, lev);

  step('5. 掛限價單（遠離市價 20%，確保不會成交，純測撤單流程）');
  const markPrice = await fetchMarkPrice(SYMBOL);
  const limitPrice = roundToTickSize(markPrice * 0.8, f.tickSize);
  const testQty = roundToStepSize(Math.max((f.minNotional * 1.5) / limitPrice, f.stepSize), f.stepSize);
  const placed = await client.placeOrder({
    symbol: SYMBOL, side: 'BUY', type: 'LIMIT', quantity: testQty, price: limitPrice,
    timeInForce: 'GTC', newClientOrderId: mkId('limit'),
  });
  check('限價單掛單成功', placed.status === 'NEW', placed);

  step('6. 查掛單，比對數量精度是否跟送出時一致');
  const openOrdersAfterPlace = await client.getOpenOrders(SYMBOL);
  const found = openOrdersAfterPlace.find(o => o.orderId === placed.orderId);
  check('掛單出現在 openOrders', !!found, found);
  check('origQty 跟送出的 stepSize 捨去結果一致', found?.origQty === String(testQty), { sent: testQty, got: found?.origQty });

  step('7. 撤單（正常流程，應該成功）');
  const cancelRes = await client.cancelOrder(SYMBOL, placed.orderId);
  check('撤單成功', cancelRes.status === 'CANCELED', cancelRes);

  step('8. 重複撤單同一張已撤銷的單 — 驗證 -2011 的真實格式（目前唯一沒驗證過的假設）');
  try {
    await client.cancelOrder(SYMBOL, placed.orderId);
    check('預期應該拋出錯誤，但沒有拋出', false);
  } catch (e) {
    console.log('   原始錯誤內容:', JSON.stringify(errDetail(e)));
    check('extractBinanceErrorCode 正確解析出 -2011', errCode(e) === BINANCE_ERR_UNKNOWN_ORDER, { code: errCode(e) });
  }

  step('9. 市價開最小倉位（測開倉/止損/watchdog 全流程）');
  const openQty = roundToStepSize(Math.max((f.minNotional * 1.2) / markPrice, f.stepSize), f.stepSize);
  const openOrderRes = await client.placeOrder({
    symbol: SYMBOL, side: 'BUY', type: 'MARKET', quantity: openQty,
    newClientOrderId: mkId('open'),
  });
  check('市價單送出成功', !!openOrderRes.orderId, openOrderRes);

  await sleep(1500); // 給交易所結算部位一點時間

  step('10. 確認部位出現，數量符合下單量');
  const posAfterOpen = await client.getPositionRisk(SYMBOL);
  const pos = posAfterOpen.find(p => p.symbol === SYMBOL);
  check('部位數量符合下單量', !!pos && Math.abs(parseFloat(pos.positionAmt) - openQty) < f.stepSize, pos);

  step('11. 對帳：此刻應該偵測到「有持倉沒止損」');
  const openOrdersNoStop = await client.getOpenOrders(SYMBOL);
  const anomaliesNoStop = reconcilePositionsAndOrders(posAfterOpen, openOrdersNoStop);
  check(
    'watchdog 正確偵測到 position_without_stop',
    anomaliesNoStop.some(a => a.kind === 'position_without_stop'),
    anomaliesNoStop,
  );

  step('12. 補上止損單（STOP_MARKET, closePosition=true）');
  const entryPrice = parseFloat(pos?.entryPrice ?? '0');
  const stopPrice = roundToTickSize(entryPrice * 0.97, f.tickSize); // 3% 止損，僅供驗證流程用
  const stopOrder = await client.placeOrder({
    symbol: SYMBOL, side: 'SELL', type: 'STOP_MARKET', stopPrice, closePosition: true,
    newClientOrderId: mkId('sl'),
  });
  check('止損單掛單成功', !!stopOrder.orderId, stopOrder);

  step('13. 對帳：補上止損後應該零異常');
  const openOrdersWithStop = await client.getOpenOrders(SYMBOL);
  const anomaliesWithStop = reconcilePositionsAndOrders(posAfterOpen, openOrdersWithStop);
  check('watchdog 對帳零異常', anomaliesWithStop.length === 0, anomaliesWithStop);

  step('14. 平倉（reduceOnly 市價全平）');
  const closeRes = await client.placeOrder({
    symbol: SYMBOL, side: 'SELL', type: 'MARKET', quantity: openQty, reduceOnly: true,
    newClientOrderId: mkId('close'),
  });
  check('平倉單送出成功', !!closeRes.orderId, closeRes);

  await sleep(1500);

  step('15. 清理殘留止損單 + 最終歸零確認');
  await client.cancelAllOpenOrders(SYMBOL);
  const finalPositions = await client.getPositionRisk(SYMBOL);
  const finalOrders = await client.getOpenOrders(SYMBOL);
  const finalAnomalies = reconcilePositionsAndOrders(finalPositions, finalOrders);
  check('最終部位歸零', finalPositions.every(p => parseFloat(p.positionAmt) === 0), finalPositions);
  check('最終掛單清空', finalOrders.length === 0, finalOrders);
  check('最終對帳零異常', finalAnomalies.length === 0, finalAnomalies);

  console.log(`\n${'='.repeat(48)}`);
  console.log(`結果：${passed} 過，${failed} 失敗`);
  if (failed > 0) {
    console.log('有 ❌ 項目 — 把完整輸出貼回來，不要自己猜是不是沒差。');
    process.exitCode = 1;
  } else {
    console.log('全過。可以進到 docs/TODO.md §上線順序 的下一步：真帳戶 dry-run。');
  }
}

main().catch(e => {
  console.error('腳本中途拋出未預期例外:', errDetail(e) ?? e);
  process.exitCode = 1;
});
