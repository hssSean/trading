// 訊號頁用：S3-A 真倉（s3a-live:signals）與三個帳本（s3s1:signals）的訊號紀錄，含被擋掉的。唯讀。
import { NextRequest, NextResponse } from 'next/server';
import { checkUserSession, getRedisOrNull, parseJson } from '@/lib/apiAuth';
import type { LiveSignal } from '@/engine/s3aLive';
import type { SignalLog } from '@/lib/s3s1/engine';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;
const N = 300;

export async function GET(req: NextRequest) {
  if (!(await checkUserSession(req))) return NextResponse.json({ ok: false, reason: '尚未登入' }, { status: 401 });
  const r = getRedisOrNull();
  if (!r) return NextResponse.json({ ok: false, reason: 'Redis 未設定' }, { status: 500 });
  try {
    const [live, ledger] = await Promise.all([r.lrange('s3a-live:signals', 0, N - 1), r.lrange('s3s1:signals', 0, N - 1)]);
    return NextResponse.json({
      ok: true,
      live: (live ?? []).map(v => parseJson<LiveSignal>(v)),
      ledger: (ledger ?? []).map(v => parseJson<SignalLog>(v)),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: `讀取 Redis 失敗：${String(e).slice(0, 120)}` }, { status: 500 });
  }
}
