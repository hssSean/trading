#!/usr/bin/env npx tsx
/**
 * S3／S1 月報（docs/strategy-deploy-2026-10-06.md §7，每月交回研究端對帳）。唯讀。
 *
 *   ENV_FILE=env.txt npm run s3s1-report              # 這個月到目前為止
 *   ENV_FILE=env.txt npm run s3s1-report -- 2026-10   # 指定月份（UTC）
 *
 * 印出四個帳戶的摘要，並把 §7 要的三種紀錄寫成 CSV（UTF-8 BOM，Excel 直接開）：
 *   reports/s3s1-YYYY-MM/signals.csv      模擬帳本的訊號紀錄（含被擋掉的與擋掉原因、分數三個分項）
 *   reports/s3s1-YYYY-MM/live-signals.csv testnet S3-A＋S3-B 的訊號紀錄（含被擋掉的、A／B 各自決策）
 *   reports/s3s1-YYYY-MM/trades.csv       模擬帳本的交易（進出場、R、加碼 R、損益）
 *   reports/s3s1-YYYY-MM/live-trades.csv  testnet S3-A＋S3-B 的交易（成交價、滑價、止損移動、手續費、資金費、A／B 分帳）
 * 統計口徑與 App 的 /strategies 頁面共用 src/lib/s3s1/stats.ts。
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Redis } from '@upstash/redis';
import { loadEnvFile, reportEnvLoad } from './loadEnvFile';
import { ACCTS, type AcctKey, type AcctState, type Position, type SignalLog } from '../src/lib/s3s1/engine';
import { legsOf, type LivePos, type LiveSignal } from '../src/engine/s3aLive';
import { summarizeAcct, summarizeLive, legOf, type LiveDone } from '../src/lib/s3s1/stats';

const parse = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString().replace('.000Z', 'Z') : '');
const cell = (v: unknown) => {
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function csv(path: string, rows: Record<string, unknown>[]): void {
  const cols = Array.from(new Set(rows.flatMap(r => Object.keys(r))));
  const body = [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n');
  writeFileSync(path, '﻿' + body + '\n', { encoding: 'utf-8' });
  console.log(`   ${path}（${rows.length} 列）`);
}

async function main(): Promise<void> {
  reportEnvLoad(loadEnvFile());
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('缺 UPSTASH_REDIS_REST_URL／UPSTASH_REDIS_REST_TOKEN');
  const r = new Redis({ url, token });

  const arg = process.argv.slice(2).find(a => /^\d{4}-\d{2}$/.test(a));
  const now = new Date();
  const [y, m] = arg ? arg.split('-').map(Number) : [now.getUTCFullYear(), now.getUTCMonth() + 1];
  const from = Date.UTC(y, m - 1, 1), to = Date.UTC(y, m, 1);
  const month = `${y}-${String(m).padStart(2, '0')}`;
  const inMonth = (t: number | null | undefined) => t != null && t >= from && t < to;
  console.log(`月份 ${month}（UTC）\n`);

  const meta = ((await r.hgetall<Record<string, unknown>>('s3s1:meta')) ?? {}) as Record<string, unknown>;
  const sigs = ((await r.lrange('s3s1:signals', 0, -1)) ?? []).map(x => parse<SignalLog>(x)).filter(s => inMonth(s.signalT));
  const trades: Record<string, unknown>[] = [];
  for (const k of Object.keys(ACCTS) as AcctKey[]) {
    const [o, d] = await Promise.all([r.hgetall(`s3s1:${k}:open`), r.hgetall(`s3s1:${k}:done`)]);
    const all = [...Object.values(o ?? {}), ...Object.values(d ?? {})].map(x => parse<Position>(x));
    const s = summarizeAcct(k, meta[`acct.${k}`] ? parse<AcctState>(meta[`acct.${k}`]) : null, all);
    console.log(`${s.name}\n   權益 ${s.equity.toFixed(2)} USDT（${s.retPct >= 0 ? '+' : ''}${s.retPct.toFixed(1)}%）回撤 ${s.ddPct.toFixed(1)}%（最大 ${s.maxDdPct.toFixed(1)}%）`
      + `｜已結束 ${s.trades}（勝 ${s.wins}）每筆 ${s.avgR == null ? '—' : s.avgR.toFixed(3) + 'R'}｜持倉 ${s.open}${s.halted ? `｜⛔ ${s.halted}` : ''}`);
    for (const p of all.filter(p => inMonth(p.entryT) || inMonth(p.exitT))) {
      trades.push({ acct: k, symbol: p.symbol, signalT: iso(p.signalT), entryT: iso(p.entryT), entry: p.entry, stop: p.stop, qty: p.qty,
        riskUsdt: p.riskUsdt, minQtyUsed: p.minQtyUsed, score: p.score, dist: p.dist, btcExt: p.btcExt, ret7: p.ret7, breadth: p.breadth,
        funding: p.funding, status: p.status, partial: p.partial, exitT: iso(p.exitT), exitPx: p.exitPx, exitReason: p.exitReason,
        grossR: p.grossR, netR: p.netR, addR: p.addR, pnlUsdt: p.pnlUsdt, equityAfter: p.equityAfter });
    }
  }

  const lm = ((await r.hgetall<Record<string, unknown>>('s3a-live:meta')) ?? {}) as Record<string, unknown>;
  const lOpen = Object.values((await r.hgetall('s3a-live:pos')) ?? {}).map(x => parse<LivePos>(x));
  const lDone = Object.values((await r.hgetall('s3a-live:done')) ?? {}).map(x => parse<LivePos & LiveDone>(x));
  for (const leg of ['A', 'B'] as const) {
    const ls = summarizeLive(lm, lDone, leg);
    console.log(`${ls.name}｜testnet 真倉（同帳戶分帳）\n   已實現 ${ls.realized.toFixed(2)} USDT（${ls.retPct == null ? '—' : ls.retPct.toFixed(2) + '%'}）`
      + `｜已結束 ${ls.trades}（勝 ${ls.wins}）每筆 ${ls.avgR == null ? '—' : ls.avgR.toFixed(3) + 'R'}${ls.halted ? `｜⛔ ${ls.halted}` : ''}`);
  }
  console.log(`   真倉持倉 ${lOpen.length}`);
  const liveTrades = [...lOpen.map(p => ({ ...p, status: 'open' })), ...lDone].filter(p => inMonth(p.entryAt) || inMonth((p as LiveDone).exitAt))
    .map(p => {
      const d = p as Partial<LiveDone> & LivePos & { status: string };
      return { symbol: d.symbol, signalDay: iso(d.signalDay), entryAt: iso(d.entryAt), refPx: d.refPx, entry: d.entry,
        slippageBp: d.refPx ? (d.entry / d.refPx - 1) * 1e4 : null, qty0: d.qty0, stop0: d.stop0, stopNow: d.stop, partial: d.partial,
        score: d.score, dist: d.dist, btcExt: d.btcExt, ret7: d.ret7, breadth: d.breadth, fundingRate: d.funding, status: d.status,
        exitAt: iso(d.exitAt), exitAvg: d.exitAvg, R: d.R, netPnl: d.netPnl, fee: d.fee, fundingFee: d.fundingFee,
        qtyA: legsOf(d).A?.qty0, qtyB: legsOf(d).B?.qty0, addQty: d.addQty, addFilled: d.addFilled, addEntry: d.addEntry,
        netA: d.exitAt ? legOf(d as LiveDone, 'A')?.net : null, R_A: d.exitAt ? legOf(d as LiveDone, 'A')?.R : null,
        netB: d.exitAt ? legOf(d as LiveDone, 'B')?.net : null, R_B: d.exitAt ? legOf(d as LiveDone, 'B')?.R : null,
        events: d.events };
    });
  const liveSigs = ((await r.lrange('s3a-live:signals', 0, -1)) ?? []).map(x => parse<LiveSignal>(x)).filter(s => inMonth(s.signalDay));

  const dir = join('reports', `s3s1-${month}`);
  mkdirSync(dir, { recursive: true });
  console.log('\n匯出：');
  csv(join(dir, 'signals.csv'), sigs.map(s => ({ acct: s.acct, symbol: s.symbol, signalT: iso(s.signalT), decision: s.decision, reason: s.reason,
    close: s.close, stop: s.stop, entry: s.entry, dist: s.dist, score: s.score,
    scoreRisk: s.scoreParts?.[0], scoreBtc: s.scoreParts?.[1], scoreRet7: s.scoreParts?.[2],
    btcOk: s.btcOk, breadth: s.breadth, funding: s.funding, ...s.ind, loggedAt: iso(s.at) })));
  csv(join(dir, 'live-signals.csv'), liveSigs.map(s => ({ ...s, signalDay: iso(s.signalDay), at: iso(s.at),
    scoreRisk: s.scoreParts?.[0], scoreBtc: s.scoreParts?.[1], scoreRet7: s.scoreParts?.[2], scoreParts: undefined,
    legA: s.legs?.A, legB: s.legs?.B, legs: undefined })));
  csv(join(dir, 'trades.csv'), trades);
  csv(join(dir, 'live-trades.csv'), liveTrades);
}

main().catch(e => { console.error(e); process.exit(1); });
