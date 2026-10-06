#!/usr/bin/env npx tsx
/**
 * 從本機立刻執行 S3／S1 帳本工作（寫線上 Redis，跟 /api/analyze 觸發的是同一支程式）。
 * 平常不用跑——Vercel 每天會自己跑；這支用在「部署當下就想初始化」或「Vercel 那邊漏跑想補」。
 *
 *   ENV_FILE=env.txt npm run s3s1-run          # 依時間跑所有該跑的（prep → s3 → s1）
 *
 * 第一次執行時 s3／s1 只記錄起點，不回溯開倉（帳本從「現在」開始，跟回測分開）。
 */
import { Redis } from '@upstash/redis';
import { loadEnvFile, reportEnvLoad } from './loadEnvFile';
import { runPrep, runS3, runS1, dueS3S1Job, type Store } from '../src/lib/s3s1/engine';
import { binanceS3S1Deps } from '../src/lib/s3s1/deps';

async function main(): Promise<void> {
  reportEnvLoad(loadEnvFile());
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('缺 UPSTASH_REDIS_REST_URL／UPSTASH_REDIS_REST_TOKEN');
  const store = new Redis({ url, token }) as unknown as Store;
  for (let i = 0; i < 3; i++) {
    const now = Date.now();
    const job = dueS3S1Job((await store.hgetall('s3s1:meta')) ?? {}, now);
    if (!job) { console.log(i ? '都跑完了。' : '目前沒有該跑的工作（prep 在 UTC 00:05 後、S3 在 01:05 後、S1 在每個 12H 收盤 1 小時 5 分後）。'); return; }
    const t0 = Date.now();
    const fn = job === 'prep' ? runPrep : job === 's3' ? runS3 : runS1;
    const r = await fn(store, binanceS3S1Deps, now);
    console.log(`── ${job}：${((Date.now() - t0) / 1000).toFixed(1)} 秒 ${JSON.stringify(r)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
