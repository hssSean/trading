import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { fetchCandles, fetchTicker24h, fetchTopCoinsByVolume, fetchFundingRate } from '@/api/binance';
import { calcAtrHistory, calcAtrPercentile, adx as calcAdx, ema as calcEma } from '@/analysis/indicators';
import { generateSignals, generateMeanReversionSignals, unifySignalDirection } from '@/analysis/signals';
import { Candle, Timeframe, TradingSignal, Regime } from '@/types';
import { sendLineMessage, buildLineFlexMessage } from '@/lib/line';
import { sendWebPushToUser } from '@/lib/webpush';
import { calcPositionPlan, formatPlanLine } from '@/lib/position';

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
const STRONG_THRESHOLD   = 65;               // Strategy A: v2 spec ≥65 to notify
const STRONG_THRESHOLD_B = 13;               // Strategy B: base 10 (BB+RSI cross) + ≥1 confirmation
const INTRADAY_CLOSE_HOURS = 24;             // auto-close active trades older than 24h
const WAITING_EXPIRY_HOURS = 8;              // candle-window fallback for waiting orders
const WAITING_EXPIRY_BARS  = 4;              // spec §3-A: 掛單有效期最多 4 根（該時框）K 線

function tfBarMinutes(tf: string | null | undefined): number {
  switch (tf) {
    case '5m':  return 5;
    case '15m': return 15;
    case '4h':  return 240;
    case '1d':  return 1440;
    default:    return 60;
  }
}

// Per-strategy threshold: Strategy B uses a 0-19 scoring scale; Strategy A uses 0-100.
// v2.1 §1.5: tiered Strategy-A signals (A=65+/B=55+) are pre-gated inside
// generateSignals — any signal carrying a tier already qualifies.
function isStrongEnough(s: TradingSignal): boolean {
  if (s.strategy === 'B') return s.score >= STRONG_THRESHOLD_B;
  if (s.tier) return true;
  return s.score >= STRONG_THRESHOLD;
}

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

// ── Post-loss cooldown ─────────────────────────────────────────
// 2026-07-17 journal review: AKE stopped out, unlocked, and re-longed the same
// day for a second -12%. After a LOSS close, block the same symbol+direction
// for 24h — re-entering a setup that just proved wrong needs a fresh day.
const LOSS_COOLDOWN_SEC = 24 * 3600;
const memLossCd = new Map<string, number>(); // `${symbol}:${dir}` → expiry ms

async function setLossCooldown(symbol: string, direction: string, ttlSec: number = LOSS_COOLDOWN_SEC): Promise<void> {
  memLossCd.set(`${symbol}:${direction}`, Date.now() + ttlSec * 1000);
  const r = getRedis();
  if (r) {
    try { await r.set(`loss_cd:${symbol}:${direction}`, '1', { ex: ttlSec }); } catch { /* mem holds */ }
  }
}

