import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { fetchCandles, fetchTicker24h, fetchTopCoinsByVolume } from '@/api/binance';
import { computeIndicators } from '@/analysis/indicators';
import { generateSignals, unifySignalDirection } from '@/analysis/signals';
import { Candle, Timeframe, TradingSignal } from '@/types';
import { sendLineMessage, buildLineFlexMessage } from '@/lib/line';
import { sendWebPushToUser } from '@/lib/webpush';

export const maxDuration = 60;

const HTF_MAP: Partial<Record<Timeframe, Timeframe>> = {
  '5m': '15m', '15m': '1h', '1h': '4h', '4h': '1d',
};

// ── Persistent lock via Upstash Redis ─────────────────────────
// Survives Vercel cold starts (unlike module-level Maps).
// Falls back to in-memory when env vars aren't set.
interface LockEntry {
  sentAt:       number;
  candleBucket: number;
  direction:    string;
  locked:       boolean; // true = active trade in journal
}
const LOCK_TTL_SEC     = 24 * 3600;        // 24h lock for intraday trades
const COOLDOWN_MS      = 2 * 60 * 60 * 1000; // 2h cooldown between signals (was 6h)
const STRONG_THRESHOLD = 15;                  // lowered from 19 (intraday scoring range)
const INTRADAY_CLOSE_HOURS = 24;             // auto-close active trades older than 24h
const WAITING_EXPIRY_HOURS = 8;              // cancel unfilled limit orders after 8h

let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (_redis) return _redis;
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    _redis = Redis.fromEnv();
    return _redis;
  }
  return null;
}

// In-memory fallback (lost on cold start, but works when Redis isn't wired)
const memLock = new Map<string, LockEntry>();

async function getLock(symbol: string): Promise<LockEntry | null> {
  const r = getRedis();
  if (r) {
    try { return await r.get<LockEntry>(`tlock:${symbol}`); } catch { /* fall through */ }
  }
  return memLock.get(symbol) ?? null;
}

async function setLock(symbol: string, entry: LockEntry): Promise<void> {
  const r = getRedis();
  if (r) {
    try { await r.set(`tlock:${symbol}`, entry, { ex: LOCK_TTL_SEC }); return; } catch { /* fall through */ }
  }
  memLock.set(symbol, entry);
}

async function unlockSymbol(symbol: string): Promise<void> {
  const r = getRedis();
  if (r) {
    try {
      const entry = await r.get<LockEntry>(`tlock:${symbol}`);
      if (entry) await r.set(`tlock:${symbol}`, { ...entry, locked: false, sentAt: 0 }, { ex: LOCK_TTL_SEC });
      return;
    } catch { /* fall through */ }
  }
  const entry = memLock.get(symbol);
  if (entry) memLock.set(symbol, { ...entry, locked: false, sentAt: 0 });
}

// ── Pending signals for client auto-journal pickup ────────────
// Best-effort in-memory; client also picks up via client-side 30s detect.
const pendingSignals: TradingSignal[] = [];

// ── Dynamic coin list (1h cache) ──────────────────────────────
const FALLBACK_COINS = [
  'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT',
  'DOGEUSDT','ADAUSDT','AVAXUSDT','DOTUSDT','LINKUSDT',
  'LTCUSDT','UNIUSDT','ATOMUSDT','NEARUSDT','MATICUSDT',
];
let cachedCoins: string[] = [];
let cachedAt              = 0;
const COINS_TTL           = 60 * 60 * 1000;

async function getDefaultCoins(): Promise<string[]> {
  if (Date.now() - cachedAt < COINS_TTL && cachedCoins.length > 0) return cachedCoins;
  try {
    cachedCoins = await fetchTopCoinsByVolume(15);
    cachedAt    = Date.now();
    return cachedCoins;
  } catch {
    return FALLBACK_COINS;
  }
}

function current4hBucket(): number {
  return Math.floor(Date.now() / (4 * 60 * 60 * 1000)) * (4 * 60 * 60 * 1000);
}

function fmtPrice(p: number): string {
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1)    return p.toFixed(4);
  return p.toFixed(6);
}

function checkAuth(req: NextRequest): boolean {
  const envSecret  = process.env.WEBHOOK_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  const cronAuth   = req.headers.get('authorization');
  // Vercel cron — must have CRON_SECRET set
  const isVercelCron = !!(cronSecret && cronAuth === `Bearer ${cronSecret}`);
  if (isVercelCron) return true;
  // Accept secret from header (preferred) or legacy query param
  const provided = req.headers.get('x-webhook-secret') ?? req.nextUrl.searchParams.get('secret');
  if (envSecret && provided !== envSecret) return false;
  return true;
}

