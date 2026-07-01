import { NextRequest, NextResponse } from 'next/server';
import { sendLineMessage } from '@/lib/line';

// POST /api/test-line  { channelToken, userId }
export async function POST(req: NextRequest) {
  try {
    const { channelToken, userId } = await req.json();

    if (!channelToken?.trim() || !userId?.trim()) {
      return NextResponse.json({ ok: false, error: '請填寫 Channel Token 和 User ID' }, { status: 400 });
    }

    const { ok, error } = await sendLineMessage(channelToken.trim(), userId.trim(), [
      {
        type: 'text',
        text: '✅ Crypto Trader 連線成功！\n交易信號將自動發送到此對話 📊\n\n— LINE Messaging API',
      },
    ]);

    if (ok) return NextResponse.json({ ok: true });
    return NextResponse.json({ ok: false, error: error ?? '發送失敗' }, { status: 400 });
  } catch {
    return NextResponse.json({ ok: false, error: '伺服器錯誤，請稍後再試' }, { status: 500 });
  }
}
