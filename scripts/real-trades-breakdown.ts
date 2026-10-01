#!/usr/bin/env npx tsx
/**
 * 真實成交拆解——虧損到底集中在哪裡。
 *
 *   ENV_FILE=env.txt npx tsx scripts/real-trades-breakdown.ts [audit 報告.json] [--since=YYYY-MM-DD]
 *
 * 輸入：`npm run audit-exits` 產出的報告（每筆的 realR 來自幣安真實成交，不是 DB 模擬）
 *      + Supabase trades 表的屬性（策略、方向、出場原因、MFE、分數、時框…）。
 * 只讀不寫。
 *
 * 讀法：每一組都列 n、平均 R、t。n < 20 或 |t| < 2 的組別**不要當結論**——
 * 同時切十幾個維度，純雜訊也會有一兩組看起來很顯著（多重比較）。
 * 這支的用途是找「方向一致、跨維度都指向同一件事」的線索，不是挑最好的組去上線。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { loadEnvFile, reportEnvLoad } from './loadEnvFile';
import { mean, f, tStat } from './lib/rstats';

interface Finding { id: string; symbol: string; direction: string; verdict: string; realR: number | null; closedAt: number }
type Row = Record<string, unknown>;

const FEE_ROUND_TRIP = 0.0007; // Maker 進場 0.02% + Taker 出場 0.05%（粗估，未含滑價與資金費率）

function group<T>(xs: T[], key: (x: T) => string | null): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) { const k = key(x); if (k == null) continue; if (!m.has(k)) m.set(k, []); m.get(k)!.push(x); }
  return m;
}

async function main(): Promise<void> {
  reportEnvLoad(loadEnvFile());
  // --since YYYY-MM-DD：只看該日之後平倉的（例如看「這一週」）
  const sinceArg = process.argv.find(a => a.startsWith('--since='));
  const since = sinceArg ? Date.parse(sinceArg.slice(8) + 'T00:00:00Z') : -Infinity;
  const file = process.argv.slice(2).find(a => !a.startsWith('--')) ?? readdirSync('.').filter(x => /^audit-fabricated-exits-.*\.json$/.test(x)).sort().pop();
  if (!file) throw new Error('找不到 audit 報告，先跑 npm run audit-exits');
  const findings = (JSON.parse(readFileSync(file, 'utf-8')).findings as Finding[])
    .filter(x => x.realR != null && Number.isFinite(x.realR) && x.closedAt >= since);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const ids = findings.map(x => x.id);
  const rows: Row[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await db.from('trades').select('*').in('id', ids.slice(i, i + 100));
    if (error) throw new Error(`Supabase：${error.message}`);
    rows.push(...(data ?? []));
  }
  const byId = new Map(rows.map(r => [r.id as string, r]));

  interface T { f: Finding; r: Row; R: number; netR: number; stopPct: number; mfeR: number | null; maeR: number | null }
  const ts: T[] = [];
  for (const fd of findings) {
    const r = byId.get(fd.id); if (!r) continue;
    const entry = Number(r.entry), sl = Number(r.stop_loss);
    const stopPct = entry > 0 ? Math.abs(entry - sl) / entry : NaN;
    const isLong = r.direction === 'LONG';
    const risk = Math.abs(entry - sl);
    const mfeP = Number(r.mfe_price ?? r.mfe ?? NaN), maeP = Number(r.mae_price ?? r.mae ?? NaN);
    const mfeR = Number.isFinite(mfeP) && risk > 0 ? (isLong ? mfeP - entry : entry - mfeP) / risk : null;
    const maeR = Number.isFinite(maeP) && risk > 0 ? (isLong ? maeP - entry : entry - maeP) / risk : null;
    const R = fd.realR as number;
    ts.push({ f: fd, r, R, netR: R - (stopPct > 0 ? FEE_ROUND_TRIP / stopPct : 0), stopPct, mfeR, maeR });
  }

  const line = (label: string, xs: T[]) => {
    const g = xs.map(x => x.R), n = xs.map(x => x.netR);
    const warn = xs.length < 20 ? '  ⚠n小' : '';
    return `  ${label.padEnd(22)} n=${String(xs.length).padStart(3)}  真實 ${f(mean(g)).padStart(7)}R  扣費後≈${f(mean(n)).padStart(7)}R  t=${f(tStat(n), 2).padStart(6)}  合計 ${f(n.reduce((a, b) => a + b, 0), 1).padStart(6)}R${warn}`;
  };
  const section = (title: string, key: (x: T) => string | null) => {
    console.log(`\n── ${title}`);
    Array.from(group(ts, key).entries()).sort((a, b) => b[1].length - a[1].length).forEach(([k, v]) => console.log(line(k, v)));
  };

  console.log('═'.repeat(90));
  console.log(`  真實成交拆解  |  ${file}  |  配到 DB 的 ${ts.length}/${findings.length} 筆`);
  console.log(`  「扣費後」= 真實 R − 0.07% ÷ 止損距離（粗估手續費，未含滑價／資金費率）`);
  console.log('═'.repeat(90));
  console.log(line('全部', ts));

  section('策略', x => String(x.r.strategy ?? 'A'));
  section('方向', x => String(x.r.direction));
  section('出場原因', x => String(x.r.close_reason ?? '(空)'));
  section('時框', x => String(x.r.timeframe ?? '?'));
  section('regime', x => String(x.r.regime ?? '?'));
  section('進場方式', x => {
    const sp = Number(x.r.signal_price), e = Number(x.r.entry);
    if (!(sp > 0)) return '未知';
    return Math.abs(sp - e) / e < 0.0005 ? '市價（進場≈訊號價）' : '限價回調';
  });
  section('止損距離', x => !(x.stopPct > 0) ? null : x.stopPct < 0.01 ? '< 1%' : x.stopPct < 0.02 ? '1–2%' : x.stopPct < 0.03 ? '2–3%' : '≥ 3%');
  section('分數', x => { const s = Number(x.r.score); return !Number.isFinite(s) ? null : s < 70 ? '< 70' : s < 75 ? '70–74' : s < 80 ? '75–79' : '≥ 80'; });
  section('幣種（≥5 筆）', x => ts.filter(y => y.f.symbol === x.f.symbol).length >= 5 ? x.f.symbol : null);
  section('開倉時段 UTC', x => { const h = new Date(Number(x.r.opened_at)).getUTCHours(); return `${String(Math.floor(h / 6) * 6).padStart(2, '0')}–${String(Math.floor(h / 6) * 6 + 5).padStart(2, '0')}時`; });

  // ── 交叉：排除已停用的部分（策略 B、做空）後，線索還在不在 ──
  // 2026-09-27：這兩個在單維度拆解裡最顯著，但都可能是被別的因素帶出來的——
  // 市價進場要求分數 ≥75 且 4H 同向（marketEntryException），所以「市價 vs 限價」
  // 跟「分數高低」糾纏在一起；止損 <1% 可能只是策略 B（沒有止損下限）。
  const cur = ts.filter(x => (x.r.strategy ?? 'A') === 'A' && x.r.direction === 'LONG');
  const entryKind = (x: T) => { const sp = Number(x.r.signal_price), e = Number(x.r.entry); return !(sp > 0) ? null : Math.abs(sp - e) / e < 0.0005 ? '市價' : '限價'; };
  console.log(`\n── 交叉（只看目前仍在跑的：策略 A、做多，n=${cur.length}）`);
  console.log(line('全部', cur));
  for (const k of ['市價', '限價']) console.log(line(`${k}`, cur.filter(x => entryKind(x) === k)));
  for (const [lab, p] of [['分數 ≥75', (s: number) => s >= 75], ['分數 <75', (s: number) => s < 75]] as const) {
    for (const k of ['市價', '限價']) console.log(line(`${lab}｜${k}`, cur.filter(x => p(Number(x.r.score)) && entryKind(x) === k)));
  }
  console.log(line('止損 <1%', cur.filter(x => x.stopPct < 0.01)));
  console.log(line('止損 ≥1%', cur.filter(x => x.stopPct >= 0.01)));
  console.log(line('限價｜止損 ≥1%', cur.filter(x => x.stopPct >= 0.01 && entryKind(x) === '限價')));
  console.log(line('市價｜止損 ≥1%', cur.filter(x => x.stopPct >= 0.01 && entryKind(x) === '市價')));
  console.log(`  止損 <1% 的單屬於：${Array.from(group(ts.filter(x => x.stopPct < 0.01), x => `${x.r.strategy ?? 'A'}/${x.r.direction}/${x.r.timeframe}`).entries()).map(([k, v]) => `${k}×${v.length}`).join('  ')}`);
  console.log(`  live_auto_sync：${ts.filter(x => x.r.close_reason === 'live_auto_sync').map(x => `${x.f.symbol.replace('USDT', '')} ${f(x.R, 2)} ${new Date(Number(x.r.closed_at)).toISOString().slice(0, 10)}`).join('、')}`);

  // ── 回吐：曾經浮盈多少、最後拿到多少 ──
  const withMfe = ts.filter(x => x.mfeR != null);
  console.log(`\n── 回吐分析（有 MFE 紀錄 ${withMfe.length} 筆）`);
  for (const [lo, hi] of [[-Infinity, 0.5], [0.5, 1], [1, 2], [2, Infinity]] as const) {
    const g = withMfe.filter(x => x.mfeR! >= lo && x.mfeR! < hi);
    if (!g.length) continue;
    console.log(`  最高浮盈 ${lo === -Infinity ? '<' : lo + '–'}${hi === Infinity ? '以上' : hi}R`.padEnd(24)
      + ` n=${String(g.length).padStart(3)}  平均最高 ${f(mean(g.map(x => x.mfeR!)), 2)}R → 實拿 ${f(mean(g.map(x => x.R)), 2)}R`);
  }
  const stops = ts.filter(x => x.R < -0.9);
  console.log(`\n── 止損執行：${stops.length} 筆虧到 ≥0.9R，平均 ${f(mean(stops.map(x => x.R)), 3)}R（理論 −1.000R；差距 = 止損滑價）`);
  const worse = stops.filter(x => x.R < -1.1);
  console.log(`  其中 ${worse.length} 筆虧超過 1.1R：${worse.map(x => `${x.f.symbol.replace('USDT', '')} ${f(x.R, 2)}`).join('、') || '無'}`);

  // ── 成本 ──
  const feeR = ts.map(x => x.R - x.netR);
  console.log(`\n── 成本：止損距離中位數 ${(100 * ts.map(x => x.stopPct).sort((a, b) => a - b)[Math.floor(ts.length / 2)]).toFixed(2)}%，手續費每筆約 ${f(-mean(feeR))}R，合計 ${f(-feeR.reduce((a, b) => a + b, 0), 1)}R`);
}

main().catch(e => { console.error('real-trades-breakdown error:', e); process.exit(1); });
