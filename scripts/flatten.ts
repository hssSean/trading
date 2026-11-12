#!/usr/bin/env npx tsx
/**
 * 緊急全平：啟動 kill switch → 市價平掉帳戶上所有部位 → 撤掉所有掛單與條件單。
 *
 *   ENV_FILE=env.txt npm run flatten              # 只列出會做什麼，不動任何東西
 *   ENV_FILE=env.txt npm run flatten -- --yes     # 真的執行
 *   ENV_FILE=env.txt npm run flatten -- --resume  # 解除 kill switch（確認沒事後才恢復交易）
 *
 * 範圍是**整個帳戶**（含手機 App 手動下的單），不是只有 S3 的部位。
 * 執行後 kill switch 保持啟動：live-runner 整輪跳過，不會再開新倉。解除後 live-runner 看到部位歸零，
 * 會照平常的流程從成交紀錄結算 S3 的帳（s3a-live:done、A／B 分帳）。
 * 目前只接 testnet（跟 live-runner 一樣）；主網開放時兩邊一起改。
 */
import { Redis } from '@upstash/redis';
import { loadEnvFile, reportEnvLoad } from './loadEnvFile';
import { BinanceFuturesClient, loadBinanceConfigFromEnv } from '../src/engine/binanceClient';
import { activateKillSwitch, deactivateKillSwitch, getKillSwitchState } from '../src/engine/killSwitch';
import { planFlatten } from '../src/engine/flatten';

const errMsg = (e: unknown) => {
  const d = (e as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
  return d ? `[${d.code}] ${d.msg}` : String(e).slice(0, 160);
};

async function snapshot(b: BinanceFuturesClient) {
  const [pos, orders, algos] = await Promise.all([b.getPositionRisk(), b.getOpenOrders(), b.getOpenAlgoOrders()]);
  return planFlatten(pos, orders, algos);
}

async function main(): Promise<void> {
  reportEnvLoad(loadEnvFile());
  const yes = process.argv.includes('--yes'), resume = process.argv.includes('--resume');
  const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN ? Redis.fromEnv() : null;

  if (resume) {
    if (!redis) throw new Error('Redis 未設定，無法解除 kill switch');
    await deactivateKillSwitch(redis);
    console.log('✅ kill switch 已解除。live-runner 最多 60 秒後恢復（它有 60 秒快取）。');
    return;
  }

  const binance = new BinanceFuturesClient(loadBinanceConfigFromEnv(true));
  const plan = await snapshot(binance);
  console.log(`\n帳戶現況（testnet）：${plan.closes.length} 個部位、${plan.cancelOrders.length} 張掛單、${plan.cancelAlgos.length} 張條件單`);
  for (const c of plan.closes) console.log(`  平倉 ${c.symbol} ${c.side} ${c.quantity}（市價、reduceOnly）`);
  for (const o of plan.cancelOrders) console.log(`  撤掛單 ${o.symbol} ${o.orderId}`);
  for (const a of plan.cancelAlgos) console.log(`  撤條件單 ${a.symbol} ${a.algoId}`);
  if (redis) { const ks = await getKillSwitchState(redis); console.log(`kill switch：${ks.active ? `已啟動（${ks.reason ?? ''}）` : '未啟動'}`); }
  if (!yes) { console.log('\n這是預覽，沒有動任何東西。要執行請加 -- --yes'); return; }

  // 1. kill switch（Redis 掛了也繼續平倉——平倉比開關重要）
  if (redis) {
    try { await activateKillSwitch(redis, `手動全平 ${new Date().toISOString()}`); console.log('\n⛔ kill switch 已啟動'); }
    catch (e) { console.error(`⚠ kill switch 啟動失敗（繼續平倉）：${errMsg(e)}`); }
  } else console.error('⚠ Redis 未設定：kill switch 沒有啟動，live-runner 可能再開新倉——請手動停掉 live-runner');

  // 2. 先平倉
  let failed = 0;
  for (const c of plan.closes) {
    try {
      await binance.placeOrder({ symbol: c.symbol, side: c.side, type: 'MARKET', quantity: c.quantity, reduceOnly: true,
        newClientOrderId: `flat-${c.symbol}-${Math.floor(Date.now() / 1000)}`.slice(0, 36) });
      console.log(`✅ 已送出平倉 ${c.symbol} ${c.side} ${c.quantity}`);
    } catch (e) { failed++; console.error(`❌ 平倉 ${c.symbol} 失敗：${errMsg(e)}`); }
  }
  // 3. 再撤單；等幾秒再掃一次（live-runner 在 kill switch 快取期間可能補掛）
  const cancelAll = async (p: Awaited<ReturnType<typeof snapshot>>) => {
    for (const o of p.cancelOrders) { try { await binance.cancelOrder(o.symbol, o.orderId, false); } catch (e) { console.error(`  撤掛單 ${o.symbol} ${o.orderId}：${errMsg(e)}`); } }
    for (const a of p.cancelAlgos) { try { await binance.cancelOrder(a.symbol, a.algoId, true); } catch (e) { console.error(`  撤條件單 ${a.symbol} ${a.algoId}：${errMsg(e)}`); } }
  };
  await cancelAll(plan);
  let left = plan;
  for (let i = 0; i < 3; i++) {
    await new Promise(r => setTimeout(r, 4000));
    left = await snapshot(binance);
    if (!left.closes.length && !left.cancelOrders.length && !left.cancelAlgos.length) break;
    await cancelAll(left);
  }
  left = await snapshot(binance);
  const clean = !left.closes.length && !left.cancelOrders.length && !left.cancelAlgos.length;
  console.log(clean
    ? '\n✅ 帳戶已清空：沒有部位、沒有掛單。kill switch 保持啟動，確認後用 -- --resume 解除。'
    : `\n🔴 還有殘留：${left.closes.length} 個部位、${left.cancelOrders.length} 張掛單、${left.cancelAlgos.length} 張條件單——請到交易所確認，或再跑一次。`);
  if (!clean || failed) process.exitCode = 1;
}

main().catch(e => { console.error(`致命錯誤：${errMsg(e)}`); process.exit(1); });
