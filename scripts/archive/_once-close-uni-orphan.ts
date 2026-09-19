// 已執行，僅供追溯——不是可重跑的工具。2026-09-19 移入 archive/。
//
// 一次性修復：UNIUSDT trade-1788833416973-drr88。
//
// 狀態：部位 41 張，標記價已跌破止損價 6.77104，但止損單從 2026-09-08T20:00Z
// 起被幣安連續拒絕（rejectReason: "Reduce only reject"）——部位只有 41，掛著的
// reduceOnly 賣單卻有 TP1 37 + TP2 41 = 78 張，觸發時沒有可減倉的量。
//
// 動作：撤掉 TP1/TP2 兩張殘留條件單 → 市價平掉 41 張 → 依真實成交寫 DB。
// 預設試跑，帶 --apply 才真的送單。
import { loadEnvFile } from '../loadEnvFile';
loadEnvFile();
import { BinanceFuturesClient, loadBinanceConfigFromEnv } from '../../src/engine/binanceClient';
import { createClient } from '@supabase/supabase-js';

const TRADE_ID = 'trade-1788833416973-drr88';
const SYMBOL = 'UNIUSDT';
const APPLY = process.argv.includes('--apply');

async function main() {
  const bn = new BinanceFuturesClient(loadBinanceConfigFromEnv(true));
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const { data: row, error } = await db.from('trades')
    .select('id,symbol,direction,entry,stop_loss,status,result,closed_at,tier,strategy,entry_qty')
    .eq('id', TRADE_ID).single();
  if (error) { console.error(error); process.exit(1); }
  if (row.closed_at) { console.log('這筆已經有 closed_at，不需要處理。'); return; }

  const positions = await bn.getPositionRisk(SYMBOL);
  const qty = Math.abs(parseFloat(positions[0]?.positionAmt ?? '0'));
  const algos = (await bn.getOpenAlgoOrders()).filter((a: any) => a.symbol === SYMBOL);

  console.log('── 現況 ──');
  console.log(`  部位            ${qty} 張（DB entry_qty=${row.entry_qty}）`);
  console.log(`  entry / stop    ${row.entry} / ${row.stop_loss}`);
  console.log(`  DB status       ${row.status}（result=${row.result ?? '-'}）`);
  console.log(`  殘留條件單      ${algos.length} 張`);
  for (const a of algos) console.log(`    ${(a as any).orderType} ${a.side} qty=${a.quantity} trigger=${a.triggerPrice} algoId=${a.algoId}`);

  if (qty <= 0) { console.log('\n交易所上沒有部位，不需要平倉。'); return; }

  if (!APPLY) { console.log('\n（試跑，未送任何單。要執行加 --apply）'); return; }

  // 1+2. 撤條件單，然後立刻送市價平倉單。
  //
  // 這兩步必須連在一起重試：幣安的 reduceOnly 額度是「部位 − 已掛的 reduceOnly
  // 數量」，掛著的止損 41 張就把 41 張的部位佔滿了，市價平倉單會吃 -2022。而
  // live-runner 每 15 秒就會補掛一張新的止損，所以撤完要馬上送單，慢了就又被佔住。
  const closeSide = row.direction === 'LONG' ? 'SELL' : 'BUY';
  let closed = false;
  for (let attempt = 1; attempt <= 5 && !closed; attempt++) {
    const open = (await bn.getOpenAlgoOrders()).filter((a: any) => a.symbol === SYMBOL);
    for (const a of open) {
      await bn.cancelOrder(SYMBOL, a.algoId, true);
      console.log(`  已撤 algoId=${a.algoId}`);
    }
    try {
      // 不帶 newClientOrderId：讓幣安自己給，重試時才不會撞到冪等 ID。
      const res = await bn.placeOrder({
        symbol: SYMBOL, side: closeSide, type: 'MARKET', quantity: qty, reduceOnly: true,
      });
      console.log(`✅ 市價平倉已送出 orderId=${res.orderId} status=${res.status}`);
      closed = true;
    } catch (e) {
      const msg = String((e as any)?.response?.data?.msg ?? e).slice(0, 120);
      console.error(`  第 ${attempt} 次送單失敗：${msg}`);
      if (attempt === 5) throw e;
    }
  }

  // 3. 依真實成交寫 DB
  await new Promise(r => setTimeout(r, 2000));
  const fills = (await bn.getUserTrades(SYMBOL, { startTime: Date.now() - 120_000 }))
    .filter((t: any) => t.side === closeSide);
  const totalQty = fills.reduce((s: number, f: any) => s + parseFloat(f.qty), 0);
  const avgExit = totalQty > 0
    ? fills.reduce((s: number, f: any) => s + parseFloat(f.qty) * parseFloat(f.price), 0) / totalQty
    : 0;
  if (totalQty <= 0) {
    console.error('⚠ 查不到平倉成交，DB 先不寫——下一輪 live-runner 的對帳會處理。');
    return;
  }
  const pnlPercent = row.direction === 'LONG'
    ? (avgExit - row.entry) / row.entry * 100
    : (row.entry - avgExit) / row.entry * 100;
  const stopPct = Math.abs(row.entry - row.stop_loss) / row.entry * 100;

  const { error: upErr } = await db.from('trades').update({
    status: 'active',            // 清掉假的 tp1_hit
    result: 'LOSS',
    exit_price: avgExit,
    pnl_percent: parseFloat(pnlPercent.toFixed(2)),
    closed_at: Date.now(),
    close_reason: 'stop_loss',
  }).eq('id', TRADE_ID);
  if (upErr) { console.error(upErr); process.exit(1); }

  console.log(`✅ DB 已寫入：LOSS / exit ${avgExit.toFixed(4)} / ${pnlPercent.toFixed(2)}%`
    + ` = ${(pnlPercent / stopPct).toFixed(2)}R / close_reason=stop_loss`);
}

main();