async function isOnLossCooldown(symbol: string, direction: string): Promise<boolean> {
  const mem = memLossCd.get(`${symbol}:${direction}`);
  if (mem && mem > Date.now()) return true;
  const r = getRedis();
  if (r) {
    try { return !!(await r.get(`loss_cd:${symbol}:${direction}`)); } catch { /* fall through */ }
  }
  return false;
}

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
    // Spec §2.1 = top 20 by volume. Was cut to 15 for CPU; the 2026-07-18
    // indicator optimizations roughly halved per-coin cost, so restore 20 —
    // more distinct coins directly reduces 持倉鎖定 collisions (41% of rejects).
    cachedCoins = await fetchTopCoinsByVolume(20);
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
    // tp1_hit trades that already have result='WIN_TP1' but closed_at is still null
    // (closed_at null = "still watching for TP2"; set to now when trade is finally done)
    { data: tp1WatchRaw },
  ] = await Promise.all([
    baseQ().eq('status', 'waiting'),
    baseQ().or('status.eq.active,status.is.null,status.eq.tp1_hit'),
    admin.from('trades').select('*')
      .eq('status', 'tp1_hit').eq('result', 'WIN_TP1').is('closed_at', null),
  ]);

  if (waitErr)  console.error('[monitor] waiting query error:', waitErr.message);
  if (activeErr) console.error('[monitor] active query error:',  activeErr.message);

  const waiting = (waitingRaw ?? []) as any[];
  // Merge active + tp1-watching; deduplicate by id (a newly-set tp1_hit might appear in both)
  const seenIds = new Set<string>();
  const active: any[] = [];
  for (const t of [...(activeRaw ?? []), ...(tp1WatchRaw ?? [])]) {
    if (!seenIds.has(t.id as string)) { seenIds.add(t.id as string); active.push(t); }
  }

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
    const slPx   = trade.stop_loss as number;
    const risk   = Math.abs(entry - slPx);

    // ── 時序掃描：成交（影線觸及）vs 掛單失效（收盤確認），先到先贏 ──
    // spec §3-A：掛單期間若進場前提失效須立即取消，不是傻等逾期。
    // 失效三型（皆用收盤價確認，符合規格「收盤確認」精神）：
    //   1. 結構突破：收盤越過止損位 —— 進場理由（FVG/支撐/阻力）已被有效突破
    //   2. 行情走遠：未回測就朝目標方向走了 ≥1R —— 回到進場位的機率大減，不追
    //   3. TP1 直達：連 TP1 都到了還沒成交（外圈保險，通常第 2 條先觸發）
    let fillCandle: Candle | null = null;
    let cancelReason: string | null = null; // 完整訊息（LINE / 詳細）
    let cancelBody: string | null = null;   // 短訊息（push body）
    for (const c of candles) {
      const touched = isLong
        ? c.low  <= entry * 1.001 && (sp === 0 || sp > entry * 1.002)
        : c.high >= entry * 0.999 && (sp === 0 || sp < entry * 0.998);
      if (touched) { fillCandle = c; break; }

      if (isLong ? c.close <= slPx : c.close >= slPx) {
        cancelReason = `價格收盤${isLong ? '跌破' : '突破'}止損位 $${fmtPrice(slPx)}，進場前提已失效，掛單取消`;
        cancelBody   = '結構已突破，setup 失效';
        break;
      }
      // 行情走遠：自掛單當下（signal_price）朝獲利方向走了 ≥1R —— 回不到進場位。
      // 必須錨定 sp（下單當下價），不能用 entry±risk：回調/反彈單的 entry±risk
      // 剛好落在下單價附近，會讓掛單一放上去就被誤判走遠而秒取消。
      if (sp > 0 && risk > 0 && (isLong ? c.close >= sp + risk : c.close <= sp - risk)) {
        cancelReason = `價格自掛單當下 $${fmtPrice(sp)} 已朝${isLong ? '上' : '下'}走了 1R 以上，未回測進場位 $${fmtPrice(entry)}，回測機率大減 —— 放棄追進`;
        cancelBody   = '行情已走遠，不追單';
        break;
      }
      if (isLong ? c.high >= (trade.tp1 as number) : c.low <= (trade.tp1 as number)) {
        cancelReason = `價格未回測至進場位 $${fmtPrice(entry)}，直接到達 TP1 $${fmtPrice(trade.tp1 as number)}，掛單已自動取消`;
        cancelBody   = 'TP1 直接到達，跳過進場';
        break;
      }
    }
    const isFilled = !!fillCandle;

    // spec §3-A：掛單有效期最多 4 根（該時框）K 線
    const expiryMs  = WAITING_EXPIRY_BARS * tfBarMinutes(trade.timeframe as string | null) * 60_000;
    const isExpired = (now - ((trade.opened_at ?? 0) as number)) > expiryMs;
    if (!isFilled && !cancelReason && isExpired) {
      cancelReason = `掛單超過 ${WAITING_EXPIRY_BARS} 根 ${trade.timeframe ?? '1h'} K 線未成交，已自動取消（規格 §3-A）`;
      cancelBody   = `逾期 ${WAITING_EXPIRY_BARS} 根 K 線未成交`;
    }
    const isCancelled = !isFilled && cancelReason !== null;

    if (isFilled) {
      const filledAt = fillCandle!.closeTime ?? now;
      // Atomic fill: .eq('status','waiting') ensures only the cron that transitions
      // waiting→active actually sends the notification; concurrent cron gets 0 rows back.
      const fillRes  = await admin.from('trades')
        .update({ status: 'active', filled_at: filledAt, last_monitored_at: now })
        .eq('id', trade.id).eq('status', 'waiting').select('id');

      let fillWriteOk = !fillRes.error && (fillRes.data?.length ?? 0) > 0;
      if (fillRes.error) {
        if (fillRes.error.code === '42703') {
          const fb = await admin.from('trades').update({ status: 'active', opened_at: filledAt })
            .eq('id', trade.id).eq('status', 'waiting').select('id');
          if (fb.error) {
            console.error(`[monitor] fill write failed ${trade.id}: [${fb.error.code}] ${fb.error.message}`);
            await touchMonitoredAt(trade.id as string);
          } else {
            fillWriteOk = (fb.data?.length ?? 0) > 0;
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
      // Atomic cancel: .select('id') returns deleted rows; empty array means a concurrent
      // cron already deleted this row — skip notification in that case.
      const { data: delData, error: delErr } = await admin.from('trades').delete().eq('id', trade.id).select('id');
      if (delErr) {
        // Delete failed — don't notify; next cron will retry the delete
        console.error(`[monitor] cancel delete failed ${trade.id}: [${delErr.code}] ${delErr.message}`);
        await touchMonitoredAt(trade.id as string);
      } else if (!delData || delData.length === 0) {
        // Row already deleted by a concurrent cron — skip notification
        console.log(`[monitor] cancel skipped ${trade.id} — row already gone`);
      } else {
        await unlockSymbol(trade.symbol as string);
        cancelled++;
        // Notify only after row is confirmed gone — prevents repeat if delete had failed.
        // cancelReason/cancelBody were set during the chronological scan above.
        {
          const dir = isLong ? '▲ 做多' : '▼ 做空';
          const sym = (trade.symbol as string).replace('USDT', '/USDT');
          const reason = cancelReason ?? '掛單已自動取消';
          const cancelMsg = `【⚠️ 掛單取消】${sym}\n${dir} ${reason}`;
          if (lineToken && lineUserId) {
            await sendLineWithRetry(lineToken, lineUserId, [{ type: 'text', text: cancelMsg }]);
          }
          if (profileId) {
            await sendWebPushToUser(profileId, {
              title: `⚠️ 掛單取消 ${sym}`,
              body: `${dir} ${cancelBody ?? '掛單已取消'}`,
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

    const isLong        = trade.direction === 'LONG';
    const isTp1Hit      = trade.status === 'tp1_hit';
    const tradeStrategy = (trade.strategy as string | null) ?? '';

    // ── Phase 5: Trailing stop state ─────────────────────────────
    // Load from DB (columns may not exist yet — undefined → safe defaults via ??)
    const isTrailingActive  = (trade.trailing_stop_active as boolean | null) ?? false;
    const savedTrailingStop = (trade.current_stop as number | null) ?? 0;
    let trailingStop        = isTrailingActive && savedTrailingStop > 0 ? savedTrailingStop : 0;
    let trailingStopUpdated = false;
    let hitTrailingStop     = false;

    // Simple 14-period ATR from 1H candles — used to set/ratchet trailing stop.
    // Only computed for Strategy A trades; Strategy B uses fixed TP=BB middle (no trailing).
    let atr1h = 0;
    if (tradeStrategy === 'A' && candles.length >= 15) {
      const n = Math.min(14, candles.length - 1);
      let trSum = 0;
      for (let i = candles.length - n; i < candles.length; i++) {
        trSum += Math.max(
          candles[i].high - candles[i].low,
          Math.abs(candles[i].high - candles[i - 1].close),
          Math.abs(candles[i].low  - candles[i - 1].close),
        );
      }
      atr1h = trSum / n;
    }

    // Pre-loop: initialize trailing stop for existing tp1_hit trades that pre-date the columns.
    // When isTp1Hit=true but isTrailingActive=false (columns newly migrated or first run),
    // seed from TP1 price so the ratchet loop has a valid anchor rather than an arbitrary close.
    if (isTp1Hit && tradeStrategy === 'A' && atr1h > 0 && trailingStop === 0) {
      trailingStop = isLong
        ? Math.max((trade.tp1 as number) - 2 * atr1h, (trade.stop_loss as number))
        : Math.min((trade.tp1 as number) + 2 * atr1h, (trade.stop_loss as number));
      trailingStopUpdated = true;
    }

    let closeResult: string | null = null;
    let closePrice  = 0;
    let justHitTp1  = false;
    // localTp1Hit tracks TP1 across this scan (DB state + any new hit found in candles)
    let localTp1Hit = isTp1Hit;

    // Scan candles in chronological order.
    // Check order within each candle: TP1 first, then TP2, then trailing stop, then SL.
    // Same-candle TP1+SL → TP1 wins (price hit TP1 before reversing to SL).
    // Same-candle TP1+trailing stop → trailing stop fires (TP2 not reached, trailing is lower bound).
    for (const c of candles) {
      let justInitializedTrailing = false; // per-iteration flag: skip ratchet on init candle

      if (isLong) {
        if (!localTp1Hit && c.high >= (trade.tp1 as number)) {
          localTp1Hit = true; justHitTp1 = true;
          // Initialize trailing stop 2×ATR below TP1 level (Strategy A only)
          if (tradeStrategy === 'A' && atr1h > 0 && trailingStop === 0) {
            // Clamp to SL so trailing stop never gives a worse exit than original SL
            trailingStop = Math.max((trade.tp1 as number) - 2 * atr1h, (trade.stop_loss as number));
            trailingStopUpdated = true;
            justInitializedTrailing = true;
          }
        }
        if (c.high >= (trade.tp2 as number)) {
          closeResult = 'WIN_TP2'; closePrice = trade.tp2 as number; break;
        }
        // Trailing stop fires before original SL — gives better exit after TP1
        if (localTp1Hit && trailingStop > 0 && c.low <= trailingStop) {
          closeResult = 'WIN_TP1'; closePrice = trailingStop; hitTrailingStop = true; break;
        }
        if (c.low <= (trade.stop_loss as number)) {
          closeResult = localTp1Hit ? 'WIN_TP1' : 'LOSS';
          closePrice  = trade.stop_loss as number;
          break;
        }
        // Ratchet trailing stop upward as price advances (not on the init candle)
        if (localTp1Hit && !justInitializedTrailing && tradeStrategy === 'A' && atr1h > 0) {
          const candidate = c.close - 2 * atr1h;
          if (candidate > trailingStop) { trailingStop = candidate; trailingStopUpdated = true; }
        }
      } else {
        if (!localTp1Hit && c.low <= (trade.tp1 as number)) {
          localTp1Hit = true; justHitTp1 = true;
          if (tradeStrategy === 'A' && atr1h > 0 && trailingStop === 0) {
            // Clamp to SL so trailing stop never gives a worse exit than original SL
            trailingStop = Math.min((trade.tp1 as number) + 2 * atr1h, (trade.stop_loss as number));
            trailingStopUpdated = true;
            justInitializedTrailing = true;
          }
        }
        if (c.low <= (trade.tp2 as number)) {
          closeResult = 'WIN_TP2'; closePrice = trade.tp2 as number; break;
        }
        if (localTp1Hit && trailingStop > 0 && c.high >= trailingStop) {
          closeResult = 'WIN_TP1'; closePrice = trailingStop; hitTrailingStop = true; break;
        }
        if (c.high >= (trade.stop_loss as number)) {
          closeResult = localTp1Hit ? 'WIN_TP1' : 'LOSS';
          closePrice  = trade.stop_loss as number;
          break;
        }
        // Ratchet trailing stop downward as price advances (SHORT)
        if (localTp1Hit && !justInitializedTrailing && tradeStrategy === 'A' && atr1h > 0) {
          const candidate = c.close + 2 * atr1h;
          if (trailingStop === 0 || candidate < trailingStop) { trailingStop = candidate; trailingStopUpdated = true; }
        }
      }
    }

    // Persist trailing stop updates that occurred during the scan but didn't trigger a close.
    // Skipped when justHitTp1=true because the TP1 update block below merges it in.
    // 42703-safe: catching write failures is sufficient (columns missing → touchMonitoredAt).
    if (!closeResult && !justHitTp1 && trailingStopUpdated && trailingStop > 0) {
      try {
        await admin.from('trades')
          .update({ trailing_stop_active: true, current_stop: trailingStop, last_monitored_at: now })
          .eq('id', trade.id);
      } catch {
        // 42703 if trailing_stop_active/current_stop columns not yet migrated — non-critical
        await touchMonitoredAt(trade.id as string);
      }
    }

    // TP1 newly reached in this scan, no close yet → record result immediately and notify
    if (justHitTp1 && !closeResult) {
      const tp1Price = trade.tp1 as number;
      const tp1Pnl   = isLong
        ? ((tp1Price - (trade.entry as number)) / (trade.entry as number)) * 100
        : (((trade.entry as number) - tp1Price) / (trade.entry as number)) * 100;

      // Write result='WIN_TP1' + exit_price + pnl immediately so the trade appears
      // in the journal right away. closed_at is intentionally NOT set here — null
      // closed_at means "TP1 secured, still watching for TP2".
      // The next monitoring cycle fetches status='tp1_hit' AND result='WIN_TP1' AND closed_at IS NULL.
      // Phase 5: merge trailing stop initialization into this update to avoid a separate round-trip.
      const tp1UpdatePayload: Record<string, unknown> = {
        status:            'tp1_hit',
        last_monitored_at: now,
        result:            'WIN_TP1',
        exit_price:        tp1Price,
        pnl_percent:       parseFloat(tp1Pnl.toFixed(2)),
        // closed_at intentionally omitted — null signals "still watching for TP2"
      };
      if (trailingStopUpdated && trailingStop > 0) {
        tp1UpdatePayload.trailing_stop_active = true;
        tp1UpdatePayload.current_stop         = trailingStop;
      }
      const tp1Res = await admin.from('trades')
        .update(tp1UpdatePayload)
        .eq('id', trade.id).or('status.eq.active,status.is.null').select('id');

      let tp1WriteOk = !tp1Res.error && (tp1Res.data?.length ?? 0) > 0;
      if (tp1Res.error) {
        if (tp1Res.error.code === '42703') {
          // Columns (exit_price, pnl_percent) may not exist yet — retry with base fields only
          const fb = await admin.from('trades')
            .update({ status: 'tp1_hit', result: 'WIN_TP1' })
            .eq('id', trade.id).or('status.eq.active,status.is.null').select('id');
          if (fb.error) {
            console.error(`[monitor] tp1_hit write failed ${trade.id}: [${fb.error.code}] ${fb.error.message}`);
          } else {
            tp1WriteOk = (fb.data?.length ?? 0) > 0;
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

    // v2 spec §3-A 時間止損：進場後 8 根（該時框）K 線未達 +0.5R → 平價/小損出場。
    // 2026-07-19 漏斗數據：持倉鎖定佔全部拒絕 41%（第一名）—— 停滯單提早
    // 釋放倉位是容量最大的槓桿。已達 TP1 的單在獲利管理模式，不適用。
    let timeStopFired = false;
    if (!closeResult && !localTp1Hit && lastClose !== null) {
      const barMinutes = trade.timeframe === '5m' ? 5
        : trade.timeframe === '15m' ? 15
        : trade.timeframe === '4h' ? 240
        : trade.timeframe === '1d' ? 1440
        : 60;
      const ageBars = (now - ((trade.filled_at ?? trade.opened_at ?? 0) as number)) / (barMinutes * 60_000);
      if (ageBars >= 8) {
        const riskDist = Math.abs((trade.entry as number) - (trade.stop_loss as number));
        if (riskDist > 0) {
          const progressR = (isLong
            ? lastClose - (trade.entry as number)
            : (trade.entry as number) - lastClose) / riskDist;
          if (progressR < 0.5) {
            closeResult   = 'MANUAL_CLOSE';
            closePrice    = lastClose;
            timeStopFired = true;
          }
        }
      }
    }

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

    // Atomic close guard differs by trade state:
    // - Normal (result null): use .is('result', null) — standard first-write guard.
    // - tp1_hit watching (result='WIN_TP1', closed_at null): use that pair as guard.
    //   For TP2, upgrade result to WIN_TP2. For SL/auto, keep result (stays WIN_TP1),
    //   just set closed_at + final exit_price/pnl to finalize the record.
    const isFinalClosingTp1 = isTp1Hit; // tp1_hit trade reaching its final outcome
    const closeUpdate = isFinalClosingTp1
      ? {
          // Only change result if upgrading to TP2; otherwise leave WIN_TP1 as-is
          ...(closeResult === 'WIN_TP2' ? { result: 'WIN_TP2' } : {}),
          exit_price:  closePrice,
          closed_at:   now,
          pnl_percent: parseFloat(pnl.toFixed(2)),
        }
      : {
          result:      closeResult,
          exit_price:  closePrice,
          closed_at:   now,
          pnl_percent: parseFloat(pnl.toFixed(2)),
        };

    const closeFilter = isFinalClosingTp1
      ? admin.from('trades').update(closeUpdate)
          .eq('id', trade.id).eq('status', 'tp1_hit').is('closed_at', null)
      : admin.from('trades').update(closeUpdate)
          .eq('id', trade.id).is('result', null);

    const closeRes = await closeFilter.select('id');

    let closeWriteOk = !closeRes.error && (closeRes.data?.length ?? 0) > 0;

    if (closeRes.error) {
      if (closeRes.error.code === '42703') {
        // exit_price / pnl_percent column missing — write minimal fields
        const fbUpdate = isFinalClosingTp1
          ? { ...(closeResult === 'WIN_TP2' ? { result: 'WIN_TP2' } : {}), closed_at: now }
          : { result: closeResult, closed_at: now };
        const fbFilter = isFinalClosingTp1
          ? admin.from('trades').update(fbUpdate).eq('id', trade.id).eq('status', 'tp1_hit').is('closed_at', null)
          : admin.from('trades').update(fbUpdate).eq('id', trade.id).is('result', null);
        const fallback = await fbFilter.select('id');
        if (!fallback.error) {
          closeWriteOk = (fallback.data?.length ?? 0) > 0;
        } else {
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

    if (!closeWriteOk) {
      console.log(`[monitor] close skipped ${trade.id} — result already set by concurrent cron`);
      continue;
    }

    await unlockSymbol(trade.symbol as string);

    // Post-loss cooldown: same symbol+direction blocked for 24h (see helper docs)
    if (closeResult === 'LOSS') {
      await setLossCooldown(trade.symbol as string, trade.direction as string);
    } else if (timeStopFired) {
      // 時間止損＝盤面停滯而非證偽；短冷卻 4h 防止立刻重進同一個停滯 setup
      // 空轉手續費，倉位仍讓給其他幣種
      await setLossCooldown(trade.symbol as string, trade.direction as string, 4 * 3600);
    }

    {
      const dir = isLong ? '▲ 做多' : '▼ 做空';
      const sym = (trade.symbol as string).replace('USDT', '/USDT');
      const pnlStr = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`;
      let closeMsg: string;
      let pushTitle: string;
      if (closeResult === 'MANUAL_CLOSE' && timeStopFired) {
        closeMsg   = `【⏱ 時間止損】${sym}\n${dir} 8 根 K 線未達 +0.5R，平價出場釋放倉位（規格 §3-A）\n出場價：$${fmtPrice(closePrice)}\n損益：${pnlStr}`;
        pushTitle  = `⏱ 時間止損 ${sym}`;
      } else if (closeResult === 'MANUAL_CLOSE') {
        closeMsg   = `【⏱ 到期平倉】${sym}\n${dir} 超過 ${autoCloseHours}小時未達標，自動平倉\n出場價：$${fmtPrice(closePrice)}\n損益：${pnlStr}`;
        pushTitle  = `⏱ 到期平倉 ${sym}`;
      } else {
        const label = closeResult === 'WIN_TP2' ? '✅ TP2 全部達標'
                    : closeResult === 'WIN_TP1' ? (hitTrailingStop ? '🔒 移動止損出場（TP1 已達標）' : localTp1Hit ? '🔒 SL 出場（TP1 已達標）' : '✅ TP1 達標')
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

// ── Confidence score (0-100, Phase 4) ────────────────────────
// Parallel to existing `score`; does NOT affect the STRONG_THRESHOLD gate yet.
// Formula: base 50 + ADX strength + confluence + volume + funding rate crowding.
// Crowded direction (>+0.1% for LONG, <-0.05% for SHORT) deducts 20 pts.
function computeConfidence(
  signal: TradingSignal,
  adx4h: number,
  fundingRate: number,
  agreeTFs: number,
): number {
  let c = 50;

  // ADX strength (only meaningful in trending regime)
  if (!isNaN(adx4h)) {
    if      (adx4h > 40) c += 15;
    else if (adx4h > 30) c += 10;
    else if (adx4h > 25) c +=  5;
  }

  // Confluence: Strategy B is its own dual-factor confirmation
  if      (signal.strategy === 'B') c += 10;
  else if (agreeTFs >= 2)           c += 15;

  // Volume (derived from reasons string to avoid passing extra params)
  if (signal.reasons.some(r => r.includes('量能') || r.includes('放量'))) c += 5;

  // Funding rate crowding — same direction as crowded market → -20
  if (signal.direction === 'LONG'  && fundingRate >  0.001)  c -= 20;
  if (signal.direction === 'SHORT' && fundingRate < -0.0005) c -= 20;

  return Math.max(0, Math.min(100, Math.round(c)));
}

// ── Strategy B: consecutive-loss pause check ─────────────────
// Returns true if this symbol's Strategy B should be paused (2 consecutive
// LOSS results within the last 24h). Safe-fails to false on any DB error
// (including 42703 if the `strategy` column hasn't been migrated yet).
async function checkStratBPaused(symbol: string): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL  || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return false;

  // Redis fast-path: key is set when we first confirm the pause condition
  const r = getRedis();
  if (r) {
    try {
      const paused = await r.get<boolean>(`stratB_pause:${symbol}`);
      if (paused) return true;
    } catch { /* fall through to DB */ }
  }

  try {
    const { createClient: mkChk } = await import('@supabase/supabase-js');
    const adm = mkChk(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data } = await adm.from('trades')
      .select('result, closed_at')
      .eq('symbol', symbol)
      .eq('strategy', 'B')          // 42703 → catch block → return false
      .not('result', 'is', null)
      .order('closed_at', { ascending: false })
      .limit(2);

    if (!data || data.length < 2) return false;
    const [recent, prev] = data as { result: string; closed_at: number }[];
    if (recent.result !== 'LOSS' || prev.result !== 'LOSS') return false;

    const elapsed = Date.now() - recent.closed_at;
    if (elapsed > 24 * 3_600_000) return false;

    // Cache remaining pause duration in Redis so next cron reads fast
    if (r) {
      const remainingSec = Math.ceil((24 * 3_600_000 - elapsed) / 1000);
      try { await r.set(`stratB_pause:${symbol}`, true, { ex: remainingSec }); } catch { /* best-effort */ }
    }
    return true;
  } catch {
    // Includes 42703 (column not migrated yet) — don't pause
    return false;
  }
}

const MAX_TOTAL_RISK_PCT = 5; // total open risk cap (% of account)

// ── Phase 5: total open risk check ───────────────────────────
// Sums suggested_risk_pct of all open trades for a user.
// Falls back to (open-trade-count × 1%) if the column doesn't exist yet.
// Returns 0 on any fatal error so the gate never falsely blocks signals.
async function checkTotalOpenRisk(profileId: string): Promise<number> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL  || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key || !profileId) return 0;
  const { createClient: mk } = await import('@supabase/supabase-js');
  const adm = mk(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  try {
    const { data } = await adm.from('trades')
      .select('suggested_risk_pct')
      .eq('user_id', profileId)
      .is('closed_at', null);  // closed_at=null means still open (incl. tp1_hit watching TP2)
    if (!data) return 0;
    return data.reduce((s: number, t: { suggested_risk_pct?: number | null }) =>
      s + (t.suggested_risk_pct ?? 1), 0);
  } catch {
    // Column not migrated (42703) or other DB error — estimate via open-trade count × 1%
    try {
      const { count } = await adm.from('trades')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', profileId)
        .is('closed_at', null);
      return (count ?? 0) * 1;
    } catch {
      return 0;
    }
  }
}

// ── Phase 6: Event filter ─────────────────────────────────────
// Blocks all new signals within ±30 min of a scheduled market event.
// Event list sources (first non-empty wins):
//   1. Redis key  'event_filter_events'  → JSON array of ISO-8601 strings
//   2. Env var    EVENT_FILTER_EVENTS    → comma-separated ISO-8601 strings OR JSON array
// To add an event via Upstash console:
//   SET event_filter_events '["2025-01-15T14:30:00Z","2025-01-15T20:00:00Z"]'
const EVENT_WINDOW_MS = 30 * 60 * 1000; // ±30 min window

async function checkEventFilter(): Promise<{ active: boolean; reason?: string }> {
  try {
    let events: string[] = [];

    // Priority 1: Redis (survives redeploy, allows runtime updates)
    const r = getRedis();
    if (r) {
      try {
        const raw = await r.get<unknown>('event_filter_events');
        if (raw) {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (Array.isArray(parsed)) events = parsed as string[];
        }
      } catch { /* fall through */ }
    }

    // Priority 2: Env var (deploy-time config)
    if (events.length === 0) {
      const envRaw = (process.env.EVENT_FILTER_EVENTS ?? '').trim();
      if (envRaw) {
        try {
          const parsed = JSON.parse(envRaw);
          if (Array.isArray(parsed)) events = parsed as string[];
        } catch {
          // Plain comma-separated list
          events = envRaw.split(',').map(s => s.trim()).filter(Boolean);
        }
      }
    }

    if (events.length === 0) return { active: false };

    const now = Date.now();
    for (const ev of events) {
      const evMs = new Date(ev).getTime();
      if (!isNaN(evMs) && Math.abs(now - evMs) <= EVENT_WINDOW_MS) {
        const diffMin = Math.round((evMs - now) / 60_000);
        const label   = diffMin > 0 ? `${diffMin}分鐘後` : diffMin < 0 ? `${-diffMin}分鐘前` : '進行中';
        return { active: true, reason: `事件過濾 — 重大事件 ${label}（${new Date(evMs).toUTCString()}）` };
      }
    }
    return { active: false };
  } catch {
    return { active: false }; // never block signals on error
  }
}

// ── §4.3 Same-direction open-risk cap（風險加權）──────────────
// Spec 原文是「同向合計風險 ≤ 2%」，舊實作卻數「筆數 ≤ 2」——B 級輕倉
// 只佔 0.5% 風險，按筆數算會把容量砍半（2026-07-19 漏斗數據：同向上限
// 佔全部拒絕 11-23%，是第二大容量瓶頸）。改為：
//   同向合計風險 + 新單風險 ≤ 2.0%；山寨桶（非BTC/ETH）同向 ≤ 1.0%。
// A 級 = 1%、B 級 = 0.5%（tier 欄位缺失的舊資料保守當 1%）。
async function checkSameDirectionRisk(
  profileId: string, direction: string, symbol: string, newTier: string | null | undefined,
): Promise<{ block: boolean; reason?: string }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL  || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key || !profileId) return { block: false };
  try {
    const { createClient: mk } = await import('@supabase/supabase-js');
    const adm = mk(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

    const { data } = await adm.from('trades')
      .select('symbol, tier')
      .eq('user_id', profileId).eq('direction', direction).is('closed_at', null);
    const rows = (data ?? []) as { symbol: string; tier?: string | null }[];

    const riskOf = (tier: string | null | undefined) => (tier === 'B' ? 0.5 : 1.0);
    const newRisk = riskOf(newTier);

    let totalRisk = 0;
    let altRisk = 0;
    for (const row of rows) {
      const r = riskOf(row.tier);
      totalRisk += r;
      if (!row.symbol.startsWith('BTC') && !row.symbol.startsWith('ETH')) altRisk += r;
    }

    if (totalRisk + newRisk > 2.0) {
      return {
        block: true,
        reason: `同向風險上限：${direction} 已占用 ${totalRisk.toFixed(1)}%，新單 ${newRisk.toFixed(1)}% 會超過 2%`,
      };
    }

    const isAltcoin = !symbol.startsWith('BTC') && !symbol.startsWith('ETH');
    if (isAltcoin && altRisk + newRisk > 1.0) {
      return {
        block: true,
        reason: `山寨同向風險上限：${direction} 山寨桶已占用 ${altRisk.toFixed(1)}%，加新單會超過 1%`,
      };
    }
    return { block: false };
  } catch { return { block: false }; }
}

// ── §4.4 Circuit breaker ──────────────────────────────────────
// Triggered when today's closed trades hit ≥3 consecutive losses OR cumulative
// ACCOUNT loss ≤ -3%. 2026-07-18 fix: measure account impact (R × tier risk),
// NOT raw pnl_percent. A single ATR-based -12% stop is only -1R = -1% account;
// summing raw % tripped the breaker on one bad candle and froze signals all day.
// Cache key is v2 so any stuck v1 (`circuit_breaker:`) key is abandoned on deploy.
async function checkCircuitBreaker(profileId: string): Promise<{ triggered: boolean; reason?: string }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL  || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key || !profileId) return { triggered: false };

  const r = getRedis();
  if (r) {
    try {
      const cached = await r.get<string>(`circuit_breaker_v2:${profileId}`);
      if (cached) return { triggered: true, reason: cached };
    } catch { /* fall through */ }
  }

  try {
    const { createClient: mk } = await import('@supabase/supabase-js');
    const adm = mk(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

    const todayUTC = new Date();
    todayUTC.setUTCHours(0, 0, 0, 0);

    const { data } = await adm.from('trades')
      .select('result, pnl_percent, entry, stop_loss, tier, closed_at')
      .eq('user_id', profileId).not('result', 'is', null)
      .gte('closed_at', todayUTC.getTime())
      .order('closed_at', { ascending: false });

    if (!data || data.length === 0) return { triggered: false };

    // Check 1: cumulative ACCOUNT loss ≤ -3% (R-multiple × tier risk)
    const rows = data as { result: string; pnl_percent?: number | null; entry?: number | null; stop_loss?: number | null; tier?: string | null }[];
    const dailyAcct = rows.reduce((s, t) => {
      if (t.pnl_percent == null || !t.entry || !t.stop_loss) return s;
      const stopPct = Math.abs(t.entry - t.stop_loss) / t.entry * 100;
      if (stopPct <= 0) return s;
      const rMultiple = t.pnl_percent / stopPct;          // e.g. -12% / 12% = -1R
      return s + rMultiple * (t.tier === 'B' ? 0.5 : 1.0); // account % at suggested risk
    }, 0);
    if (dailyAcct <= -3) {
      const reason = `熔斷：當日帳戶虧損 ${dailyAcct.toFixed(2)}%（≤ -3%）`;
      await cacheBreaker(r, profileId, reason, todayUTC);
      return { triggered: true, reason };
    }

    // Check 2: 3 consecutive losses in today's trades
    let streak = 0;
    for (const t of rows) {
      if (t.result === 'LOSS') streak++;
      else break;
    }
    if (streak >= 3) {
      const reason = `熔斷：連續 ${streak} 筆止損`;
      await cacheBreaker(r, profileId, reason, todayUTC);
      return { triggered: true, reason };
    }
    return { triggered: false };
  } catch { return { triggered: false }; }
}

async function cacheBreaker(r: import('@upstash/redis').Redis | null, profileId: string, reason: string, todayUTC: Date) {
  if (!r) return;
  const secLeft = Math.ceil((todayUTC.getTime() + 86_400_000 - Date.now()) / 1000);
  try { await r.set(`circuit_breaker_v2:${profileId}`, reason, { ex: Math.max(secLeft, 60) }); } catch { /* best-effort */ }
}

// ── Shadow simulation of rejected signals ──────────────────────
// Spec §4.5: a rule may only be loosened when funnel data proves the signals
// it kills are net-positive. Every gate-rejected candidate that had concrete
// entry/SL/TP levels becomes a "shadow trade" simulated against real candles;
// /api/reject-funnel reports per-gate would-have-won/lost + net R.
interface ShadowTrade {
  id: string;
  at: number;               // rejection time
  symbol: string;
  direction: string;
  timeframe: string;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  score: number;
  tier: string | null;
  strategy: string;
  rejectedAt: string;       // gate id from the funnel
  signalPrice: number;
  status: 'waiting' | 'active' | 'done';
  filledAt?: number;
  tp1Hit?: boolean;
  result?: string;          // WIN_TP1 | WIN_TP2 | LOSS | EXPIRED | TIMEOUT
  exitPrice?: number;
  closedAt?: number;
  lastCheckedAt: number;
}

// Gates where a full signal existed — worth simulating. score_gate has no levels;
// locked/same_candle/cooldown duplicate live trades and would double-count.
const SHADOW_GATES = new Set([
  'confluence', 'no_entry_tf', 'btc_direction', 'btc_pause', 'loss_cooldown',
  'same_dir_cap', 'total_risk_cap', 'circuit_breaker', 'event_filter', 'insert_failed',
]);
const SHADOW_MAX = 300; // hash size guard

function simulateShadow(st: ShadowTrade, candles: Candle[], now: number): void {
  const isLong = st.direction === 'LONG';
  const waitMs   = WAITING_EXPIRY_HOURS * 3600 * 1000;
  const activeMs = INTRADAY_CLOSE_HOURS * 3600 * 1000;

  if (st.status === 'waiting') {
    for (const c of candles) {
      if (c.closeTime <= st.at || c.openTime > st.at + waitMs) continue;
      const touched = isLong ? c.low <= st.entry : c.high >= st.entry;
      if (touched) { st.status = 'active'; st.filledAt = Math.max(c.openTime, st.at); break; }
    }
    if (st.status === 'waiting') {
      if (now - st.at > waitMs) { st.status = 'done'; st.result = 'EXPIRED'; st.closedAt = now; }
      return;
    }
  }
  if (st.status !== 'active' || !st.filledAt) return;

  for (const c of candles) {
    if (c.closeTime <= st.filledAt) continue;
    const hitSL  = isLong ? c.low  <= st.stopLoss : c.high >= st.stopLoss;
    const hitTP1 = isLong ? c.high >= st.tp1      : c.low  <= st.tp1;
    const hitTP2 = isLong ? c.high >= st.tp2      : c.low  <= st.tp2;
    if (st.tp1Hit) {
      if (hitTP2) { st.status = 'done'; st.result = 'WIN_TP2'; st.exitPrice = st.tp2;      st.closedAt = c.closeTime; return; }
      if (hitSL)  { st.status = 'done'; st.result = 'WIN_TP1'; st.exitPrice = st.stopLoss; st.closedAt = c.closeTime; return; }
      continue;
    }
    if (hitTP2)      { st.status = 'done'; st.result = 'WIN_TP2'; st.exitPrice = st.tp2; st.closedAt = c.closeTime; return; }
    else if (hitTP1) { st.tp1Hit = true; continue; } // TP1-before-SL same-candle rule (matches monitor)
    else if (hitSL)  { st.status = 'done'; st.result = 'LOSS'; st.exitPrice = st.stopLoss; st.closedAt = c.closeTime; return; }
  }
  if (now - st.filledAt > activeMs) {
    const lastC  = candles[candles.length - 1];
    st.status    = 'done';
    st.result    = st.tp1Hit ? 'WIN_TP1' : 'TIMEOUT';
    st.exitPrice = st.tp1Hit ? st.tp1 : lastC?.close;
    st.closedAt  = now;
  }
}

async function processShadowTrades(newCandidates: ShadowTrade[]): Promise<void> {
  const r = getRedis();
  if (!r) return; // simulation needs persistence
  try {
    const raw = (await r.hgetall<Record<string, unknown>>('shadow_trades')) ?? {};
    const shadows = new Map<string, ShadowTrade>();
    for (const [id, v] of Object.entries(raw)) {
      try {
        const st = (typeof v === 'string' ? JSON.parse(v) : v) as ShadowTrade;
        if (st && st.symbol && st.status) shadows.set(id, st);
      } catch { /* drop malformed entry */ }
    }

    const writes: Record<string, string> = {};

    // Merge new candidates — one live shadow per symbol+direction (a persistent
    // reject would otherwise add a duplicate every 5-minute scan)
    const liveKeys = new Set(
      Array.from(shadows.values()).filter(s => s.status !== 'done').map(s => `${s.symbol}:${s.direction}`),
    );
    for (const c of newCandidates) {
      if (shadows.size >= SHADOW_MAX) break;
      const key = `${c.symbol}:${c.direction}`;
      if (liveKeys.has(key)) continue;
      liveKeys.add(key);
      shadows.set(c.id, c);
      writes[c.id] = JSON.stringify(c);
    }

    // Advance live shadows — one candle fetch per symbol, capped per run
    const now  = Date.now();
    const live = Array.from(shadows.values()).filter(s => s.status !== 'done');
    const bySymbol = new Map<string, ShadowTrade[]>();
    live.forEach(s => {
      const arr = bySymbol.get(s.symbol) ?? [];
      arr.push(s);
      bySymbol.set(s.symbol, arr);
    });

    let fetches = 0;
    for (const [symbol, group] of Array.from(bySymbol.entries())) {
      if (fetches >= 8) break; // rest advance next cron (5 min later)
      fetches++;
      let candles: Candle[] = [];
      try { candles = await fetchCandles(symbol, '1h', 96); } catch { continue; }
      for (const st of group) {
        simulateShadow(st, candles, now);
        st.lastCheckedAt = now;
        writes[st.id] = JSON.stringify(st);
      }
    }

    // Prune done shadows past the 14-day analysis window
    const toDelete: string[] = [];
    for (const [id, st] of Array.from(shadows.entries())) {
      if (st.status === 'done' && now - (st.closedAt ?? st.at) > 14 * 24 * 3600 * 1000) toDelete.push(id);
    }

    if (Object.keys(writes).length > 0) await r.hset('shadow_trades', writes);
    if (toDelete.length > 0) await r.hdel('shadow_trades', ...toDelete);
    await r.expire('shadow_trades', 14 * 24 * 3600);
  } catch (e) {
    console.error('[shadow] simulation failed:', String(e).slice(0, 200));
  }
}

// ── §2.3 BTC regime (fetched once per cron run) ───────────────
interface BtcRegimeState {
  regime: 'bullish' | 'bearish' | 'chaotic';
  longPaused:  boolean; // BTC 1H abnormal drop → pause altcoin LONG signals 2h
  shortPaused: boolean; // BTC 1H abnormal pump → pause altcoin SHORT signals 2h
  movePct?: number;     // BTC 1H 4-candle cumulative move (diagnostics)
  moveThresholdPct?: number; // trigger threshold = 2.5 × ATR(14,1H) as % (diagnostics)
}
// In-memory pause fallback when Redis is absent (lost on cold start — acceptable)
const memBtcPause = { long: 0, short: 0 };
const BTC_PAUSE_MS = 2 * 3600 * 1000; // v2.1 §1.1: pause 2h (was 4h)

async function fetchBtcRegime(): Promise<BtcRegimeState> {
  const state: BtcRegimeState = { regime: 'chaotic', longPaused: false, shortPaused: false };
  try {
    const [btc4h, btc1h] = await Promise.all([
      fetchCandles('BTCUSDT', '4h', 250),
      fetchCandles('BTCUSDT', '1h', 20), // 20 bars → enough for ATR(14)
    ]);
    // Only EMA50/EMA200 needed for regime — skip full indicator compute
    const btcClose  = btc4h[btc4h.length - 1].close;
    const btcCloses = btc4h.map(c => c.close);
    const e50Arr    = calcEma(btcCloses, 50);
    const e200Arr   = calcEma(btcCloses, 200);
    const ema50  = e50Arr[e50Arr.length - 1]   ?? NaN;
    const ema200 = e200Arr[e200Arr.length - 1] ?? NaN;
    if (!isNaN(ema50) && !isNaN(ema200)) {
      if (ema50 > ema200 && btcClose > ema50)      state.regime = 'bullish';
      else if (ema50 < ema200 && btcClose < ema50) state.regime = 'bearish';
    }

    // v2.1 §1.1: fixed ±1.5% trigger → 2.5×ATR(14,1H) relative threshold.
    // Fixed 1.5% fired constantly in crypto vol; ATR-relative only flags ABNORMAL moves.
    const last4 = btc1h.slice(-4);
    const btcChange = (last4[last4.length - 1].close - last4[0].close) / last4[0].close;
    let atr1h = 0;
    for (let i = Math.max(1, btc1h.length - 14); i < btc1h.length; i++) {
      const h = btc1h[i].high, l = btc1h[i].low, pc = btc1h[i - 1].close;
      atr1h += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }
    atr1h /= Math.min(14, btc1h.length - 1);
    const lastPx    = btc1h[btc1h.length - 1].close;
    const threshold = lastPx > 0 ? (2.5 * atr1h) / lastPx : 0.0375; // fallback ≈ legacy behaviour
    state.movePct          = parseFloat((btcChange * 100).toFixed(2));
    state.moveThresholdPct = parseFloat((threshold * 100).toFixed(2));

    const r = getRedis();
    const now = Date.now();
    if (btcChange < -threshold) {
      state.longPaused = true;
      memBtcPause.long = now;
      if (r) { try { await r.set('btc_pause:LONG', `${state.movePct}%`, { ex: BTC_PAUSE_MS / 1000 }); } catch { /* mem fallback holds */ } }
    }
    if (btcChange > threshold) {
      state.shortPaused = true;
      memBtcPause.short = now;
      if (r) { try { await r.set('btc_pause:SHORT', `${state.movePct}%`, { ex: BTC_PAUSE_MS / 1000 }); } catch { /* mem fallback holds */ } }
    }
    // Pause persists 2h from the trigger even after the move rolls out of the window
    if (!state.longPaused || !state.shortPaused) {
      if (r) {
        try {
          const [pl, ps] = await Promise.all([r.get('btc_pause:LONG'), r.get('btc_pause:SHORT')]);
          if (pl) state.longPaused  = true;
          if (ps) state.shortPaused = true;
        } catch { /* fall through to memory */ }
      }
      if (now - memBtcPause.long  < BTC_PAUSE_MS) state.longPaused  = true;
      if (now - memBtcPause.short < BTC_PAUSE_MS) state.shortPaused = true;
    }
  } catch { /* use defaults */ }
  return state;
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
  // Resolved Supabase profile UUID — used for trade insert + Web Push subscription lookup.
  // Fallback order: (1) line_user_id column match, (2) SUPABASE_PROFILE_ID env var (direct override).
  let profileId = '';
  // Account settings synced from the app (profiles.settings JSONB) — drives the
  // position/margin/leverage line in notifications. Defaults match the store.
  let acctSize    = 1000;
  let acctRiskPct = 1;
  {
    const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL  || '';
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (sbUrl && sbKey) {
      try {
        const { createClient: mkLineAdmin } = await import('@supabase/supabase-js');
        const lineAdmin = mkLineAdmin(sbUrl, sbKey, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        const applySettings = (s: unknown) => {
          const st = s as { accountSize?: number; riskPctPerTrade?: number } | null;
          if (st?.accountSize && st.accountSize > 0)         acctSize    = st.accountSize;
          if (st?.riskPctPerTrade && st.riskPctPerTrade > 0) acctRiskPct = st.riskPctPerTrade;
        };
        if (lineUserId) {
          const { data: lp } = await lineAdmin
            .from('profiles').select('id, line_token, settings')
            .eq('line_user_id', lineUserId).maybeSingle();
          if (lp?.line_token) lineToken = lp.line_token;
          if (lp?.id) profileId = lp.id;
          if (lp?.settings) applySettings(lp.settings);
        }
        // Direct-UUID override: set SUPABASE_PROFILE_ID in Vercel env vars to bypass
        // line_user_id lookup (useful when line_user_id column is null or mismatched).
        if (!profileId && process.env.SUPABASE_PROFILE_ID) {
          profileId = process.env.SUPABASE_PROFILE_ID;
          console.log('[analyze] profileId resolved via SUPABASE_PROFILE_ID env var');
          try {
            const { data: sp } = await lineAdmin
              .from('profiles').select('settings').eq('id', profileId).maybeSingle();
            if (sp?.settings) applySettings(sp.settings);
          } catch { /* keep defaults */ }
        }
      } catch (e) {
        console.error('[analyze] profile lookup threw:', String(e));
        if (process.env.SUPABASE_PROFILE_ID) profileId = process.env.SUPABASE_PROFILE_ID;
      }
    }
    if (!profileId) {
      console.warn('[analyze] profileId is empty — trades will NOT be inserted. ' +
        'Set SUPABASE_PROFILE_ID env var in Vercel or ensure profiles.line_user_id matches LINE_USER_ID.');
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

  interface ScanResult {
    symbol: string;
    signalCount: number;
    topScore: number;
    rawTopScore?: number;
    topSignal: { direction: string; strength: string; score: number; entry: number; confidence?: number; fundingRate?: number } | null;
    lineSent: boolean;
    locked: boolean;
    confluenceMet?: boolean;
    agreeTFs?: number;
    tfsAnalyzed?: string[];
    regime?: string;
    btcRegime?: string;
    adx4h?: number | null;
    atrPercentile?: number;
    suggestedRiskPct?: number;
    fundingRate?: number;
    event_filter_active?: boolean;
    lineError?: string;
    note?: string;
    error?: string;
  }
  const results: ScanResult[] = [];
  const notified: string[] = [];
  // v2.1 §0: reject funnel — one record per candidate signal, sent or not
  const funnelEntries: Array<Record<string, unknown>> = [];
  // Rejected candidates with concrete levels → simulated as shadow trades
  const shadowCandidates: ShadowTrade[] = [];

  // §2.3 BTC regime — fetch once, apply to all altcoin signals
  const btcState = await fetchBtcRegime();

  // v2.1 §1.2: ADX hysteresis state — one hash for all symbols (1 read/scan).
  // Cross above 23 → trending until below 18; below 18 → ranging until above 23.
  // 18-23 without prior state (fresh symbol) = transitional (no signals).
  let adxStates: Record<string, string> = {};
  {
    const rAdx = getRedis();
    if (rAdx) {
      try { adxStates = (await rAdx.hgetall<Record<string, string>>('adx_states')) ?? {}; } catch { /* empty */ }
    }
  }
  const adxStateChanges: Record<string, string> = {};

  // §4.4 Circuit breaker — check once per cron run
  const breaker = profileId ? await checkCircuitBreaker(profileId) : { triggered: false };

  // Phase 5: total open risk — check once per cron run; blocks all new signals when cap is hit
  const totalOpenRisk = profileId ? await checkTotalOpenRisk(profileId) : 0;

  // Phase 6: event filter — blocks new signals ±30 min around scheduled events
  const eventFilter = await checkEventFilter();

  for (const symbol of coins) {
    const allSignals: TradingSignal[] = [];
    let topScore  = 0;
    let rawTopScore = 0; // best pre-gate score — shows near-misses in scan status
    let lineSent  = false;
    let lineError: string | undefined;
    let entryTfBias: 'LONG' | 'SHORT' | null = null; // entry TF's 4H EMA200 direction

    try {
      await fetchTicker24h(symbol).catch(() => null);

      // Candle cache so HTF candles are fetched only once even if reused across TFs
      const candleCache = new Map<string, Candle[]>();

      // ── Regime determination from 4H ADX (once per symbol) ─────
      // v2.1 §1.2 hysteresis: ADX ≥23 → trending (until ≤18); ≤18 → ranging
      // (until ≥23); 18-23 holds the previous state — transitional only when
      // a symbol has no prior state (initialization).
      // When 4H fetch fails, regimeDetermined stays false → fallback to Strategy A.
      let symbolRegime: Regime = 'ranging';
      let symbolAdx    = NaN;
      let regimeDetermined = false;
      try {
        // 540 bars = 90 days of 4H candles — enough for ADX regime + 90-day ATR percentile
        if (!candleCache.has('4h')) candleCache.set('4h', await fetchCandles(symbol, '4h', 540));
        const fourHC   = candleCache.get('4h')!;
        // Only ADX is needed here — computing full indicators (EMA200/MACD/BB/…)
        // over 540 bars every scan was the single biggest CPU sink.
        symbolAdx = calcAdx(fourHC, 14).adx ?? NaN;
        if (!isNaN(symbolAdx)) {
          regimeDetermined = true;
          if (symbolAdx >= 23)      symbolRegime = 'trending';
          else if (symbolAdx <= 18) symbolRegime = 'ranging';
          else {
            const prev = adxStates[symbol];
            symbolRegime = prev === 'trending' || prev === 'ranging' ? (prev as Regime) : 'transitional';
          }
          // Record state transitions (batched into one hset after the loop)
          if ((symbolRegime === 'trending' || symbolRegime === 'ranging') && adxStates[symbol] !== symbolRegime) {
            adxStateChanges[symbol] = symbolRegime;
            adxStates[symbol]       = symbolRegime;
          }
        }
      } catch { /* keep 'ranging' / regimeDetermined=false — Strategy A fallback */ }

      // ── Phase 5: 90-day ATR percentile → suggested position sizing ──
      // Uses the 540-bar 4H cache already populated above.
      let symbolAtrPct = 50; // default: mid-volatility
      try {
        const fourHC = candleCache.get('4h');
        if (fourHC && fourHC.length >= 30) {
          const atrHistory = calcAtrHistory(fourHC);
          if (atrHistory.length >= 2) {
            const currentAtr4h = atrHistory[atrHistory.length - 1];
            symbolAtrPct = calcAtrPercentile(currentAtr4h, atrHistory.slice(0, -1));
          }
        }
      } catch { /* keep default 50 */ }
      // >80th pct = high volatility → smaller risk; <30th = low vol → larger risk
      const suggestedRiskPct = symbolAtrPct > 80 ? 0.5 : symbolAtrPct < 30 ? 1.5 : 1.0;

      // ── Strategy B consecutive-loss pause check ──────────────
      let stratBPaused = false;
      if (symbolRegime === 'ranging' && regimeDetermined) {
        stratBPaused = await checkStratBPaused(symbol);
      }

      // ── Regime-based signal generation dispatch ───────────────
      // transitional → nothing | ranging+determined → Strategy B | else → Strategy A
      if (symbolRegime === 'transitional') {
        // ADX 20-25: no new signals; regime/adx4h will surface this in results
      } else if (symbolRegime === 'ranging' && regimeDetermined && !stratBPaused) {
        // Strategy B: mean reversion on entry TF only (BB + RSI crossover)
        try {
          if (!candleCache.has(entryTf)) candleCache.set(entryTf, await fetchCandles(symbol, entryTf, 200));
          const candles = candleCache.get(entryTf)!;
          const sigs    = generateMeanReversionSignals(symbol, entryTf, candles);
          allSignals.push(...sigs);
          sigs.forEach(s => { if (s.score > topScore) topScore = s.score; });
        } catch { /* skip */ }
      } else {
        // Strategy A: multi-TF loop (trending, or paused-B, or regime-fetch-failed → safe fallback)
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
                const htfPx  = htfC[htfC.length - 1].close;
                // Only EMA200 is needed for HTF bias — skip the full indicator set
                const htfCloses = htfC.map(c => c.close);
                const e200Arr   = calcEma(htfCloses, 200);
                const e200      = e200Arr[e200Arr.length - 1];
                if (!isNaN(e200) && e200 > 0) {
                  const near = Math.abs(htfPx - e200) / e200 < 0.015;
                  if (!near) htfBias = htfPx > e200 ? 'LONG' : 'SHORT';
                }
              } catch { /* no bias if HTF unavailable */ }
            }
            // Remember the entry TF's higher-timeframe bias — it acts as the
            // second confluence confirmation (§3-A: 4H judges direction, 1H enters).
            if (tf === entryTf) entryTfBias = htfBias;

            const dbg: { long?: number; short?: number } = {};
            const sigs = generateSignals(symbol, tf, candles, htfBias, symbolRegime, dbg);
            rawTopScore = Math.max(rawTopScore, dbg.long ?? 0, dbg.short ?? 0);
            allSignals.push(...sigs);
            sigs.forEach(s => { if (s.score > topScore) topScore = s.score; });
          } catch { /* skip failed timeframe */ }
        }
      }

      // ── Phase 4: Fetch funding rate (cached 10min) ───────────
      const symbolFundingRate = await fetchFundingRate(symbol).catch(() => 0);

      // Direction unification: highest TF's direction is master, drop conflicting signals
      const unified    = unifySignalDirection(allSignals);
      const strong     = unified.filter(s => s.score >= minScore).sort((a, b) => b.score - a.score);
      const topStrong  = strong.find(isStrongEnough);
      // Entry signal: only from the designated entry TF. Multi-TF confluence confirms direction;
      // this signal's entry/TP/SL are what get pushed to LINE and inserted into DB.
      let entrySignal = strong.find(s => isStrongEnough(s) && s.timeframe === entryTf);

      // Multi-TF confluence gate ─────────────────────────────────
      // Confirmed by either: (a) ≥2 TFs independently producing same-direction
      // signals, or (b) entry-TF signal aligned with its 4H EMA200 bias —
      // §3-A's design is exactly "4H judges direction, 1H finds entry", so a
      // full independent 4H signal is NOT required for confluence.
      const longTFSet  = new Set(allSignals.filter(s => s.direction === 'LONG').map(s => s.timeframe));
      const shortTFSet = new Set(allSignals.filter(s => s.direction === 'SHORT').map(s => s.timeframe));
      const masterDir  = topStrong?.direction ?? null;
      const agreeTFs   = masterDir === 'LONG' ? longTFSet.size
                       : masterDir === 'SHORT' ? shortTFSet.size : 0;
      const biasConfirmed  = !!masterDir && entryTfBias === masterDir;
      // Strategy B is single-TF by design (BB+RSI confirmation is its own confluence)
      const isStratBSignal = allSignals.some(s => s.strategy === 'B');
      const confluenceMet  = agreeTFs >= 2 || biasConfirmed || isStratBSignal;

      // ⚡短線 channel: a 15m signal at normal tier thresholds whose direction
      // matches the 4H bias becomes a scalp order when the entry TF (1h) has
      // no qualifying signal. 15m already passes the intraday hard gates
      // (candle-pattern confirmation + structure alignment); tight 15m stops
      // give larger notional at the same risk — the "small account compounding"
      // mechanic without raising risk per trade.
      let isScalp = false;
      if (!entrySignal && biasConfirmed) {
        const scalpSig = strong.find(s =>
          s.timeframe === '15m' &&
          isStrongEnough(s) &&
          s.direction === entryTfBias &&
          s.strategy !== 'B');
        if (scalpSig) {
          entrySignal = scalpSig;
          isScalp = true;
          scalpSig.reasons.push('⚡ 短線單：15m 訊號 + 4H 順向確認，適合快進快出');
        }
      }

      // Entry-TF fallback: an exceptional intraday signal (≥ threshold+10) whose
      // direction matches the 4H bias may substitute when the entry TF itself
      // has no qualifying signal — strong trends often move too fast for 1H
      // to score before the entry window closes.
      if (!entrySignal && biasConfirmed) {
        entrySignal = strong.find(s =>
          isStrongEnough(s) &&
          s.score >= STRONG_THRESHOLD + 10 &&
          s.direction === entryTfBias &&
          s.strategy !== 'B');
      }

      // ── Phase 4+5: Annotate unified signals with fundingRate, confidence, position sizing ──
      // confidence and suggestedRiskPct/Leverage are informational; gate stays score-based.
      unified.forEach(s => {
        s.fundingRate = symbolFundingRate;
        s.confidence  = computeConfidence(s, symbolAdx, symbolFundingRate, agreeTFs);
        // v2.1 §2: tier B = half risk (0.5%) and leverage ≤5x regardless of ATR percentile
        const tierRisk = s.tier === 'B' ? 0.5 : suggestedRiskPct;
        s.suggestedRiskPct = tierRisk;
        const slDist = s.entry > 0 ? Math.abs(s.entry - s.stopLoss) / s.entry : 0;
        const lev = slDist > 0
          ? Math.min(Math.round((tierRisk / 100 / slDist) * 10) / 10, 10)
          : 1;
        s.suggestedLeverage = s.tier === 'B' ? Math.min(lev, 5) : lev;
      });

      // Read lock from Redis (persistent across cold starts)
      const last      = await getLock(symbol);
      const nowBucket = current4hBucket();
      const now       = Date.now();

      const locked     = !!last && last.locked;
      const sameCandle = !!last && !locked && last.candleBucket === nowBucket && last.direction === topStrong?.direction;
      const onCooldown = !!last && !locked && (now - last.sentAt) < COOLDOWN_MS;

      let skipReason: string | undefined;
      let skipKey:    string | undefined; // v2.1 §0: machine-readable gate id for the reject funnel

      // Phase 6: event filter (global; checked before per-symbol risk gates)
      if (eventFilter.active)
        { skipKey = 'event_filter';   skipReason = eventFilter.reason ?? '事件過濾中，暫停新訊號'; }
      // §4.4 Circuit breaker (global; set once before loop, checked per signal)
      else if (breaker.triggered)
        { skipKey = 'circuit_breaker'; skipReason = `熔斷 — ${breaker.reason}`; }
      else if (totalOpenRisk >= MAX_TOTAL_RISK_PCT)
        { skipKey = 'total_risk_cap'; skipReason = `跳過 — 總持倉風險 ${totalOpenRisk.toFixed(1)}% 已達上限 ${MAX_TOTAL_RISK_PCT}%`; }
      else if (locked)
        { skipKey = 'locked';         skipReason = `跳過 — 持倉中 (${last?.direction})`; }
      else if (sameCandle)
        { skipKey = 'same_candle';    skipReason = `跳過 — 同 4h 蠟燭 (${topStrong?.direction})`; }
      else if (onCooldown && last)
        { skipKey = 'cooldown';       skipReason = `跳過 — 冷卻中 (${Math.round((COOLDOWN_MS - (now - last.sentAt)) / 60000)}min)`; }
      else if (topStrong && !confluenceMet)
        { skipKey = 'confluence';     skipReason = `跳過 — 多框架未確認 (${agreeTFs}/2 TF 同向，4H bias: ${entryTfBias ?? '中性'})`; }
      else if (topStrong && !entrySignal)
        { skipKey = 'no_entry_tf';    skipReason = `跳過 — 進場時區 (${entryTf}) 無合格信號（最高 ${topStrong.score}分@${topStrong.timeframe}，4H bias: ${entryTfBias ?? '中性'}）`; }
      else if (entrySignal) {
        const isLargeCap = symbol === 'BTCUSDT' || symbol === 'ETHUSDT';

        // §2.3 BTC regime filter (altcoins only)
        if (!isLargeCap && entrySignal.strategy === 'A') {
          if (btcState.regime === 'bullish' && entrySignal.direction === 'SHORT')
            { skipKey = 'btc_direction'; skipReason = `BTC 大盤偏多 — 跳過山寨做空趨勢單 (${symbol})`; }
          else if (btcState.regime === 'bearish' && entrySignal.direction === 'LONG')
            { skipKey = 'btc_direction'; skipReason = `BTC 大盤偏空 — 跳過山寨做多趨勢單 (${symbol})`; }
          else if (btcState.regime === 'chaotic') {
            // v2.1 §1.3: chaos downgrades instead of blocking — tier B,
            // risk 0.5%, confidence -10, leverage ≤5x. Counter-trend vs a
            // CLEAR BTC direction (branches above) is still hard-blocked.
            entrySignal.tier               = 'B';
            entrySignal.suggestedRiskPct   = 0.5;
            entrySignal.suggestedLeverage  = Math.min(entrySignal.suggestedLeverage ?? 5, 5);
            entrySignal.confidence         = Math.max(0, (entrySignal.confidence ?? 50) - 10);
            entrySignal.reasons.push('⚠ BTC 混沌區 — 降級 B 級輕倉（風險 0.5%、槓桿 ≤5x）');
          }
        }
        if (!skipReason && !isLargeCap) {
          if (entrySignal.direction === 'LONG'  && btcState.longPaused)
            { skipKey = 'btc_pause'; skipReason = `BTC 1H 異常急跌（${btcState.movePct ?? '?'}%，門檻 ±${btcState.moveThresholdPct ?? '?'}%）— ${symbol} 做多暫停 2h`; }
          else if (entrySignal.direction === 'SHORT' && btcState.shortPaused)
            { skipKey = 'btc_pause'; skipReason = `BTC 1H 異常急漲（${btcState.movePct ?? '?'}%，門檻 ±${btcState.moveThresholdPct ?? '?'}%）— ${symbol} 做空暫停 2h`; }
        }

        // Post-loss cooldown: this symbol+direction stopped out within 24h
        if (!skipReason && await isOnLossCooldown(symbol, entrySignal.direction)) {
          skipKey = 'loss_cooldown';
          skipReason = `跳過 — ${symbol} ${entrySignal.direction === 'LONG' ? '做多' : '做空'} 24h 內止損過，同向暫停一天`;
        }

        // §4.3 Same-direction risk cap（風險加權：A=1%、B=0.5%）
        if (!skipReason && profileId) {
          const sdCheck = await checkSameDirectionRisk(profileId, entrySignal.direction, symbol, entrySignal.tier);
          if (sdCheck.block) { skipKey = 'same_dir_cap'; skipReason = `跳過 — ${sdCheck.reason}`; }
        }

        // Hard-stop duplicate check
        if (!skipReason && profileId) {
          const _su = process.env.NEXT_PUBLIC_SUPABASE_URL  || '';
          const _sk = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
          if (_su && _sk) {
            try {
              const { createClient: mkChk } = await import('@supabase/supabase-js');
              const chk = mkChk(_su, _sk, { auth: { autoRefreshToken: false, persistSession: false } });
              // Symbol-global (no user_id filter): single-user system, and legacy
              // rows with NULL user_id must still block — 7/17 saw two overlapping
              // AKE longs slip past the user-scoped version of this check.
              const { count: c } = await chk.from('trades')
                .select('id', { count: 'exact', head: true })
                .eq('symbol', entrySignal.symbol).is('closed_at', null);
              if (c !== null && c > 0)
                { skipKey = 'has_open_position'; skipReason = `跳過 — 同幣種已有持倉 (${symbol})`; }
            } catch (e) {
              skipKey = 'dup_check_error';
              skipReason = `跳過 — 重複檢查失敗 (${String(e).slice(0, 80)})`;
              console.error(`[analyze] hard-stop check threw for ${symbol}:`, String(e));
            }
          }
        }
      }

      // ── Signal gate: DB record and notifications are fully decoupled from each other ──
      // profileId (Supabase user UUID) is the only identity requirement; LINE success is not.
      let gateNote: string | undefined; // surfaces insert failures in scan-status panel
      if (entrySignal && !!profileId && !locked && !sameCandle && !onCooldown && confluenceMet && !skipReason) {
        const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL  || '';
        const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
        const sp           = entrySignal.signalPrice ?? 0;
        const isLimitOrder = sp > 0 && Math.abs(entrySignal.entry - sp) / sp > 0.003;
        let insertOk = false;

        // ── Step 1: DB insert — gated only on DB creds + profileId ──────────────
        // LINE success is NOT required. Failure here is logged; lock is not set so next cron retries.
        if (sbUrl && sbKey) {
          try {
            const { createClient: mkAdmin } = await import('@supabase/supabase-js');
            const admin = mkAdmin(sbUrl, sbKey, { auth: { autoRefreshToken: false, persistSession: false } });

            // Final duplicate guard (Redis lock may be lost after Vercel cold start).
            // Symbol-global on purpose — see hard-stop duplicate check above.
            const { count } = await admin.from('trades')
              .select('id', { count: 'exact', head: true })
              .eq('symbol', entrySignal.symbol)
              .is('closed_at', null);

            if (count === 0) {
              const tradeId    = `trade-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
              const insertData = {
                id:           tradeId,
                user_id:      profileId,          // already-resolved UUID — no second profile lookup
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
                strategy:            entrySignal.strategy ?? 'A',
                regime:              entrySignal.regime ?? null,
                confidence:          entrySignal.confidence ?? null,
                funding_rate:        entrySignal.fundingRate ?? null,
                suggested_risk_pct:  entrySignal.suggestedRiskPct ?? null,
                suggested_leverage:  entrySignal.suggestedLeverage ?? null,
                tier:                entrySignal.tier ?? 'A',
                score_breakdown:     entrySignal.scoreBreakdown ?? null,
              };

              // Missing-column detection: PostgREST returns PGRST204 ("Could not
              // find the 'x' column in the schema cache") for unknown INSERT
              // columns — 42703 only appears on raw SQL / column-grant paths.
              const isMissingColumn = (code?: string, msg?: string) =>
                code === '42703' || code === 'PGRST204' || /column/i.test(msg ?? '');

              const ir = await admin.from('trades').insert(insertData);
              if (!ir.error) {
                insertOk = true;
              } else if (ir.error.code === '23505') {
                // Partial unique index (trades_one_open_per_symbol) blocked this insert —
                // a concurrent analyze already inserted an open trade for this symbol.
                // Treat as "already exists": don't set lock here; the winning instance will.
                console.log(`[analyze] concurrent insert blocked for ${entrySignal.symbol} (23505) — another cron won the race`);
              } else if (isMissingColumn(ir.error.code, ir.error.message)) {
                // Two-stage fallback so a single missing NEW column doesn't strip
                // columns that DO exist (status/signal_price own the limit-order flow).
                // Stage 1: drop v2.1+ columns (tier, score_breakdown); Stage 2: pre-migration base.
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const { tier: _tier1, score_breakdown: _sb1, ...noTierData } = insertData;
                const irT = await admin.from('trades').insert(noTierData);
                if (!irT.error) {
                  insertOk = true;
                  console.log(`[analyze] insert ok without v2.1 columns for ${entrySignal.symbol} — run: ALTER TABLE trades ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'A'; ALTER TABLE trades ADD COLUMN IF NOT EXISTS score_breakdown JSONB;`);
                } else if (irT.error.code === '23505') {
                  console.log(`[analyze] concurrent insert blocked for ${entrySignal.symbol} (23505/no-tier) — another cron won the race`);
                } else if (isMissingColumn(irT.error.code, irT.error.message)) {
                  // eslint-disable-next-line @typescript-eslint/no-unused-vars
                  const { status: _s, signal_price: _sp, strategy: _str, regime: _reg, confidence: _conf, funding_rate: _fr, suggested_risk_pct: _srp, suggested_leverage: _slev, tier: _tier, score_breakdown: _sb, ...baseData } = insertData;
                  const ir2 = await admin.from('trades').insert(baseData);
                  if (!ir2.error) {
                    insertOk = true;
                  } else if (ir2.error.code === '23505') {
                    console.log(`[analyze] concurrent insert blocked for ${entrySignal.symbol} (23505/fallback) — another cron won the race`);
                  } else {
                    console.error(`[analyze] trade insert failed for ${entrySignal.symbol}: [${ir2.error.code}] ${ir2.error.message}`);
                  }
                } else {
                  console.error(`[analyze] trade insert failed for ${entrySignal.symbol}: [${irT.error.code}] ${irT.error.message}`);
                }
              } else {
                console.error(`[analyze] trade insert failed for ${entrySignal.symbol}: [${ir.error.code}] ${ir.error.message}`);
              }
            }
          } catch (e) {
            console.error(`[analyze] trade insert threw for ${entrySignal.symbol}: ${String(e)}`);
          }
        } else {
          console.error(`[analyze] trade insert skipped for ${entrySignal.symbol} — DB not configured`);
        }

        if (!insertOk) gateNote = '⚠ 訊號達標但 DB 寫入失敗（詳見漏斗統計）';

        // ── Step 2: Lock + pending signals (only after trade is confirmed in DB) ──
        // Lock prevents re-triggering the same signal on the next cron cycle.
        // If insert failed above, lock is NOT set so the next cron can retry.
        if (insertOk) {
          notified.push(symbol);
          await setLock(symbol, {
            sentAt: now, candleBucket: nowBucket,
            direction: entrySignal.direction, locked: true,
          });
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

          // ── Step 3: Signal notifications — LINE and Web Push are independent ───
          // Either or both may fail without affecting the trade record or each other.
          if (lineToken && lineUserId) {
            const { ok, error } = await sendLineMessage(lineToken, lineUserId, buildFlexMessages(entrySignal));
            lineSent  = ok;
            lineError = error;
          }
          if (profileId) {
            const edir  = entrySignal.direction === 'LONG' ? '做多▲' : '做空▼';
            const esym  = entrySignal.symbol.replace('USDT', '/USDT');
            const eTier = entrySignal.tier === 'B' ? ' 🅱輕倉' : '';
            const eKind = isScalp ? ' ⚡短線' : '';
            // Concrete order instructions: notional / margin / leverage at the
            // user's synced account size (tier B = half risk, leverage ≤5x)
            const effRisk = acctRiskPct * (entrySignal.tier === 'B' ? 0.5 : 1);
            const plan = calcPositionPlan(acctSize, effRisk, entrySignal.entry, entrySignal.stopLoss, entrySignal.tier === 'B' ? 5 : 10);
            const planLine = plan ? `\n${formatPlanLine(plan)}｜止損虧 ${plan.riskUSDT}U` : '';
            await sendWebPushToUser(profileId, {
              title: `${edir} ${esym} 交易信號${eTier}${eKind}`,
              body: `${isLimitOrder ? '⏳掛單' : '🔴市場入場'} 進場 $${fmtPrice(entrySignal.entry)} ｜ TP1 $${fmtPrice(entrySignal.takeProfits[0])} ｜ SL $${fmtPrice(entrySignal.stopLoss)} ｜ ${entrySignal.score}分${planLine}`,
              tag: `signal-${entrySignal.id}`,
            });
          }

          // ── Step 4: Market-entry confirmation (market orders only) ───────────
          // Limit orders are confirmed by monitorActiveTrades when the fill candle appears.
          if (!isLimitOrder) {
            const dir     = entrySignal.direction === 'LONG' ? '做多▲' : '做空▼';
            const sym     = entrySignal.symbol.replace('USDT', '/USDT');
            const tp2     = entrySignal.takeProfits[1] ?? entrySignal.takeProfits[0];
            const effRisk = acctRiskPct * (entrySignal.tier === 'B' ? 0.5 : 1);
            const plan    = calcPositionPlan(acctSize, effRisk, entrySignal.entry, entrySignal.stopLoss, entrySignal.tier === 'B' ? 5 : 10);
            const planTxt = plan ? `\n${formatPlanLine(plan)}｜止損虧 ${plan.riskUSDT}U` : '';
            const entryMsg =
              `【✅ 市場入場】${sym}${isScalp ? '（⚡短線）' : ''}\n` +
              `${dir} 已進場\n` +
              `進場價：$${fmtPrice(entrySignal.entry)}\n` +
              `TP1：$${fmtPrice(entrySignal.takeProfits[0])}｜TP2：$${fmtPrice(tp2)}｜止損：$${fmtPrice(entrySignal.stopLoss)}` +
              planTxt;
            if (lineToken && lineUserId) {
              await sendLineWithRetry(lineToken, lineUserId, [{ type: 'text', text: entryMsg }]);
            }
            if (profileId) {
              await sendWebPushToUser(profileId, {
                title: `✅ 市場入場 ${sym}${isScalp ? ' ⚡短線' : ''}`,
                body: `${dir} $${fmtPrice(entrySignal.entry)} ｜ TP1 $${fmtPrice(entrySignal.takeProfits[0])} ｜ SL $${fmtPrice(entrySignal.stopLoss)}${plan ? ` ｜ ${formatPlanLine(plan)}` : ''}`,
                tag: `entry-${entrySignal.id}`,
              });
            }
          }
        }
      }

      // ── v2.1 §0: reject funnel — log every candidate regardless of outcome ──
      // Candidate = any qualifying signal existed OR raw score reached tier-B floor.
      if (topStrong || rawTopScore >= 55) {
        const signalSent = notified.includes(symbol);
        const rejectedAt = signalSent ? null
          : skipKey            ? skipKey
          : !topStrong         ? 'score_gate'
          : !profileId         ? 'no_profile'
          : 'insert_failed';
        funnelEntries.push({
          at: Date.now(),
          symbol,
          strategy:  topStrong?.strategy ?? 'A',
          direction: topStrong?.direction ?? null,
          rawScore:  Math.max(rawTopScore, topStrong?.score ?? 0),
          tier:      entrySignal?.tier ?? topStrong?.tier ?? null,
          rejectedAt,
          rejectDetail: skipReason
            ?? (rejectedAt === 'score_gate'    ? `原始分 ${rawTopScore} 未達門檻或組數不足`
              : rejectedAt === 'no_profile'    ? 'profileId 未解析，無法寫入 DB'
              : rejectedAt === 'insert_failed' ? 'DB 寫入失敗（見 Vercel logs）'
              : null),
          filters: {
            adx4h:          isNaN(symbolAdx) ? null : parseFloat(symbolAdx.toFixed(1)),
            regime:         symbolRegime,
            btcRegime:      btcState.regime,
            btcMovePct:     btcState.movePct ?? null,
            btcPausedLong:  btcState.longPaused,
            btcPausedShort: btcState.shortPaused,
            agreeTFs,
            entryTfBias,
            totalOpenRisk,
          },
        });

        // Shadow candidate: gate-rejected with concrete levels → simulate outcome
        const shadowSrc = entrySignal ?? topStrong;
        if (rejectedAt && SHADOW_GATES.has(rejectedAt) && shadowSrc) {
          const ssp = shadowSrc.signalPrice ?? 0;
          const isLimit = ssp > 0 && Math.abs(shadowSrc.entry - ssp) / ssp > 0.003;
          shadowCandidates.push({
            id: `shdw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            at: Date.now(),
            symbol,
            direction: shadowSrc.direction,
            timeframe: shadowSrc.timeframe,
            entry: shadowSrc.entry,
            stopLoss: shadowSrc.stopLoss,
            tp1: shadowSrc.takeProfits[0],
            tp2: shadowSrc.takeProfits[1] ?? shadowSrc.takeProfits[0],
            score: shadowSrc.score,
            tier: shadowSrc.tier ?? null,
            strategy: shadowSrc.strategy ?? 'A',
            rejectedAt,
            signalPrice: ssp,
            status: isLimit ? 'waiting' : 'active',
            ...(isLimit ? {} : { filledAt: Date.now() }),
            lastCheckedAt: Date.now(),
          });
        }
      }

      results.push({
        symbol,
        signalCount: strong.length,
        topScore,
        rawTopScore,
        topSignal: strong[0]
          ? { direction: strong[0].direction, strength: strong[0].strength, score: strong[0].score, entry: strong[0].entry, confidence: strong[0].confidence, fundingRate: strong[0].fundingRate }
          : null,
        lineSent,
        locked,
        confluenceMet,
        agreeTFs,
        tfsAnalyzed: timeframes.filter(tf => candleCache.has(tf)),
        regime: symbolRegime,
        btcRegime: btcState.regime,
        adx4h: isNaN(symbolAdx) ? null : parseFloat(symbolAdx.toFixed(2)),
        atrPercentile: symbolAtrPct,
        suggestedRiskPct,
        fundingRate: symbolFundingRate,
        event_filter_active: eventFilter.active,
        ...(lineError  ? { lineError }       : {}),
        ...(skipReason   ? { note: skipReason }
          : gateNote     ? { note: gateNote }
          : stratBPaused ? { note: '策略B連虧2筆暫停24h' }
          : {}),
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

  // Shadow simulation: merge new rejects, advance live ones against real candles
  await processShadowTrades(shadowCandidates);

  // v2.1 §0: flush reject-funnel entries (single batched lpush per scan)
  if (funnelEntries.length > 0) {
    const rf = getRedis();
    if (rf) {
      try {
        await rf.lpush('reject_funnel', ...funnelEntries.map(e => JSON.stringify(e)));
        await rf.ltrim('reject_funnel', 0, 1499);          // cap memory
        await rf.expire('reject_funnel', 14 * 24 * 3600);  // 14-day window
      } catch { /* non-fatal */ }
    }
  }

  // v2.1 §1.2: persist ADX hysteresis state transitions (single hset per scan)
  if (Object.keys(adxStateChanges).length > 0) {
    const rA = getRedis();
    if (rA) {
      try {
        await rA.hset('adx_states', adxStateChanges);
        await rA.expire('adx_states', 14 * 24 * 3600);
      } catch { /* non-fatal */ }
    }
  }

  // Persist scan summary so /api/scan-status (and the home-page panel) can show
  // why each coin was or wasn't signalled — spec §6 requires reject logs to be kept.
  {
    const rScan = getRedis();
    if (rScan) {
      try {
        await rScan.set('last_scan', {
          at: Date.now(),
          btcRegime: btcState.regime,
          circuitBreaker: breaker.triggered ? breaker.reason ?? true : null,
          eventFilter: eventFilter.active ? eventFilter.reason ?? true : null,
          totalOpenRisk: parseFloat(totalOpenRisk.toFixed(2)),
          notified,
          coins: results.map(r => ({
            symbol: r.symbol,
            topScore: r.topScore,
            rawTopScore: r.rawTopScore ?? 0,
            adx4h: r.adx4h ?? null,
            regime: r.regime ?? null,
            agreeTFs: r.agreeTFs ?? 0,
            note: r.note ?? r.error ?? null,
          })),
        }, { ex: 7200 });
      } catch { /* non-fatal — panel just shows stale data */ }
    }
  }

  return NextResponse.json({
    ok: true, analyzedAt: new Date().toISOString(),
    minScore, lineReady, usingRedis, coins: coins.length, notified, results,
    monitor,
    btcRegime: btcState.regime,
    circuitBreaker: breaker.triggered ? breaker.reason : null,
    totalOpenRisk: parseFloat(totalOpenRisk.toFixed(2)),
    eventFilter: { active: eventFilter.active, ...(eventFilter.reason ? { reason: eventFilter.reason } : {}) },
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
    // Reset ALL locks + risk-control state (breaker, BTC pause, loss cooldown).
    // ?scope=locks limits it to tlocks only; default clears everything.
    const scope = req.nextUrl.searchParams.get('scope');
    if (r) {
      try {
        const patterns = scope === 'locks'
          ? ['tlock:*']
          : ['tlock:*', 'circuit_breaker*', 'btc_pause:*', 'loss_cd:*'];
        const keyGroups = await Promise.all(patterns.map(p => r.keys(p)));
        const keys = keyGroups.flat();
        if (keys.length > 0) await Promise.all(keys.map(k => r.del(k)));
        return NextResponse.json({ ok: true, cleared: keys.length, scope: scope ?? 'all', usingRedis: true });
      } catch { /* fall through */ }
    }
    memLock.clear();
    memLossCd.clear();
    memBtcPause.long = 0; memBtcPause.short = 0;
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
