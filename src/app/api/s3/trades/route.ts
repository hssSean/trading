// 紀錄頁用：S3-A 真倉的持倉與已平倉交易（含事件、滑價、手續費、資金費）。唯讀。
import { NextRequest, NextResponse } from 'next/server';
import { checkUserSession, getRedisOrNull, parseJson } from '@/lib/apiAuth';
import type { LivePos } from '@/engine/s3aLive';
import { summarizeLive, type LiveDone } from '@/lib/s3s1/stats';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

export async function GET(req: NextRequest) {
  if (!(await checkUserSession(req))) return NextResponse.json({ ok: false, reason: '尚未登入' }, { status: 401 });
  const r = getRedisOrNull();
  if (!r) return NextResponse.json({ ok: false, reason: 'Redis 未設定' }, { status: 500 });
  try {
    const [meta, pos, done] = await Promise.all([
      r.hgetall<Record<string, unknown>>('s3a-live:meta'),
      r.hgetall<Record<string, unknown>>('s3a-live:pos'),
      r.hgetall<Record<string, unknown>>('s3a-live:done'),
    ]);
    const closed = Object.values(done ?? {}).map(v => parseJson<LivePos & LiveDone>(v)).sort((a, b) => b.exitAt - a.exitAt);
    return NextResponse.json({
      ok: true,
      summary: summarizeLive(meta ?? {}, closed),
      open: Object.values(pos ?? {}).map(v => parseJson<LivePos>(v)).sort((a, b) => b.entryAt - a.entryAt),
      done: closed,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: `讀取 Redis 失敗：${String(e).slice(0, 120)}` }, { status: 500 });
  }
}
