import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { analyzeScoreAttribution, AttributionTrade } from '@/lib/scoreAttribution';

export const dynamic = 'force-dynamic';

// 使用者自己的策略歸因分析——只回答「score_breakdown 的哪一組因子跟結果
// 有沒有真的相關」，不是全站共用資料（跟 reject-funnel 不同），一定要
// 知道是誰登入的才能只查這個使用者的 trades，checkAuth 因此要回傳
// user.id，不只是 boolean。同一套 Supabase JWT 驗證方式，跟
// /api/reject-funnel 的 checkUserSession 一致。
async function resolveUserId(req: NextRequest): Promise<string | null> {
  const authHeader = req.headers.get('authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return null;

  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!anonUrl || !anonKey) return null;

  const userClient = createClient(anonUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) return null;
  return user.id;
}

interface TradeRow {
  direction: 'LONG' | 'SHORT';
  result: string | null;
  pnl_percent: number | null;
  entry: number;
  stop_loss: number;
  score_breakdown: AttributionTrade['scoreBreakdown'] | null;
}

export async function GET(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!sbUrl || !sbKey) return NextResponse.json({ ok: false, reason: 'supabase-not-configured' });

  try {
    const admin = createClient(sbUrl, sbKey, { auth: { autoRefreshToken: false, persistSession: false } });
    // 用 service role 查——跟 /api/trade-export 同一個理由：某些欄位
    // （score_breakdown）在 authenticated role 底下能不能讀回來沒把握，
    // 完整性不該取決於 client 端角色的欄位授權範圍。只查真的有結果的
    // （closed_at 不為 null）——還開著的部位沒有 R 可算。
    const { data, error } = await admin
      .from('trades')
      .select('direction, result, pnl_percent, entry, stop_loss, score_breakdown')
      .eq('user_id', userId)
      .not('closed_at', 'is', null);

    if (error) {
      return NextResponse.json({ ok: false, reason: `${error.code}: ${error.message}`.slice(0, 200) });
    }

    const trades: AttributionTrade[] = (data as TradeRow[]).map(r => ({
      direction: r.direction,
      result: r.result,
      pnlPercent: r.pnl_percent,
      entry: r.entry,
      stopLoss: r.stop_loss,
      scoreBreakdown: r.score_breakdown,
    }));

    const result = analyzeScoreAttribution(trades);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e).slice(0, 120) });
  }
}
