// 紙上策略（策略 A／影片 A/B/C）的統計與近期紀錄——給 App 的 /paper 頁面用，唯讀。
// 驗證：已登入的 App 使用者（帶 Supabase JWT），跟 /api/reject-funnel 同一種模式；資料是全站共用的
// 策略紀錄，不含個資。
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Redis } from '@upstash/redis';
import { PAPER_STRATS, summarizePaper, type PaperRecord } from '@/lib/paper/stats';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

async function checkUserSession(req: NextRequest): Promise<boolean> {
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return false;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !key) return false;
  const c = createClient(url, key, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { autoRefreshToken: false, persistSession: false } });
  const { data: { user }, error } = await c.auth.getUser();
  return !error && !!user;
}

const parse = (v: unknown): PaperRecord => (typeof v === 'string' ? JSON.parse(v) : v) as PaperRecord;
/** 列表只顯示真的有發生的單：未成交／因已有持倉略過的只計數，不列出 */
const LISTED = new Set(['pending', 'open', 'done', 'skip']);
const RECENT = 40;

export async function GET(req: NextRequest) {
  if (!(await checkUserSession(req))) return NextResponse.json({ ok: false, reason: '尚未登入' }, { status: 401 });
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return NextResponse.json({ ok: false, reason: 'Redis 未設定' }, { status: 500 });
  const r = new Redis({ url, token });
  const now = Date.now();
  const meta = ((await r.hgetall<Record<string, unknown>>('paper:meta')) ?? {}) as Record<string, unknown>;
  const startA = Number(meta['trackStart.strategyA']) || null;
  const startV = Number(meta['trackStart.video']) || null;

  const strategies = await Promise.all(PAPER_STRATS.map(async key => {
    const [open, done] = await Promise.all([r.hgetall(`paper:${key}:open`), r.hgetall(`paper:${key}:done`)]);
    const records = [...Object.values(open ?? {}), ...Object.values(done ?? {})].map(parse);
    const start = (key === 'strategyA' ? startA : startV) ?? now;
    const t = (x: PaperRecord) => Number(x.signalT ?? x.startT ?? 0);
    const recent = records.filter(x => LISTED.has(x.status)).sort((a, b) => t(b) - t(a)).slice(0, RECENT);
    return { summary: summarizePaper(key, records, start, now), recent };
  }));

  return NextResponse.json({
    ok: true,
    trackStart: { strategyA: startA, video: startV },
    lastRunDay: { strategyA: Number(meta['strategyA.lastRunDay']) || null, video: Number(meta['video.lastRunDay']) || null },
    strategies,
  });
}
