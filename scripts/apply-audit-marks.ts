#!/usr/bin/env npx tsx
/**
 * 把對帳結果寫回 Supabase —— 標記哪些紀錄是捏造的，並補上真實損益。
 *
 * ## 為什麼跟對帳分成兩支
 *
 * `audit-fabricated-exits.ts` 刻意沒有任何寫入路徑。量測工具具備寫入能力是
 * 危險的：量錯的時候會連帶把資料改錯，而且改完就再也驗不出當初量錯了。
 * 這一整輪的教訓正是「量測工具說謊」——歸因分析的判語是擲硬幣、影子模擬
 * 有樂觀偏誤、出場模擬器的停滯規則抄錯。那些都是先發現數字怪、回頭查工具
 * 才抓到的；如果工具當時已經把結論寫進 DB，就沒有回頭路。
 *
 * 所以：**量測只讀，寫入獨立、明確、預設不執行。**
 *
 * ## 不改原始欄位
 *
 * 只寫 audit_* 欄位，`result` / `pnl_percent` / `exit_price` **一律不動**。
 *
 * 那些欄位記錄的是「當時系統以為發生了什麼」，本身就是除錯證據。改寫它們會
 * 讓那個資訊永久消失，而我們正是靠「DB 記 -0.05% 但實際 +6.01%」這種對照
 * 才定位到保本出場被捏造。統計要排除髒資料，用 audit_verdict 過濾即可。
 *
 * ## 用法
 *
 *   npx tsx scripts/apply-audit-marks.ts <報告.json>            # 試跑，只列出會改什麼
 *   npx tsx scripts/apply-audit-marks.ts <報告.json> --apply    # 真的寫入
 *
 * 先跑 migration：
 *
 *   ALTER TABLE trades
 *     ADD COLUMN IF NOT EXISTS audit_verdict TEXT,
 *     ADD COLUMN IF NOT EXISTS audit_real_pnl_usdt DOUBLE PRECISION,
 *     ADD COLUMN IF NOT EXISTS audit_real_r DOUBLE PRECISION,
 *     ADD COLUMN IF NOT EXISTS audit_at BIGINT;
 */

import { createClient } from '@supabase/supabase-js';
import { loadEnvFile, reportEnvLoad } from './loadEnvFile';
import { readFileSync, existsSync } from 'fs';

interface Finding {
  id: string;
  symbol: string;
  verdict: string;
  dbPnlPct: number | null;
  realPnlPct: number | null;
  realizedPnlUsdt: number | null;
  realR: number | null;
}

const APPLY = process.argv.includes('--apply');
const reportPath = process.argv.slice(2).find(a => !a.startsWith('--'));

const fmt = (n: number | null, d = 2) => n == null || !Number.isFinite(n) ? '—' : n.toFixed(d);

async function main() {
  if (!reportPath) throw new Error('用法：npx tsx scripts/apply-audit-marks.ts <報告.json> [--apply]');
  if (!existsSync(reportPath)) throw new Error(`找不到報告檔：${reportPath}`);

  reportEnvLoad(loadEnvFile());
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');

  const report = JSON.parse(readFileSync(reportPath, 'utf-8')) as {
    generatedAt: number; findings: Finding[];
  };
  const findings = report.findings ?? [];
  console.log(`報告 ${reportPath}（產生於 ${new Date(report.generatedAt).toISOString().slice(0, 16).replace('T', ' ')}），${findings.length} 筆`);

  const byVerdict = findings.reduce<Record<string, number>>((m, f) => {
    m[f.verdict] = (m[f.verdict] ?? 0) + 1; return m;
  }, {});
  console.log(`  ${Object.entries(byVerdict).map(([k, v]) => `${k}=${v}`).join('  ')}`);

  console.log(`\n將寫入 audit_verdict / audit_real_pnl_usdt / audit_real_r / audit_at`);
  console.log(`不會動 result / pnl_percent / exit_price\n`);

  // 硬證據那幾筆列出來——這是人唯一會想逐筆確認的部分。
  const hard = findings.filter(f => f.verdict === 'NO_CLOSE_FILL' || f.verdict === 'SIGN_FLIP');
  if (hard.length > 0) {
    console.log(`── 硬證據 ${hard.length} 筆 ──`);
    for (const f of hard) {
      console.log(`  ${f.symbol.replace('USDT', '').padEnd(6)} [${f.verdict}] `
        + `DB ${fmt(f.dbPnlPct)}% → 實際 ${fmt(f.realPnlPct)}% / ${fmt(f.realizedPnlUsdt, 4)} USDT / ${fmt(f.realR, 3)}R`);
    }
    console.log('');
  }

  if (!APPLY) {
    console.log('試跑模式，沒有寫入任何東西。確認上面無誤後加 --apply 執行。');
    return;
  }

  const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const at = Date.now();
  let ok = 0;
  const errs: string[] = [];

  for (const f of findings) {
    const { error } = await db.from('trades').update({
      audit_verdict: f.verdict,
      audit_real_pnl_usdt: f.realizedPnlUsdt,
      audit_real_r: f.realR,
      audit_at: at,
    }).eq('id', f.id);

    if (error) {
      // 42703 / PGRST204 = 欄位不存在。這是最可能的失敗，講清楚要跑什麼，
      // 而且第一次就中止——沒必要對每一筆重複同樣的錯誤。
      if (error.code === '42703' || error.code === 'PGRST204') {
        console.error(`\n❌ audit_* 欄位不存在。先在 Supabase SQL Editor 執行：\n`);
        console.error(`ALTER TABLE trades`);
        console.error(`  ADD COLUMN IF NOT EXISTS audit_verdict TEXT,`);
        console.error(`  ADD COLUMN IF NOT EXISTS audit_real_pnl_usdt DOUBLE PRECISION,`);
        console.error(`  ADD COLUMN IF NOT EXISTS audit_real_r DOUBLE PRECISION,`);
        console.error(`  ADD COLUMN IF NOT EXISTS audit_at BIGINT;\n`);
        process.exitCode = 1;
        return;
      }
      errs.push(`${f.id}: [${error.code}] ${error.message}`);
    } else {
      ok++;
    }
  }

  console.log(`寫入完成：${ok} 筆成功${errs.length > 0 ? `、${errs.length} 筆失敗` : ''}`);
  errs.slice(0, 10).forEach(e => console.log(`  ${e}`));
  console.log('\n原始的 result / pnl_percent / exit_price 未被修改。');
  console.log('統計要排除髒資料時，過濾 audit_verdict NOT IN (\'NO_CLOSE_FILL\',\'SIGN_FLIP\')。');
}

main().catch(e => {
  console.error('中止：', e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
