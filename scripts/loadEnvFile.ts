// 從 .env.local 讀環境變數。給 scripts/ 底下的工具用。
//
// ## 為什麼需要這個
//
// 專案沒裝 dotenv，所有 scripts 都要求變數已經設在 shell 裡。那對常駐的
// live-runner 沒問題（設一次跑很久），但對「跑一次看結果」的工具很痛苦——
// 每開一個新終端機就要重設一輪，而其中包含 SUPABASE_SERVICE_ROLE_KEY 和
// 幣安 API secret 這種**不該反覆複製貼上**的東西。複製貼上次數愈多，
// 貼錯地方（聊天視窗、共享畫面、issue）的機率愈高。
//
// 寫進 .env.local 只需要一次，而且那個檔案已經在 .gitignore 裡。
//
// ## 刻意不做的事
//
// - **不覆蓋已存在的 process.env**。shell 設的優先，檔案只補沒有的。
//   否則在 EC2 上跑會被一個過期的本機檔案蓋掉正式設定，而且是靜默的。
// - **不印出任何值**，連長度或前綴都不印。只印「讀到 N 個變數」和變數名。
//   診斷訊息洩漏金鑰前綴是真實發生過的事故類型。
// - **不解析引號逸出、不支援多行值**。這是給人手寫的簡單設定檔，
//   實作愈簡單愈不會有「我以為它讀到了但其實沒有」的狀況。
//
// ## 不套用到 live-runner
//
// live-runner 目前的行為是「變數沒設就明確報錯」，那對真的會下單的常駐
// 程式是對的——不該因為某台機器上剛好有一個舊檔案就默默跑起來。要改的話
// 是獨立決定，不順手夾帶。

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

export interface LoadEnvResult {
  path: string;
  found: boolean;
  /** 這次真的寫進 process.env 的變數名（不含值）。 */
  applied: string[];
  /** 檔案裡有、但 shell 已經設了所以跳過的變數名。 */
  skipped: string[];
}

export function loadEnvFile(fileName = '.env.local'): LoadEnvResult {
  const path = resolve(process.cwd(), fileName);
  if (!existsSync(path)) {
    return { path, found: false, applied: [], skipped: [] };
  }

  // 明確 utf-8：Windows 預設 CP950 會把非 ASCII 值讀成亂碼，而金鑰讀錯只會
  // 表現成「API 說你沒授權」，很難聯想到編碼。
  const text = readFileSync(path, 'utf-8');
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    // 去掉整段包住的引號。刻意只脫一層、不處理內部逸出。
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }

    if (process.env[key] != null && process.env[key] !== '') {
      skipped.push(key);
      continue;
    }
    process.env[key] = value;
    applied.push(key);
  }

  return { path, found: true, applied, skipped };
}

/** 印出載入結果。**只印變數名，永遠不印值。** */
export function reportEnvLoad(r: LoadEnvResult): void {
  if (!r.found) {
    console.log(`（沒有 ${r.path}，改用 shell 環境變數）`);
    return;
  }
  console.log(`已載入 ${r.path}：${r.applied.length} 個變數`
    + (r.skipped.length > 0 ? `（${r.skipped.length} 個已由 shell 設定，維持原值）` : ''));
  if (r.applied.length > 0) console.log(`  ${r.applied.join(', ')}`);
}