// ── Server-side monitor: fill detection + TP/SL via K-line scan ──
// Uses 1h candlestick high/low so events between cron runs are never missed.
async function monitorActiveTrades(lineToken: string, lineUserId: string, profileId: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL  || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return { monitored: 0, closed: 0, filled: 0, cancelled: 0 };

  // Distributed mutex: prevents overlapping runs when cron fires concurrently.
  // TTL=55s expires safely before the next 1-minute cron tick; explicit del
  // at the end releases it early so a fast run doesn't block the next cycle.
  const rLock = getRedis();
  if (rLock) {
    try {
      const acquired = await rLock.set('monitor-run-lock', 1, { nx: true, ex: 55 });
      if (!acquired) return { monitored: 0, closed: 0, filled: 0, cancelled: 0 };
    } catch { /* Redis unavailable — proceed without lock */ }
  }

  const { createClient } = await import('@supabase/supabase-js');
  const admin = createClient(url, key);

  // ── Fetch waiting and active trades separately ────────────────
  // No user_id filter: admin (service role) has full table access and should
  // process all open trades.  LINE notifications are already scoped to
  // lineUserId / lineToken so they reach the correct recipient.
  const baseQ = () =>
    admin.from('trades').select('*').is('result', null);

  const [
    { data: waitingRaw, error: waitErr },
    { data: activeRaw,  error: activeErr },
  ] = await Promise.all([
    baseQ().eq('status', 'waiting'),
    // active, tp1_hit, or legacy rows (null status from before migration)
    baseQ().or('status.eq.active,status.is.null,status.eq.tp1_hit'),
  ]);

  if (waitErr)  console.error('[monitor] waiting query error:', waitErr.message);
  if (activeErr) console.error('[monitor] active query error:',  activeErr.message);

  const waiting = (waitingRaw ?? []) as any[];
  const active  = (activeRaw  ?? []) as any[];

  if (waiting.length === 0 && active.length === 0) {
    return { monitored: 0, closed: 0, filled: 0, cancelled: 0 };
  }

  // Warn when the same symbol has multiple open trades — indicates prior inconsistency
  // (e.g. client-created + server-created, or signal fired twice during key-missing window).
  // Each trade is still processed independently; the real fix is per-event idempotency below.
  const symbolCounts = new Map<string, number>();
  [...waiting, ...active].forEach(t => {
    const s = t.symbol as string;
    symbolCounts.set(s, (symbolCounts.get(s) ?? 0) + 1);
  });
  symbolCounts.forEach((cnt, sym) => {
    if (cnt > 1) console.error(`[monitor] ${sym} has ${cnt} open trades — duplicate may cause spurious notifications`);
  });

  const now = Date.now();
  let filled = 0, cancelled = 0, closed = 0;

  // Update last_monitored_at after each check so the next run only fetches new candles.
  // 42703 = column not yet migrated → skip silently (non-critical optimisation).
  async function touchMonitoredAt(id: string) {
    const r = await admin.from('trades').update({ last_monitored_at: now }).eq('id', id);
    if (r.error && r.error.code !== '42703') { /* non-critical */ }
  }

  // ── Phase 1: fill detection for waiting (limit) orders ───────
  for (const trade of waiting) {
    // Retreat one candle-width (1h) so the candle that was already open at order-placement time
    // is always included — the Binance startTime filter uses openTime, which can be earlier than
    // the exact placement timestamp.
    const rawStart1 = (trade.last_monitored_at ?? trade.opened_at ?? (now - WAITING_EXPIRY_HOURS * 3_600_000)) as number;
    const startMs   = rawStart1 - 3_600_000;

    let candles: Candle[] = [];
    try {
      // limit=168 covers up to 7 days of 1h bars (safety net for first run before last_monitored_at is set)
      candles = await fetchCandles(trade.symbol as string, '1h', 168, 3, startMs);
    } catch {
      await delay(200);
      continue;
    }
    await delay(200); // stagger per-trade fetches to avoid Binance 429

    const isLong = trade.direction === 'LONG';
    const sp     = (trade.signal_price ?? 0) as number;
    const entry  = trade.entry as number;

    // Fill: any 1h candle's low (LONG) / high (SHORT) touched entry ±0.1%
    const fillCandle = candles.find(c =>
      isLong
        ? c.low  <= entry * 1.001 && (sp === 0 || sp > entry * 1.002)
        : c.high >= entry * 0.999 && (sp === 0 || sp < entry * 0.998)
    );
    const isFilled = !!fillCandle;

    // Cancel: expired, OR any candle shows TP1 reached without price pulling back to entry
    const isExpired = (now - ((trade.opened_at ?? 0) as number)) > WAITING_EXPIRY_HOURS * 3_600_000;
    const tpAlreadyPassed = !isFilled && candles.some(c =>
      isLong ? c.high >= (trade.tp1 as number) : c.low <= (trade.tp1 as number)
    );
    const isCancelled = !isFilled && (isExpired || tpAlreadyPassed);

    if (isFilled) {
      const filledAt = fillCandle!.closeTime ?? now;
      const fillRes  = await admin.from('trades')
        .update({ status: 'active', filled_at: filledAt, last_monitored_at: now })
        .eq('id', trade.id);

      let fillWriteOk = !fillRes.error;
      if (fillRes.error) {
        if (fillRes.error.code === '42703') {
          const fb = await admin.from('trades').update({ status: 'active', opened_at: filledAt }).eq('id', trade.id);
          if (fb.error) {
            console.error(`[monitor] fill write failed ${trade.id}: [${fb.error.code}] ${fb.error.message}`);
            await touchMonitoredAt(trade.id as string);
          } else {
            fillWriteOk = true;
          }
        } else {
          console.error(`[monitor] fill write failed ${trade.id}: [${fillRes.error.code}] ${fillRes.error.message}`);
          await touchMonitoredAt(trade.id as string);
        }
      }

      // Notify only after DB confirms status='active' — prevents repeat on next cron if write failed
      if (fillWriteOk) {
        filled++;
        const dir = isLong ? '▲ 做多' : '▼ 做空';
        const sym = (trade.symbol as string).replace('USDT', '/USDT');
        const fillMsg =
          `【✅ 掛單成交】${sym}\n` +
          `${dir} 進場已確認，已自動加入交易日誌\n` +
          `成交價：$${fmtPrice(fillCandle!.close)}\n` +
          `TP1：$${fmtPrice(trade.tp1 as number)} ｜ SL：$${fmtPrice(trade.stop_loss as number)}`;
        if (lineToken && lineUserId) {
          await sendLineWithRetry(lineToken, lineUserId, [{ type: 'text', text: fillMsg }]);
        }
        if (profileId) {
          await sendWebPushToUser(profileId, {
            title: `✅ 掛單成交 ${sym}`,
            body: `${dir} 成交價 $${fmtPrice(fillCandle!.close)} ｜ TP1 $${fmtPrice(trade.tp1 as number)} ｜ SL $${fmtPrice(trade.stop_loss as number)}`,
            tag: `fill-${trade.id}`,
          });
        }
      }
    } else if (isCancelled) {
      const delRes = await admin.from('trades').delete().eq('id', trade.id);
      if (delRes.error) {
        // Delete failed — don't notify; next cron will retry the delete
        console.error(`[monitor] cancel delete failed ${trade.id}: [${delRes.error.code}] ${delRes.error.message}`);
        await touchMonitoredAt(trade.id as string);
      } else {
        await unlockSymbol(trade.symbol as string);
        cancelled++;
        // Notify only after row is confirmed gone — prevents repeat if delete had failed
        {
          const dir = isLong ? '▲ 做多' : '▼ 做空';
          const sym = (trade.symbol as string).replace('USDT', '/USDT');
          const reason = isExpired
            ? `掛單逾期 ${WAITING_EXPIRY_HOURS} 小時未成交，已自動取消`
            : `價格未回測至進場位 $${fmtPrice(entry)}，直接到達 TP1 $${fmtPrice(trade.tp1 as number)}，掛單已自動取消`;
          const cancelMsg = `【⚠️ 掛單取消】${sym}\n${dir} ${reason}`;
          if (lineToken && lineUserId) {
            await sendLineWithRetry(lineToken, lineUserId, [{ type: 'text', text: cancelMsg }]);
          }
          if (profileId) {
            await sendWebPushToUser(profileId, {
              title: `⚠️ 掛單取消 ${sym}`,
              body: `${dir} ${isExpired ? `逾期 ${WAITING_EXPIRY_HOURS}h 未成交` : 'TP1 直接到達，跳過進場'}`,
              tag: `cancel-${trade.id}`,
            });
          }
        }
      }
    } else {
      // No state change — record we've checked up to now so next run fetches only new candles
      await touchMonitoredAt(trade.id as string);
    }
  }

  // ── Phase 2: TP/SL monitoring + timeframe-aware auto-close ───
  for (const trade of active) {
    // Retreat one 1h candle-width so the candle open at fill/creation time is always covered.
    const rawStart2 = (trade.last_monitored_at ?? trade.filled_at ?? trade.opened_at ?? (now - 168 * 3_600_000)) as number;
    const startMs   = rawStart2 - 3_600_000;

    let candles: Candle[] = [];
    try {
      candles = await fetchCandles(trade.symbol as string, '1h', 168, 3, startMs);
    } catch {
      await delay(200);
      continue;
    }
    await delay(200);

    const isLong   = trade.direction === 'LONG';
    const isTp1Hit = trade.status === 'tp1_hit';

    let closeResult: string | null = null;
    let closePrice  = 0;
    let justHitTp1  = false;
    // localTp1Hit tracks TP1 across this scan (DB state + any new hit found in candles)
    let localTp1Hit = isTp1Hit;

    // Scan candles in chronological order.
    // Same-candle conflict (SL + TP in one candle): SL wins — conservative, protects capital.
    for (const c of candles) {
      if (isLong) {
        if (c.low <= (trade.stop_loss as number)) {
          closeResult = localTp1Hit ? 'WIN_TP1' : 'LOSS';
          closePrice  = trade.stop_loss as number;
          break;
        }
        if (c.high >= (trade.tp2 as number)) {
          closeResult = 'WIN_TP2'; closePrice = trade.tp2 as number; break;
        }
        if (!localTp1Hit && c.high >= (trade.tp1 as number)) {
          localTp1Hit = true; justHitTp1 = true; // keep scanning — later candles may still hit SL/TP2
        }
      } else {
        if (c.high >= (trade.stop_loss as number)) {
          closeResult = localTp1Hit ? 'WIN_TP1' : 'LOSS';
          closePrice  = trade.stop_loss as number;
          break;
        }
        if (c.low <= (trade.tp2 as number)) {
          closeResult = 'WIN_TP2'; closePrice = trade.tp2 as number; break;
        }
        if (!localTp1Hit && c.low <= (trade.tp1 as number)) {
          localTp1Hit = true; justHitTp1 = true;
        }
      }
    }

    // TP1 newly reached in this scan, no close yet → mark and notify
    if (justHitTp1 && !closeResult) {
      const tp1Res = await admin.from('trades')
        .update({ status: 'tp1_hit', last_monitored_at: now })
        .eq('id', trade.id);

      let tp1WriteOk = !tp1Res.error;
      if (tp1Res.error) {
        if (tp1Res.error.code === '42703') {
          const fb = await admin.from('trades').update({ status: 'tp1_hit' }).eq('id', trade.id);
          if (fb.error) {
            console.error(`[monitor] tp1_hit write failed ${trade.id}: [${fb.error.code}] ${fb.error.message}`);
          } else {
            tp1WriteOk = true;
          }
        } else {
          console.error(`[monitor] tp1_hit write failed ${trade.id}: [${tp1Res.error.code}] ${tp1Res.error.message}`);
        }
      }

      // Notify only after status='tp1_hit' is persisted — next cron sees isTp1Hit=true,
      // skips the justHitTp1 branch, preventing repeat notification.
      // If write failed, no LINE is sent; next cron retries the write.
      if (tp1WriteOk) {
        const dir = isLong ? '▲ 做多' : '▼ 做空';
        const sym = (trade.symbol as string).replace('USDT', '/USDT');
        const tp1Msg =
          `【🎯 TP1 達標】${sym}\n` +
          `${dir} TP1 $${fmtPrice(trade.tp1 as number)} 已達標，繼續持有等待 TP2 $${fmtPrice(trade.tp2 as number)}\n` +
          `💡 建議立刻將止損移至成本 $${fmtPrice(trade.entry as number)}`;
        if (lineToken && lineUserId) {
          await sendLineWithRetry(lineToken, lineUserId, [{ type: 'text', text: tp1Msg }]);
        }
        if (profileId) {
          await sendWebPushToUser(profileId, {
            title: `🎯 TP1 達標 ${sym}`,
            body: `${dir} $${fmtPrice(trade.tp1 as number)} ｜ 止損移至 $${fmtPrice(trade.entry as number)}`,
            tag: `tp1-${trade.id}`,
          });
        }
      }
      continue;
    }

    // Timeframe-aware auto-close: use last candle close as exit price (no spot fetch needed)
    const autoCloseHours = trade.timeframe === '4h' ? 72 : trade.timeframe === '1d' ? 168 : INTRADAY_CLOSE_HOURS;
    const ageHours       = (now - ((trade.filled_at ?? trade.opened_at ?? 0) as number)) / 3_600_000;
    const lastClose      = candles.length > 0 ? candles[candles.length - 1].close : null;

    if (!closeResult && ageHours >= autoCloseHours && lastClose !== null) {
      closeResult = localTp1Hit ? 'WIN_TP1' : 'MANUAL_CLOSE';
      closePrice  = lastClose;
    }

    if (!closeResult) {
      await touchMonitoredAt(trade.id as string);
      continue;
    }

    const entry = trade.entry as number;
    const pnl   = isLong
      ? ((closePrice - entry) / entry) * 100
      : ((entry - closePrice) / entry) * 100;

    const closeRes = await admin.from('trades').update({
      result:      closeResult,
      exit_price:  closePrice,
      closed_at:   now,
      pnl_percent: parseFloat(pnl.toFixed(2)),
    }).eq('id', trade.id);

    if (closeRes.error) {
      if (closeRes.error.code === '42703') {
        // exit_price / pnl_percent column missing — write result + closed_at only
        const fallback = await admin.from('trades')
          .update({ result: closeResult, closed_at: now })
          .eq('id', trade.id);
        if (fallback.error) {
          console.error(`[monitor] close fallback failed ${trade.id}: ${fallback.error.message}`);
          await touchMonitoredAt(trade.id as string);
          continue;
        }
      } else {
        console.error(`[monitor] close failed ${trade.id}: ${closeRes.error.message}`);
        await touchMonitoredAt(trade.id as string);
        continue;
      }
    }

    await unlockSymbol(trade.symbol as string);

    {
      const dir = isLong ? '▲ 做多' : '▼ 做空';
      const sym = (trade.symbol as string).replace('USDT', '/USDT');
      const pnlStr = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`;
      let closeMsg: string;
      let pushTitle: string;
      if (closeResult === 'MANUAL_CLOSE') {
        closeMsg   = `【⏱ 到期平倉】${sym}\n${dir} 超過 ${autoCloseHours}小時未達標，自動平倉\n出場價：$${fmtPrice(closePrice)}\n損益：${pnlStr}`;
        pushTitle  = `⏱ 到期平倉 ${sym}`;
      } else {
        const label = closeResult === 'WIN_TP2' ? '✅ TP2 全部達標'
                    : closeResult === 'WIN_TP1' ? (localTp1Hit ? '🔒 SL 出場（TP1 已達標）' : '✅ TP1 達標')
                    : '❌ 止損出場';
        closeMsg  = `【平倉通知】${sym}\n${dir} ${label}\n出場價：$${fmtPrice(closePrice)}\n損益：${pnlStr}`;
        pushTitle = `${label} ${sym}`;
      }
      if (lineToken && lineUserId) {
        await sendLineWithRetry(lineToken, lineUserId, [{ type: 'text', text: closeMsg }]);
      }
      if (profileId) {
        await sendWebPushToUser(profileId, {
          title: pushTitle,
          body: `${dir} 出場 $${fmtPrice(closePrice)} ｜ ${pnlStr}`,
          tag: `close-${trade.id}`,
        });
      }
    }
    closed++;
  }

  if (rLock) { try { await rLock.del('monitor-run-lock'); } catch { /* best-effort */ } }
  return { monitored: active.length + waiting.length, closed, filled, cancelled };
}

// ── GET — run analysis + send LINE ────────────────────────────
export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const coinsParam = req.nextUrl.searchParams.get('coins') ?? process.env.WATCH_COINS ?? '';
  const tfParam    = process.env.ANALYSIS_TIMEFRAMES ?? '5m,15m,1h';
  const lineUserId = process.env.LINE_USER_ID ?? '';
  const minScore   = parseInt(process.env.MIN_SCORE ?? '5', 10);

  // ── Resolve LINE token: profile (user-managed) > env fallback ──────────────
  // profiles.line_token is updated whenever the user saves settings in the app,
  // so it stays fresh. LINE_CHANNEL_TOKEN env var expires every 30 days and
  // requires manual renewal in Vercel — reading from the profile avoids that.
  let lineToken = process.env.LINE_CHANNEL_TOKEN ?? '';
  // Resolved Supabase profile UUID — used for Web Push subscription lookup
  let profileId = '';
  {
    const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL  || '';
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (lineUserId && sbUrl && sbKey) {
      try {
        const { createClient: mkLineAdmin } = await import('@supabase/supabase-js');
        const lineAdmin = mkLineAdmin(sbUrl, sbKey);
        const { data: lp } = await lineAdmin
          .from('profiles').select('id, line_token')
          .eq('line_user_id', lineUserId).maybeSingle();
        if (lp?.line_token) lineToken = lp.line_token;
        if (lp?.id) profileId = lp.id;
      } catch { /* keep env fallback */ }
    }
  }

  const coins: string[] = coinsParam
    ? coinsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    : await getDefaultCoins();

  const timeframes = tfParam.split(',').map(s => s.trim()) as Timeframe[];
  // Entry timeframe: multi-TF analysis confirms direction; only this TF produces the entry/TP/SL.
  // Override via ENTRY_TIMEFRAME env var; default 1h (the faster TF in a 4h+1h setup).
  const entryTf    = (process.env.ENTRY_TIMEFRAME ?? '1h').trim() as Timeframe;
  const lineReady  = !!(lineToken && lineUserId);
  const usingRedis = !!getRedis();

  const results   = [];
  const notified: string[] = [];

  for (const symbol of coins) {
    const allSignals: TradingSignal[] = [];
    let topScore  = 0;
    let lineSent  = false;
    let lineError: string | undefined;

    try {
      await fetchTicker24h(symbol).catch(() => null);

      // Candle cache so HTF candles are fetched only once even if reused across TFs
      const candleCache = new Map<string, Candle[]>();
      for (const tf of timeframes) {
        try {
          if (!candleCache.has(tf)) candleCache.set(tf, await fetchCandles(symbol, tf, 200));
          const candles = candleCache.get(tf)!;

          // HTF bias: fetch higher TF once (cached), compute EMA200 direction
          let htfBias: 'LONG' | 'SHORT' | null = null;
          const htfTf = HTF_MAP[tf as Timeframe];
          if (htfTf) {
            try {
              if (!candleCache.has(htfTf)) candleCache.set(htfTf, await fetchCandles(symbol, htfTf, 250));
              const htfC   = candleCache.get(htfTf)!;
              const htfInd = computeIndicators(htfC);
              const htfPx  = htfC[htfC.length - 1].close;
              const e200   = htfInd.ema200;
              if (!isNaN(e200) && e200 > 0) {
                const near = Math.abs(htfPx - e200) / e200 < 0.015;
                if (!near) htfBias = htfPx > e200 ? 'LONG' : 'SHORT';
              }
            } catch { /* no bias if HTF unavailable */ }
          }

          const sigs = generateSignals(symbol, tf, candles, htfBias);
          allSignals.push(...sigs);
          sigs.forEach(s => { if (s.score > topScore) topScore = s.score; });
        } catch { /* skip failed timeframe */ }
      }

      // Direction unification: highest TF's direction is master, drop conflicting signals
      const unified    = unifySignalDirection(allSignals);
      const strong     = unified.filter(s => s.score >= minScore).sort((a, b) => b.score - a.score);
      const topStrong  = strong.find(s => s.score >= STRONG_THRESHOLD);
      // Entry signal: only from the designated entry TF. Multi-TF confluence confirms direction;
      // this signal's entry/TP/SL are what get pushed to LINE and inserted into DB.
      const entrySignal = strong.find(s => s.score >= STRONG_THRESHOLD && s.timeframe === entryTf);

      // Multi-TF confluence gate ─────────────────────────────────
      // Count distinct TFs producing signals in the master direction.
      // Requires ≥2 TFs to agree before LINE is sent.
      const longTFSet  = new Set(allSignals.filter(s => s.direction === 'LONG').map(s => s.timeframe));
      const shortTFSet = new Set(allSignals.filter(s => s.direction === 'SHORT').map(s => s.timeframe));
      const masterDir  = topStrong?.direction ?? null;
      const agreeTFs   = masterDir === 'LONG' ? longTFSet.size
                       : masterDir === 'SHORT' ? shortTFSet.size : 0;
      const confluenceMet = agreeTFs >= 2;

      // Read lock from Redis (persistent across cold starts)
      const last      = await getLock(symbol);
      const nowBucket = current4hBucket();
      const now       = Date.now();

      const locked     = !!last && last.locked;
      const sameCandle = !!last && !locked && last.candleBucket === nowBucket && last.direction === topStrong?.direction;
      const onCooldown = !!last && !locked && (now - last.sentAt) < COOLDOWN_MS;

      let skipReason: string | undefined;
      if (locked)          skipReason = `LINE skipped — active trade lock (${last?.direction})`;
      else if (sameCandle) skipReason = `LINE skipped — same 4h candle (${topStrong?.direction})`;
      else if (onCooldown && last)
        skipReason = `LINE skipped — cooldown (${Math.round((COOLDOWN_MS - (now - last.sentAt)) / 60000)}min left)`;
      else if (topStrong && !confluenceMet)
        skipReason = `LINE skipped — 多框架未確認 (${agreeTFs}/2 TF 同向)`;
      else if (topStrong && !entrySignal)
        // Direction confirmed but entry TF (e.g. 1h) has no qualifying signal — don't send.
        skipReason = `LINE skipped — no signal from entry TF (${entryTf})`;
      else if (entrySignal) {
        // Supabase hard-stop: prevents duplicate trades when Redis lock is lost (Vercel container recycle).
        // Default-block on exception — safer than default-allow which risks duplicate trades.
        const _su = process.env.NEXT_PUBLIC_SUPABASE_URL  || '';
        const _sk = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
        if (_su && _sk && lineUserId) {
          try {
            const { createClient: mkChk } = await import('@supabase/supabase-js');
            const chk = mkChk(_su, _sk);
            const { data: prof } = await chk.from('profiles').select('id')
              .eq('line_user_id', lineUserId).maybeSingle();
            if (prof?.id) {
              const { count: c } = await chk.from('trades')
                .select('id', { count: 'exact', head: true })
                .eq('user_id', prof.id).eq('symbol', entrySignal.symbol).is('result', null);
              if (c !== null && c > 0)
                skipReason = `LINE skipped — 同幣種已有持倉 (${symbol})`;
            }
          } catch (e) {
            // Default-block: treat Supabase error as "assume duplicate exists" to prevent double trade.
            skipReason = `LINE skipped — duplicate check failed (${String(e).slice(0, 80)})`;
            console.error(`[analyze] hard-stop check threw for ${symbol}:`, String(e));
          }
        }
      }

      if (entrySignal && lineReady && !locked && !sameCandle && !onCooldown && confluenceMet && !skipReason) {
        // LINE send — failure (e.g. quota exhausted) does NOT block Web Push or trade insert
        const { ok, error } = await sendLineMessage(lineToken, lineUserId, buildFlexMessages(entrySignal));
        lineSent  = ok;
        lineError = error;

        // Web Push fires regardless of LINE result (LINE and Web Push are independent channels)
        if (profileId) {
          const edir = entrySignal.direction === 'LONG' ? '做多▲' : '做空▼';
          const esym = entrySignal.symbol.replace('USDT', '/USDT');
          const tp1  = entrySignal.takeProfits[0];
          const sp   = entrySignal.signalPrice ?? 0;
          const isLmt = sp > 0 && Math.abs(entrySignal.entry - sp) / sp > 0.003;
          await sendWebPushToUser(profileId, {
            title: `${edir} ${esym} 交易信號`,
            body: `${isLmt ? '⏳掛單' : '🔴市場入場'} 進場 $${fmtPrice(entrySignal.entry)} ｜ TP1 $${fmtPrice(tp1)} ｜ SL $${fmtPrice(entrySignal.stopLoss)} ｜ ${entrySignal.score}分`,
            tag: `signal-${entrySignal.id}`,
          });
        }

        // Proceed with lock + trade insert when LINE sent OR Web Push configured.
        // This prevents re-triggering the same signal on the next cron even when LINE quota is exhausted.
        if (ok || !!profileId) {
          notified.push(symbol);
          await setLock(symbol, {
            sentAt: now, candleBucket: nowBucket,
            direction: entrySignal.direction, locked: true,
          });
          // Persist pending signal in Redis so client can reliably pick it up
          const rp = getRedis();
          if (rp) {
            try {
              await rp.lpush('pending_signals', JSON.stringify(entrySignal));
              await rp.expire('pending_signals', 24 * 3600);
            } catch { pendingSignals.push(entrySignal); }
          } else {
            pendingSignals.push(entrySignal);
            if (pendingSignals.length > 50) pendingSignals.splice(0, pendingSignals.length - 50);
          }

          // ── Write trade directly to Supabase ─────────────────────
          // Uses entrySignal (entry TF) for all fields — not topStrong (any TF).
          // This ensures a single trade per symbol from a single entry TF.
          const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL  || '';
          const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
          if (!sbUrl || !sbKey || !lineUserId) {
            console.error(
              `[analyze] trade insert skipped for ${entrySignal.symbol} —`,
              !sbUrl ? 'NEXT_PUBLIC_SUPABASE_URL missing' :
              !sbKey ? 'SUPABASE_SERVICE_ROLE_KEY missing' :
              'LINE_USER_ID missing',
            );
          } else {
            try {
              const { createClient: mkAdmin } = await import('@supabase/supabase-js');
              const admin = mkAdmin(sbUrl, sbKey);

              const { data: profile } = await admin
                .from('profiles')
                .select('id')
                .eq('line_user_id', lineUserId)
                .maybeSingle();

              if (profile?.id) {
                // Only insert if no open/pending trade for this symbol
                const { count } = await admin
                  .from('trades')
                  .select('id', { count: 'exact', head: true })
                  .eq('user_id', profile.id)
                  .eq('symbol', entrySignal.symbol)
                  .is('result', null);

                if (count === 0) {
                  // Determine if this is a limit order (entry differs from current price by >0.3%)
                  const sp = entrySignal.signalPrice ?? 0;
                  const isLimitOrder = sp > 0 && Math.abs(entrySignal.entry - sp) / sp > 0.003;
                  const tradeId = `trade-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                  const insertData = {
                    id:           tradeId,
                    user_id:      profile.id,
                    signal_id:    entrySignal.id,
                    symbol:       entrySignal.symbol,
                    direction:    entrySignal.direction,
                    timeframe:    entrySignal.timeframe,
                    strength:     entrySignal.strength,
                    score:        entrySignal.score,
                    entry:        entrySignal.entry,
                    stop_loss:    entrySignal.stopLoss,
                    tp1:          entrySignal.takeProfits[0],
                    tp2:          entrySignal.takeProfits[1] ?? entrySignal.takeProfits[0],
                    reasons:      entrySignal.reasons,
                    entry_notes:  '',
                    opened_at:    Date.now(),
                    status:       isLimitOrder ? 'waiting' : 'active',
                    signal_price: sp,
                  };

                  const ir = await admin.from('trades').insert(insertData);
                  let insertOk = !ir.error;

                  if (ir.error) {
                    if (ir.error.code === '42703') {
                      // status / signal_price columns not yet in DB schema — retry without them
                      // eslint-disable-next-line @typescript-eslint/no-unused-vars
                      const { status: _s, signal_price: _sp, ...baseData } = insertData;
                      const ir2 = await admin.from('trades').insert(baseData);
                      if (ir2.error) {
                        console.error(`[analyze] trade insert failed for ${entrySignal.symbol}: [${ir2.error.code}] ${ir2.error.message}`);
                      } else {
                        insertOk = true;
                      }
                    } else {
                      console.error(`[analyze] trade insert failed for ${entrySignal.symbol}: [${ir.error.code}] ${ir.error.message}`);
                    }
                  }

                  // Market-order entry confirmation (LINE + Web Push).
                  // Limit orders are notified by monitorActiveTrades when the fill candle is detected.
                  // Duplicate prevention: tlock:symbol is already set to locked=true (signal gate),
                  // and count===0 guard above ensures no re-insert, so this fires exactly once.
                  if (insertOk && !isLimitOrder) {
                    const dir = entrySignal.direction === 'LONG' ? '做多▲' : '做空▼';
                    const sym = entrySignal.symbol.replace('USDT', '/USDT');
                    const tp2 = entrySignal.takeProfits[1] ?? entrySignal.takeProfits[0];
                    const entryMsg =
                      `【✅ 市場入場】${sym}\n` +
                      `${dir} 已進場\n` +
                      `進場價：$${fmtPrice(entrySignal.entry)}\n` +
                      `TP1：$${fmtPrice(entrySignal.takeProfits[0])}｜TP2：$${fmtPrice(tp2)}｜止損：$${fmtPrice(entrySignal.stopLoss)}`;
                    if (lineToken && lineUserId) {
                      await sendLineWithRetry(lineToken, lineUserId, [{ type: 'text', text: entryMsg }]);
                    }
                    if (profileId) {
                      await sendWebPushToUser(profileId, {
                        title: `✅ 市場入場 ${sym}`,
                        body: `${dir} $${fmtPrice(entrySignal.entry)} ｜ TP1 $${fmtPrice(entrySignal.takeProfits[0])} ｜ SL $${fmtPrice(entrySignal.stopLoss)}`,
                        tag: `entry-${entrySignal.id}`,
                      });
                    }
                  }
                }
              }
            } catch (e) {
              console.error(`[analyze] trade insert threw for ${entrySignal.symbol}: ${String(e)}`);
            }
          }
        }
      }

      results.push({
        symbol,
        signalCount: strong.length,
        topScore,
        topSignal: strong[0]
          ? { direction: strong[0].direction, strength: strong[0].strength, score: strong[0].score, entry: strong[0].entry }
          : null,
        lineSent,
        locked,
        confluenceMet,
        agreeTFs,
        tfsAnalyzed: timeframes.filter(tf => candleCache.has(tf)),
        ...(lineError  ? { lineError }       : {}),
        ...(skipReason ? { note: skipReason } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ symbol, signalCount: 0, topScore, topSignal: null, lineSent: false, locked: false, error: msg });
    }

    await delay(300);
  }

  // Monitor active trades for TP/SL hits (server-side, App can be closed)
  const monitor = await monitorActiveTrades(lineToken, lineUserId, profileId)
    .catch(() => ({ monitored: 0, closed: 0, filled: 0, cancelled: 0 }));

  return NextResponse.json({
    ok: true, analyzedAt: new Date().toISOString(),
    minScore, lineReady, usingRedis, coins: coins.length, notified, results,
    monitor,
  });
}

