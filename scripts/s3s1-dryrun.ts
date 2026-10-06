#!/usr/bin/env npx tsx
/**
 * S3／S1 帳戶模擬的本機試跑：真的幣安資料、記憶體裡的假 Redis（不碰線上）。
 *
 *   npx tsx scripts/s3s1-dryrun.ts [回溯天數=6]
 *
 * 假裝「上次處理是 N 天前」，依序跑 prep → s3 → s1，印出每個帳戶的訊號決策、持倉、權益與耗時。
 */
import { runPrep, runS3, runS1, ACCTS, type Store, type AcctKey } from '../src/lib/s3s1/engine';
import { binanceS3S1Deps } from '../src/lib/s3s1/deps';

const D = 86_400_000, H = 3_600_000, H12 = 12 * H;
class MemStore implements Store {
  kv = new Map<string, string>(); h = new Map<string, Map<string, string>>(); l = new Map<string, string[]>();
  async get(k: string) { return this.kv.get(k) ?? null; }
  async set(k: string, v: string) { this.kv.set(k, v); return 'OK'; }
  async hgetall(k: string) { const x = this.h.get(k); return x && x.size ? Object.fromEntries(x) : null; }
  async hset(k: string, kv: Record<string, string>) { if (!this.h.has(k)) this.h.set(k, new Map()); for (const [a, b] of Object.entries(kv)) this.h.get(k)!.set(a, b); return 1; }
  async hdel(k: string, ...f: string[]) { for (const x of f) this.h.get(k)?.delete(x); return 1; }
  async lpush(k: string, ...v: string[]) { this.l.set(k, [...v.reverse(), ...(this.l.get(k) ?? [])]); return 1; }
  async ltrim(k: string, a: number, b: number) { this.l.set(k, (this.l.get(k) ?? []).slice(a, b + 1)); return 'OK'; }
}

async function main(): Promise<void> {
  const back = Math.max(1, parseInt(process.argv[2] ?? '6', 10));
  const now = Date.now();
  const X = Math.floor(now / D) * D;
  const st = new MemStore();
  const latest = Math.floor((now - H) / H12) * H12;
  await st.hset('s3s1:meta', { 's3.lastDay': String(X - back * D), 's1.lastT': String(latest - back * 2 * H12) });
  for (const [name, fn] of [['prep', runPrep], ['s3', runS3], ['s1', runS1]] as const) {
    const t0 = Date.now();
    const r = await fn(st, binanceS3S1Deps, now);
    console.log(`── ${name}：${((Date.now() - t0) / 1000).toFixed(1)} 秒 ${JSON.stringify(r)}`);
  }
  const logs = (st.l.get('s3s1:signals') ?? []).map(x => JSON.parse(x));
  for (const k of Object.keys(ACCTS) as AcctKey[]) {
    const meta = await st.hgetall('s3s1:meta');
    const s = meta?.[`acct.${k}`] ? JSON.parse(meta[`acct.${k}`] as string) : null;
    const open = Object.values((await st.hgetall(`s3s1:${k}:open`)) ?? {}).map(v => JSON.parse(v as string));
    const done = Object.values((await st.hgetall(`s3s1:${k}:done`)) ?? {}).map(v => JSON.parse(v as string));
    console.log(`\n${ACCTS[k].name}：權益 ${s?.equity?.toFixed(2)} USDT  持倉 ${open.length}  已結束 ${done.length}${s?.halted ? `  ⛔ ${s.halted}` : ''}`);
    for (const p of [...open, ...done]) console.log(`   ${p.status === 'open' ? '持倉' : '結束'} ${p.symbol.padEnd(12)} 訊號 ${new Date(p.signalT).toISOString().slice(0, 16)} E ${p.entry} SL ${p.stop.toPrecision(6)} 數量 ${p.qty} 風險 ${p.riskUsdt.toFixed(2)}U${p.status === 'done' ? ` → ${p.netR.toFixed(3)}R ${p.pnlUsdt.toFixed(2)}U (${p.exitReason})` : ''}`);
    const mine = logs.filter(l => l.acct === k);
    const by = new Map<string, number>();
    for (const l of mine) { const key = l.decision === 'open' ? '開倉' : (l.reason ?? '?').replace(/（.*$/, '').replace(/\d+(\.\d+)?/g, 'n'); by.set(key, (by.get(key) ?? 0) + 1); }
    console.log(`   訊號 ${mine.length}：${Array.from(by.entries()).map(([a, b]) => `${a}×${b}`).join('、')}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
