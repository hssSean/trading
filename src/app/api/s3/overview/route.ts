// 首頁用：S3-A 真倉的狀態、持倉、今天的市場條件與決策、live-runner 心跳。唯讀。
import { NextRequest, NextResponse } from 'next/server';
import { checkUserSession, getRedisOrNull, parseJson } from '@/lib/apiAuth';
import type { LivePos, LiveSignal } from '@/engine/s3aLive';
import type { PrepSnapshot } from '@/lib/s3s1/engine';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

export async function GET(req: NextRequest) {
  const uid = await checkUserSession(req);
  if (!uid) return NextResponse.json({ ok: false, reason: '尚未登入' }, { status: 401 });
  const r = getRedisOrNull();
  if (!r) return NextResponse.json({ ok: false, reason: 'Redis 未設定' }, { status: 500 });
  const now = Date.now();
  const X = Math.floor(now / 86_400_000) * 86_400_000;
  // 真倉帳戶只有一個（TRADING_USER_ID）；Vercel 沒設時用登入者——這個 App 只有一位使用者
  const runner = process.env.TRADING_USER_ID || uid;
  try {
    const [meta, pos, snapRaw, hb, sig] = await Promise.all([
      r.hgetall<Record<string, unknown>>('s3a-live:meta'),
      r.hgetall<Record<string, unknown>>('s3a-live:pos'),
      r.get(`s3s1:prep:${X}`),
      r.get<number>(`live-runner:heartbeat:${runner}`),
      r.lrange('s3a-live:signals', 0, 49),
    ]);
    const snap = snapRaw ? parseJson<PrepSnapshot>(snapRaw) : null;
    return NextResponse.json({
      ok: true, now,
      meta: meta ?? {},
      positions: Object.values(pos ?? {}).map(v => parseJson<LivePos>(v)).sort((a, b) => b.entryAt - a.entryAt),
      snapshot: snap ? { X: snap.X, breadth: snap.breadth, btcOk: snap.btcOk, s3: snap.s3.map(c => ({ symbol: c.symbol })) } : null,
      heartbeatAt: hb ? Number(hb) : null,
      signals: (sig ?? []).map(v => parseJson<LiveSignal>(v)),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: `讀取 Redis 失敗：${String(e).slice(0, 120)}` }, { status: 500 });
  }
}
