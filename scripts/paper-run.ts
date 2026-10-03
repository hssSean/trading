#!/usr/bin/env npx tsx
/**
 * 從本機立刻跑一次紙上策略工作，寫進線上 Redis（跟 /api/analyze 自動觸發的是同一套程式）。
 *
 *   ENV_FILE=env.txt npm run paper-run -- strategyA
 *   ENV_FILE=env.txt npm run paper-run -- video
 *   ENV_FILE=env.txt npm run paper-run -- all
 *
 * 用途：剛部署時立刻開始追蹤、或某天自動執行失敗時補跑。重複執行是安全的——
 * 新訂單只收「上次處理時間」之後的，已結束的紀錄不會被改寫。只記錄、不下單。
 */
import { Redis } from '@upstash/redis';
import { loadEnvFile, reportEnvLoad } from './loadEnvFile';
import { runStrategyA, runVideo } from '../src/lib/paper/runner';
import { binancePaperDeps } from '../src/lib/paper/deps';

async function main(): Promise<void> {
  reportEnvLoad(loadEnvFile());
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('缺 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN');
  const which = process.argv[2] ?? 'all';
  if (!['strategyA', 'video', 'all'].includes(which)) throw new Error('參數只能是 strategyA、video 或 all');
  const r = new Redis({ url, token });
  const now = Date.now();
  for (const job of which === 'all' ? ['strategyA', 'video'] : [which]) {
    const s = job === 'strategyA' ? await runStrategyA(r, binancePaperDeps, now) : await runVideo(r, binancePaperDeps, now);
    console.log(`${job}：${s.initialized ? '已初始化（記下起點）' : ''} 新紀錄 ${s.newRecords}  已結束 ${s.finished}  未結束 ${s.open}  錯誤 ${s.errors}`);
    s.notes.slice(0, 5).forEach(n => console.log(`  ${n}`));
  }
}

main().catch(e => { console.error('paper-run error:', e); process.exit(1); });
