import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 10;

// Same auth contract as /api/trade-status.
function checkAuth(req: NextRequest): boolean {
  const envSecret = process.env.WEBHOOK_SECRET;
  if (!envSecret) return process.env.VERCEL_ENV !== 'production';
  const provided = req.headers.get('x-webhook-secret') ?? req.nextUrl.searchParams.get('secret');
  return provided === envSecret;
}

// POST { userId: string }
//
// Returns every trade row for this user, straight from Postgres via the service
// role key. Exists so the exported CSV report can be trusted as complete: some
// columns (regime/confidence/funding_rate/suggested_risk_pct/suggested_leverage/
// close_reason) may or may not be readable through the client's own authenticated-
// role query — /api/trade-status already found this true for status/signal_price
// (column-level grants that don't cover every column). Rather than re-litigate
// that per new column, every export goes through the service role, same as that
// endpoint, so completeness never depends on it.
//
// Also sidesteps the 500-row local cache cap (useStore's persist partialize) —
// this reads the full history directly from Supabase, not from Zustand state.
export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let userId = '';
  try {
    const body = await req.json() as { userId?: unknown };
    userId = typeof body.userId === 'string' ? body.userId : '';
  } catch {
    return NextResponse.json({ trades: [] });
  }
  if (!userId) return NextResponse.json({ trades: [] });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) return NextResponse.json({ trades: [] });

  try {
    const { createClient } = await import('@supabase/supabase-js');
    const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data, error } = await admin
      .from('trades')
      .select('*')
      .eq('user_id', userId)
      .order('opened_at', { ascending: false });

    if (error) {
      console.error('[trade-export] query failed:', error.code, error.message);
      return NextResponse.json({ trades: [] });
    }
    return NextResponse.json({ trades: data ?? [] });
  } catch (e) {
    console.error('[trade-export] threw:', String(e).slice(0, 200));
    return NextResponse.json({ trades: [] });
  }
}
