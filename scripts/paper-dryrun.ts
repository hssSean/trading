#!/usr/bin/env npx tsx
/**
 * 紙上策略執行器的本機試跑：真的幣安資料、記憶體裡的假 Redis（不碰線上 Redis）。
 *
 *   npx tsx scripts/paper-dryrun.ts [回溯天數=4]
 *
 * 假裝「上次處理是 N 天前」，跑一次 strategyA 與 video，印出產生的紀錄與耗時。
 * 用來在部署前確認：資料抓得到、時間邊界對、單次執行時間在 Vercel 60 秒內。
 */
import { runStrategyA, runVideo, type PaperStore } from '../src/lib/paper/runner';
import { binancePaperDeps } from '../src/lib/paper/deps';

const D = 86_400_000, H = 3_600_000;
class MemStore implements PaperStore {
  m = new Map<string, Map<string, string>>();
  async hgetall(k: string) { const x = this.m.get(k); return x && x.size ? Object.fromEntries(x) : null; }
  async hset(k: string, kv: Record<string, string>) { if (!this.m.has(k)) this.m.set(k, new Map()); for (const [a, b] of Object.entries(kv)) this.m.get(k)!.set(a, b); return 1; }
  async hdel(k: string, ...f: string[]) { for (const x of f) this.m.get(k)?.delete(x); return 1; }
}

async function main(): Promise<void> {
  const back = Math.max(1, parseInt(process.argv[2] ?? '4', 10));
  const now = Date.now();
  const dayT = Math.floor(now / D) * D;
  const st = new MemStore();
  await st.hset('paper:meta', { 'strategyA.lastT': String(dayT - (back + 1) * D), 'video.lastT': String(Math.floor(now / H) * H - back * D) });

  for (const [name, fn] of [['strategyA', runStrategyA], ['video', runVideo]] as const) {
    const t0 = Date.now();
    const s = await fn(st, binancePaperDeps, now);
    console.log(`\n── ${name}：${((Date.now() - t0) / 1000).toFixed(1)} 秒  新紀錄 ${s.newRecords}  已結束 ${s.finished}  未結束 ${s.open}  錯誤 ${s.errors}`);
    s.notes.slice(0, 5).forEach(n => console.log(`   ${n}`));
  }
  for (const strat of ['strategyA', 'videoA', 'videoB', 'videoC']) {
    const recs = [...Object.values((await st.hgetall(`paper:${strat}:open`)) ?? {}), ...Object.values((await st.hgetall(`paper:${strat}:done`)) ?? {})]
      .map(v => JSON.parse(v as string));
    const by = new Map<string, number>();
    recs.forEach(r => by.set(r.status, (by.get(r.status) ?? 0) + 1));
    console.log(`\n${strat}：${recs.length} 筆  ${Array.from(by.entries()).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    recs.slice(0, 4).forEach(r => console.log(`   ${r.symbol} ${new Date(r.signalT ?? r.startT).toISOString().slice(0, 16)} ${r.side === -1 ? 'short' : 'long'} `
      + `stop ${(r.stop ?? r.sl).toPrecision(6)} → ${r.status}${r.grossR != null ? ` ${r.grossR.toFixed(2)}R` : ''}${r.reason ? ` (${r.reason})` : ''}`));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
