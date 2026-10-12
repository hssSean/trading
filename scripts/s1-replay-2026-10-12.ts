#!/usr/bin/env npx tsx
/**
 * 一次性補救（2026-10-12）：S1 幣池 bug（commit 6c5106b）修好後，重建 10/07 起的 prep 快照、
 * 讓 S1 帳本從追蹤起點重播。
 *
 * 舊快照的 uni[X] 全是空的，S1 讀到空幣池 → 10 個決策點 0 候選。重建用的是同一批已收盤日線，
 * S3 的部分（s3、breadth、btcOk、uni[D]）會完全相同；重播 S1 時每個決策點只用當時已收盤的
 * 資料，跟「程式當時就正確」會做的事一樣。S1 是 100 USDT 模擬帳本，不動真倉。
 *
 *   ENV_FILE=env.txt npx tsx scripts/s1-replay-2026-10-12.ts            # 試跑：寫在記憶體，印結果
 *   ENV_FILE=env.txt npx tsx scripts/s1-replay-2026-10-12.ts --apply    # 寫回 Redis（先備份到 reports/）
 */
import { writeFileSync, mkdirSync } from 'fs';
import { Redis } from '@upstash/redis';
import { loadEnvFile, reportEnvLoad } from './loadEnvFile';
import { runPrep, runS1, type Store, type PrepSnapshot } from '../src/lib/s3s1/engine';
import { binanceS3S1Deps } from '../src/lib/s3s1/deps';

const DAY = 86_400_000;
const apply = process.argv.includes('--apply');

/** 讀 Redis、寫記憶體；deleted 裡的 key 讀起來當作不存在 */
function overlay(r: Redis, deleted: Set<string>): Store & { writes: Map<string, unknown> } {
  const w = new Map<string, unknown>();
  const hash = async (k: string) => (w.has(k) ? (w.get(k) as Record<string, unknown>) : deleted.has(k) ? {} : { ...((await r.hgetall(k)) ?? {}) });
  return {
    writes: w,
    get: async k => (w.has(k) ? w.get(k) : deleted.has(k) ? null : r.get(k)),
    set: async (k, v) => { w.set(k, v); return 'OK'; },
    hgetall: async k => hash(k),
    hset: async (k, kv) => { w.set(k, { ...(await hash(k)), ...kv }); return 1; },
    hdel: async (k, ...f) => { const h = await hash(k); for (const x of f) delete h[x]; w.set(k, h); return f.length; },
    lpush: async (k, ...v) => { w.set(k, [...v.reverse(), ...((w.get(k) as string[]) ?? [])]); return v.length; },
    ltrim: async () => 'OK',
  };
}

async function main() {
  reportEnvLoad(loadEnvFile());
  const r = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });
  const now = Date.now();
  const X = Math.floor(now / DAY) * DAY;
  const meta = (await r.hgetall<Record<string, unknown>>('s3s1:meta')) ?? {};
  const trackStart = Number(meta['trackStart.s1']);
  const startDay = Math.floor(trackStart / DAY) * DAY;
  const initLastT = Math.floor((trackStart - 3_600_000) / (12 * 3_600_000)) * 12 * 3_600_000; // runS1 初始化時寫的 s1.lastT
  const s1State = meta['acct.s1'] ? (typeof meta['acct.s1'] === 'string' ? JSON.parse(meta['acct.s1']) : meta['acct.s1']) : null;
  if (s1State && s1State.trades > 0) throw new Error(`S1 帳本已經有 ${s1State.trades} 筆交易，這支只處理「從沒開過單」的情況`);

  const prepKeys: string[] = [];
  for (let d = startDay; d <= X; d += DAY) prepKeys.push(`s3s1:prep:${d}`);
  console.log(`追蹤起點 ${new Date(trackStart).toISOString()}；重建 ${prepKeys.length} 份快照；S1 從 ${new Date(initLastT).toISOString()} 之後重播`);

  // 備份
  const backup: Record<string, unknown> = { meta };
  for (const k of prepKeys) backup[k] = await r.get(k);
  mkdirSync('reports', { recursive: true });
  const bf = `reports/s1-replay-backup-${new Date(now).toISOString().slice(0, 10)}.json`;
  writeFileSync(bf, JSON.stringify(backup), { encoding: 'utf-8' });
  console.log(`備份 → ${bf}`);

  const store: Store = apply ? (r as unknown as Store) : overlay(r, new Set(prepKeys));
  if (apply) for (const k of prepKeys) await r.del(k);

  const prep = await runPrep(store, binanceS3S1Deps, now);
  console.log('prep', JSON.stringify(prep));
  for (const k of prepKeys) {
    const v = await store.get(k);
    const s = (typeof v === 'string' ? JSON.parse(v) : v) as PrepSnapshot | null;
    const old = backup[k] ? ((typeof backup[k] === 'string' ? JSON.parse(backup[k] as string) : backup[k]) as PrepSnapshot) : null;
    const same = old && s && old.breadth === s.breadth && JSON.stringify(old.s3) === JSON.stringify(s.s3);
    console.log(`  ${k.slice(-13)} ${new Date(Number(k.slice(-13))).toISOString().slice(0, 10)}  uni `
      + (s ? Object.entries(s.uni).map(([d, a]) => `${new Date(+d).toISOString().slice(5, 10)}:${a.length}`).join(' ') : '—')
      + `  S3 部分與舊快照${old ? (same ? '相同 ✓' : '不同 ✗') : '（舊的不存在）'}`);
  }

  await store.hset('s3s1:meta', { 's1.lastT': String(initLastT), 's1.replayedAt': String(now) });
  const s1 = await runS1(store, binanceS3S1Deps, now);
  console.log('S1 重播', JSON.stringify(s1).slice(0, 600));

  if (!apply) {
    const w = (store as ReturnType<typeof overlay>).writes;
    const logs = ((w.get('s3s1:signals') as string[]) ?? []).map(v => JSON.parse(v)).filter(l => l.acct === 's1');
    console.log(`\n試跑：S1 候選紀錄 ${logs.length} 筆`);
    for (const l of logs.slice().reverse()) {
      console.log(`  ${new Date(l.signalT).toISOString().slice(0, 16)} ${l.symbol.padEnd(14)} ${l.decision}${l.reason ? `（${l.reason}）` : ''}`);
    }
    const st = (w.get('s3s1:meta') as Record<string, unknown>)?.['acct.s1'];
    console.log('S1 帳戶', typeof st === 'string' ? st : JSON.stringify(st));
    console.log('\n（試跑，沒寫入 Redis。確認後加 --apply）');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
