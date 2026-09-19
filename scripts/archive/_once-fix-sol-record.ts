// 已執行，僅供追溯——不是可重跑的工具。2026-09-19 移入 archive/。
//
// 一次性修正：trade-1788765628400-wb2hq（SOLUSDT）被記成完整 −1R 的假損失。
// 真實成交（幣安 userTrades）：16.23 @104.40 + 0.01 @103.02，加權出場 ≈ 保本。
// 預設試跑，帶 --apply 才寫入。
import { loadEnvFile } from '../loadEnvFile';
loadEnvFile();
import { createClient } from '@supabase/supabase-js';

const TRADE_ID = 'trade-1788765628400-wb2hq';
const FILLS = [
  { qty: 16.23, price: 104.40 },
  { qty: 0.01, price: 103.02 },
];
const APPLY = process.argv.includes('--apply');

async function main() {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
  const { data, error } = await db.from('trades')
    .select('id,symbol,direction,status,result,entry,stop_loss,exit_price,pnl_percent,close_reason,tier')
    .eq('id', TRADE_ID).single();
  if (error) { console.error(error); process.exit(1); }

  const totalQty = FILLS.reduce((s, f) => s + f.qty, 0);
  const avgExit = FILLS.reduce((s, f) => s + f.qty * f.price, 0) / totalQty;
  const entry = data.entry as number;
  const stopPct = Math.abs(entry - (data.stop_loss as number)) / entry * 100;
  const newPnlPct = (avgExit - entry) / entry * 100;
  const weight = data.tier === 'B' ? 0.5 : 1.0;

  const oldR = (data.pnl_percent as number) / stopPct * weight;
  const newR = newPnlPct / stopPct * weight;

  console.log('── 現況 ──');
  console.log(`  status        ${data.status}`);
  console.log(`  result        ${data.result}`);
  console.log(`  exit_price    ${data.exit_price}`);
  console.log(`  pnl_percent   ${data.pnl_percent}`);
  console.log(`  → R           ${oldR.toFixed(4)}`);
  console.log('── 依真實成交修正後 ──');
  console.log(`  status        active（清掉假的 tp1_hit）`);
  console.log(`  result        ${data.result}（維持 LOSS：交易所實現損益 −0.0138 USDT，仍是負的，只是幾乎為 0）`);
  console.log(`  exit_price    ${avgExit.toFixed(6)}（${FILLS.map(f => `${f.qty}@${f.price}`).join(' + ')} 加權）`);
  console.log(`  pnl_percent   ${newPnlPct.toFixed(6)}`);
  console.log(`  → R           ${newR.toFixed(4)}`);
  console.log(`\n回撤曲線少掉 ${(oldR - newR).toFixed(4)}R 的假損失。`);

  if (!APPLY) { console.log('\n（試跑，未寫入。要寫入加 --apply）'); return; }

  const { error: upErr } = await db.from('trades')
    .update({ status: 'active', exit_price: avgExit, pnl_percent: newPnlPct })
    .eq('id', TRADE_ID);
  if (upErr) { console.error(upErr); process.exit(1); }
  console.log('\n✅ 已寫入。');
}
main();
