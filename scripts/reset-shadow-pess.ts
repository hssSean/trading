#!/usr/bin/env npx tsx
/**
 * 清掉影子單上**捏造的**悲觀軌跡欄位。
 *
 * ## 為什麼要清
 *
 * `SHADOW_PESSIMISTIC` 自 2026-08-26 起預設關閉，但關閉期間 `simulateShadow`
 * 仍然會寫出 `pessResult`，而那些值不是模擬來的（詳見 src/lib/shadowSim.ts
 * 檔頭）：樂觀軌跡結案時直接複製過去，TIMEOUT 分支則讀一個從沒被更新過的
 * `pessTp1Hit`。結果是 `/api/reject-funnel` 的 `netRPess` 大多恆等於 `netR`，
 * 而 `scripts/funnel-verdict.ts` 的「兩端同號才算數」把關因此永遠成立——
 * 整個調參紀律失去依據。
 *
 * `shadow_trades` 的保留窗口是 14 天，所以 Redis 裡**現存的每一筆**悲觀值
 * 都是旗標關閉之後寫的，也就是全部不可信。清掉之後覆蓋率會誠實掉到 0，
 * funnel-verdict 會直接標「不可用」，接著隨著新資料累積重建。
 *
 * ## 為什麼不重算而是清掉
 *
 * 重算要把每筆影子單從 `filledAt` 到 `closedAt` 的 K 線重新抓回來。那些單
 * 最長可以跨 7 天、涉及數十個 symbol，而重算出來的結果跟「等 14 天自然重建」
 * 沒有差別——後者不需要打幾百次幣安 API，也不會因為某個 symbol 中途下架而
 * 產生一批半殘的資料。清掉是誠實且便宜的選項。
 *
 *   ENV_FILE=env.txt npx tsx scripts/reset-shadow-pess.ts          # 試跑
 *   ENV_FILE=env.txt npx tsx scripts/reset-shadow-pess.ts --apply  # 真的寫
 *
 * 需要 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN。
 */

import { Redis } from '@upstash/redis';
import { loadEnvFile, reportEnvLoad } from './loadEnvFile';

const APPLY = process.argv.includes('--apply');

interface ShadowLike {
  id?: string;
  symbol?: string;
  rejectedAt?: string;
  status?: string;
  result?: string;
  pessDone?: boolean;
  pessResult?: string;
  pessExitPrice?: number;
  pessTp1Hit?: boolean;
  [k: string]: unknown;
}

async function main() {
  reportEnvLoad(loadEnvFile());
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('缺 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN');
  const r = new Redis({ url, token });

  const raw = (await r.hgetall<Record<string, unknown>>('shadow_trades')) ?? {};
  const ids = Object.keys(raw);
  console.log(`\nshadow_trades 共 ${ids.length} 筆`);

  const writes: Record<string, string> = {};
  const byGate = new Map<string, number>();

  for (const [id, v] of Object.entries(raw)) {
    let st: ShadowLike;
    try { st = (typeof v === 'string' ? JSON.parse(v) : v) as ShadowLike; }
    catch { continue; }
    const hadPess = st.pessDone !== undefined || st.pessResult !== undefined
      || st.pessExitPrice !== undefined || st.pessTp1Hit !== undefined;
    if (!hadPess) continue;

    delete st.pessDone;
    delete st.pessResult;
    delete st.pessExitPrice;
    delete st.pessTp1Hit;
    writes[id] = JSON.stringify(st);

    const gate = st.rejectedAt ?? '(未知關卡)';
    byGate.set(gate, (byGate.get(gate) ?? 0) + 1);
  }

  const n = Object.keys(writes).length;
  console.log(`帶有悲觀欄位的：${n} 筆\n`);
  for (const [gate, count] of Array.from(byGate.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${gate.padEnd(22)} ${String(count).padStart(4)} 筆`);
  }

  if (n === 0) {
    console.log('\n沒有要清的。');
    return;
  }

  if (!APPLY) {
    console.log(`\n這是試跑，沒有寫入任何東西。要真的清除請加 --apply。`);
    console.log('清除後 funnel-verdict 的悲觀覆蓋率會掉到 0（誠實反映「沒有資料」），');
    console.log('隨後 14 天內隨著新的影子單累積重建成真值。');
    return;
  }

  await r.hset('shadow_trades', writes);
  console.log(`\n已清除 ${n} 筆的悲觀欄位。只動 pess* 四個欄位，`
    + `status / result / exitPrice / closedAt 完全沒碰。`);
  console.log('下一步：確認 Vercel 沒有把 SHADOW_PESSIMISTIC 設成 0（預設開啟），');
  console.log('然後過幾天再跑 npm run funnel-verdict 看覆蓋率回升。');
}

main().catch(e => { console.error(e); process.exit(1); });