// ── POST — return pending signals for client auto-journal ──────
// Signals are NOT deleted on read — they expire via the 24h TTL set at push time.
// Client deduplicates by signalId so re-reads are harmless.
export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24h window
  const r = getRedis();
  if (r) {
    try {
      const raw = await r.lrange('pending_signals', 0, -1);
      const signals = raw.map(s => (typeof s === 'string' ? JSON.parse(s) : s)) as TradingSignal[];
      const filtered = signals.filter(s => s && s.timestamp > cutoff);
      return NextResponse.json({ ok: true, signals: filtered, source: 'redis' });
    } catch { /* fall through to in-memory */ }
  }
  // In-memory fallback: read-only, filter by age (no splice)
  const signals = pendingSignals.filter(s => s.timestamp > cutoff);
  return NextResponse.json({ ok: true, signals, source: 'memory' });
}

// ── DELETE — unlock coin or reset ALL locks ────────────────────
export async function DELETE(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const symbol = req.nextUrl.searchParams.get('symbol')?.toUpperCase();
  const r = getRedis();

  if (!symbol) {
    // Reset ALL tlock keys
    if (r) {
      try {
        const keys = await r.keys('tlock:*');
        if (keys.length > 0) await Promise.all(keys.map(k => r.del(k)));
        return NextResponse.json({ ok: true, cleared: keys.length, usingRedis: true });
      } catch { /* fall through */ }
    }
    memLock.clear();
    return NextResponse.json({ ok: true, cleared: memLock.size, usingRedis: false });
  }

  await unlockSymbol(symbol);
  return NextResponse.json({ ok: true, symbol, unlocked: true, usingRedis: !!r });
}

function buildFlexMessages(signal: TradingSignal): object[] {
  const flex = buildLineFlexMessage(signal);
  const coin = signal.symbol.replace('USDT', '/USDT');
  const dir  = signal.direction === 'LONG' ? '做多▲' : '做空▼';
  return [{ type: 'flex', altText: `${dir} ${coin} 交易信號 | 得分 ${signal.score} | RR ${signal.riskReward}:1`, contents: flex }];
}

function delay(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// Retry LINE send once after 1.5s if the first attempt fails (handles transient LINE API errors).
async function sendLineWithRetry(token: string, uid: string, msgs: object[]) {
  const first = await sendLineMessage(token, uid, msgs);
  if (first.ok) return first;
  await delay(1500);
  const second = await sendLineMessage(token, uid, msgs);
  if (!second.ok) console.error(`[LINE] both attempts failed: ${second.error ?? 'unknown'}`);
  return second;
}
