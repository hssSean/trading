import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 10;

function checkAuth(req: NextRequest): boolean {
  const envSecret = process.env.WEBHOOK_SECRET;
  const provided = req.headers.get('x-webhook-secret') ?? req.nextUrl.searchParams.get('secret');
  if (envSecret && provided !== envSecret) return false;
  return true;
}

// POST { ids: string[] }
// Returns actual status and signal_price from Supabase using service role key,
// bypassing the column-level grant restrictions that block the client (authenticated role).
export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let ids: string[] = [];
  try {
    const body = await req.json() as { ids?: unknown };
    ids = Array.isArray(body.ids) ? (body.ids as string[]).slice(0, 100) : [];
  } catch {
    return NextResponse.json({ statuses: {} });
  }

  if (ids.length === 0) return NextResponse.json({ statuses: {} });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) return NextResponse.json({ statuses: {} });

  try {
    const { createClient } = await import('@supabase/supabase-js');
    const admin = createClient(url, key);
    // current_stop = live trailing stop (only meaningful after TP1). Selected via
    // service role since the authenticated role can't read it. Falls back if the
    // column isn't migrated (42703) so status/signal_price still return.
    let data: Record<string, unknown>[] | null = null;
    const full = await admin.from('trades').select('id, status, signal_price, current_stop').in('id', ids);
    if (full.error) {
      const base = await admin.from('trades').select('id, status, signal_price').in('id', ids);
      data = (base.data as Record<string, unknown>[]) ?? null;
    } else {
      data = (full.data as Record<string, unknown>[]) ?? null;
    }

    const statuses: Record<string, { status: string | null; signalPrice: number | null; currentStop: number | null }> = {};
    if (data) {
      data.forEach(r => {
        statuses[r.id as string] = {
          status: (r.status as string | null) ?? null,
          signalPrice: (r.signal_price as number | null) ?? null,
          currentStop: (r.current_stop as number | null) ?? null,
        };
      });
    }
    return NextResponse.json({ statuses });
  } catch {
    return NextResponse.json({ statuses: {} });
  }
}
