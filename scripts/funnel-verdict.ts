#!/usr/bin/env npx tsx
/**
 * 拒絕漏斗判讀 —— 把「這道濾網到底在保護我還是在害我」變成一句判定。
 *
 * ## 判定規則（來自 ANALYSIS-2026-08-25 §四-②）
 *
 * 影子模擬的淨 R = 「這道關卡擋掉的單，如果放行會賺賠多少」：
 *
 *   netR < 0  關卡擋對了（擋掉的是會虧的單）
 *   netR > 0  關卡擋錯了（擋掉的是會賺的單）
 *
 * 但 `walkTpSl` 對「同根 K 線同時觸及 TP 和 SL」原本一律判 TP 贏，是**單向
 * 樂觀偏誤**，而偏誤的方向剛好偏向「這關擋錯了、應該放寬」——正好是最危險
 * 的方向。2026-08-22（`29b2499`）補了悲觀軌跡，所以要看**區間**：
 *
 *   **兩端同號才算數，跨零就代表這批資料回答不了。**
 *
 * ## pessCovered 是前置條件，不是附註
 *
 * `29b2499` 之前已結案的影子單**永遠不會有悲觀值**——它們的 netRPess 是 0，
 * 而 0 會讓「兩端同號」的判斷失效（樂觀 +24 配悲觀 0 看起來像跨零，實際上
 * 只是沒算）。所以必須先看 `pessCovered / done` 的比例，太低的直接標成
 * 「不可用」而不是給一個看起來很確定的判語。
 *
 * 這支存在的理由就是每次手動判讀都要重複這套規則，而漏掉 pessCovered 那一步
 * 會產生看起來很有說服力的錯誤結論。
 *
 * ## 容量型關卡另外標記
 *
 * `same_dir_cap` / `total_risk_cap` / `locked` 擋的是「組合已經滿了」，不是
 * 「這個訊號不好」。它們的 netR 反映的是同一批 BTC 行情被每個被擋的 symbol
 * 各算一次，不是獨立的邊際。對它們下「擋對/擋錯」的判語會誤導。
 *
 * 用法：
 *   npx tsx scripts/funnel-verdict.ts [天數]
 *
 * 需要 WEBHOOK_SECRET（或 .env.local / ENV_FILE 提供），以及 APP_URL。
 */

import { loadEnvFile, reportEnvLoad } from './loadEnvFile';

const DAYS = Number(process.argv[2] ?? 7);
/** 悲觀覆蓋率低於這個比例就不下判語——數字會騙人。 */
const MIN_COVERAGE = 0.6;

const CAPACITY_GATES = new Set(['same_dir_cap', 'total_risk_cap', 'locked', 'has_open_position']);

interface Shadow {
  win: number; loss: number; other: number; pending: number;
  netR: number; netRPess: number; pessCovered: number;
}
interface Funnel {
  ok: boolean; total: number; sent: number; rejected: number;
  reasons: Array<{ key: string; count: number; pctOfRejected: number }>;
  shadowStats: Record<string, Shadow>;
  timeStopStats?: Record<string, { win: number; loss: number; netR: number; realNetR: number }>;
  cancelStats?: Record<string, { win: number; loss: number; netR: number }>;
}

const pad = (s: string | number, n: number) => String(s).padStart(n);

async function main() {
  reportEnvLoad(loadEnvFile());
  const base = process.env.APP_URL ?? 'https://traddingapp-nu.vercel.app';
  const secret = process.env.WEBHOOK_SECRET ?? 'abc123';

  const res = await fetch(`${base}/api/reject-funnel?days=${DAYS}`, {
    headers: { 'x-webhook-secret': secret },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — 檢查 WEBHOOK_SECRET`);
  const j = await res.json() as Funnel;
  if (!j.ok) throw new Error('端點回 ok:false');

  console.log(`\n過去 ${DAYS} 天：候選 ${j.total}、發出 ${j.sent}、擋掉 ${j.rejected}`
    + `（通過率 ${(j.sent / j.total * 100).toFixed(1)}%）`);
  console.log('\n擋最多的關卡');
  for (const r of j.reasons.slice(0, 6)) {
    console.log(`  ${r.key.padEnd(20)} ${pad(r.count, 4)}  ${pad(r.pctOfRejected, 3)}%`);
  }

  console.log('\n影子模擬判定（netR<0 = 擋對了）');
  console.log(`  ${'關卡'.padEnd(18)}${pad('已結案', 7)}${pad('悲觀', 6)}${pad('覆蓋', 6)}`
    + `${pad('樂觀netR', 10)}${pad('悲觀netR', 10)}  判定`);

  const rows = Object.entries(j.shadowStats)
    .map(([k, v]) => ({ k, v, done: v.win + v.loss + v.other }))
    .sort((a, b) => b.done - a.done);

  for (const { k, v, done } of rows) {
    const cov = done > 0 ? v.pessCovered / done : 0;
    let verdict: string;
    if (done < 5) {
      verdict = `樣本太少（${done}）`;
    } else if (cov < MIN_COVERAGE) {
      // 這是最重要的一條。覆蓋不足時 netRPess 多半是 0，而 0 會讓判斷看起來
      // 像「跨零」或讓區間看起來很寬——兩種誤讀都會導出錯誤的調參決定。
      verdict = `悲觀覆蓋 ${(cov * 100).toFixed(0)}% 不足，不可用`;
    } else if (Math.sign(v.netR) !== Math.sign(v.netRPess) || v.netR === 0) {
      verdict = '區間跨零，回答不了';
    } else {
      verdict = v.netR < 0 ? '✅ 擋對了' : '⚠ 擋錯了（擋掉的是會賺的單）';
    }
    if (CAPACITY_GATES.has(k)) verdict += '　※容量型，判語不適用';

    console.log(`  ${k.padEnd(18)}${pad(done, 7)}${pad(v.pessCovered, 6)}`
      + `${pad((cov * 100).toFixed(0) + '%', 6)}${pad(v.netR.toFixed(2), 10)}`
      + `${pad(v.netRPess.toFixed(2), 10)}  ${verdict}`);
  }

  if (j.timeStopStats) {
    console.log('\n時間止損（netR = 不砍會怎樣；realNetR = 實際出場）');
    for (const [k, v] of Object.entries(j.timeStopStats)) {
      const saved = v.realNetR - v.netR;
      console.log(`  ${k.padEnd(10)} 不砍 ${pad(v.netR.toFixed(2), 8)}R  實際 ${pad(v.realNetR.toFixed(2), 7)}R`
        + `  → ${saved >= 0 ? '省下' : '損失'} ${Math.abs(saved).toFixed(2)}R`);
    }
  }

  if (j.cancelStats) {
    console.log('\n推薦單失效（netR = 當下市價進場會怎樣）');
    for (const [k, v] of Object.entries(j.cancelStats)) {
      const n = v.win + v.loss;
      // 全勝或全敗在真實資料裡幾乎不存在，多半是量測假象（樣本太小或
      // walkTpSl 的樂觀偏誤）。標出來，不要當成發現。
      const suspicious = n >= 5 && (v.loss === 0 || v.win === 0);
      console.log(`  ${k.padEnd(20)} ${pad(v.win, 3)}勝 ${pad(v.loss, 3)}敗  netR ${pad(v.netR.toFixed(2), 7)}`
        + (suspicious ? '   ⚠ 全勝/全敗，先當量測假象' : ''));
    }
  }
  console.log('');
}

main().catch(e => {
  console.error('中止：', e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
