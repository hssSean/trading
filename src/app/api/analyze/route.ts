import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { fetchCandles, fetchTicker24h, fetchTopCoinsByVolume } from '@/api/binance';
import { computeIndicators } from '@/analysis/indicators';
import { generateSignals, unifySignalDirection } from '@/analysis/signals';
import { Candle } from '@/types';
import { sendLineMessage } from '@/lib/line';
import { Timeframe, TradingSignal } from '@/types';

export const maxDuration = 60;

const HTF_MAP: Partial<Record<Timeframe, Timeframe>> = {
  '15m': '1h', '1h': '4h', '4h': '1d',
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
const LOCK_TTL_SEC  = 7 * 24 * 3600; // 7-day failsafe expiry
const COOLDOWN_MS   = 6 * 60 * 60 * 1000;
const STRONG_THRESHOLD = 16;

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

function checkAuth(req: NextRequest): boolean {
  const secret       = req.nextUrl.searchParams.get('secret');
  const envSecret    = process.env.WEBHOOK_SECRET;
  const cronAuth     = req.headers.get('authorization');
  const isVercelCron = cronAuth === `Bearer ${process.env.CRON_SECRET}`;
  if (envSecret && secret !== envSecret && !isVercelCron) return false;
  return true;
}

// ── GET — run analysis + send LINE ────────────────────────────
export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const coinsParam = req.nextUrl.searchParams.get('coins') ?? process.env.WATCH_COINS ?? '';
  const tfParam    = process.env.ANALYSIS_TIMEFRAMES ?? '4h,1h';
  const lineToken  = process.env.LINE_CHANNEL_TOKEN ?? '';
  const lineUserId = process.env.LINE_USER_ID ?? '';
  const minScore   = parseInt(process.env.MIN_SCORE ?? '5', 10);

  const coins: string[] = coinsParam
    ? coinsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    : await getDefaultCoins();

  const timeframes = tfParam.split(',').map(s => s.trim()) as Timeframe[];
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
              if (!candleCache.has(htfTf)) candleCache.set(htfTf, await fetchCandles(symbol, htfTf, 100));
              const htfC   = candleCache.get(htfTf)!;
              const htfInd = computeIndicators(htfC);
              const htfPx  = htfC[htfC.length - 1].close;
              const near   = Math.abs(htfPx - htfInd.ema200) / htfInd.ema200 < 0.015;
              if (!near) htfBias = htfPx > htfInd.ema200 ? 'LONG' : 'SHORT';
            } catch { /* no bias if HTF unavailable */ }
          }

          const sigs = generateSignals(symbol, tf, candles, htfBias);
          allSignals.push(...sigs);
          sigs.forEach(s => { if (s.score > topScore) topScore = s.score; });
        } catch { /* skip failed timeframe */ }
      }

      // Direction unification: highest TF's direction is master, drop conflicting signals
      const unified   = unifySignalDirection(allSignals);
      const strong    = unified.filter(s => s.score >= minScore).sort((a, b) => b.score - a.score);
      const topStrong = strong.find(s => s.score >= STRONG_THRESHOLD);

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

      if (topStrong && lineReady && !locked && !sameCandle && !onCooldown) {
        const { ok, error } = await sendLineMessage(lineToken, lineUserId, buildFlexMessages(topStrong));
        lineSent  = ok;
        lineError = error;
        if (ok) {
          notified.push(symbol);
          await setLock(symbol, {
            sentAt: now, candleBucket: nowBucket,
            direction: topStrong.direction, locked: true,
          });
          // Persist pending signal in Redis so client can reliably pick it up
          const rp = getRedis();
          if (rp) {
            try {
              await rp.lpush('pending_signals', topStrong);
              await rp.expire('pending_signals', 24 * 3600);
            } catch { pendingSignals.push(topStrong); }
          } else {
            pendingSignals.push(topStrong);
            if (pendingSignals.length > 50) pendingSignals.splice(0, pendingSignals.length - 50);
          }
        }
      }

      results.push({
        symbol, signalCount: strong.length, topScore,
        topSignal: strong[0]
          ? { direction: strong[0].direction, strength: strong[0].strength, score: strong[0].score, entry: strong[0].entry }
          : null,
        lineSent, locked,
        ...(lineError  ? { lineError }       : {}),
        ...(skipReason ? { note: skipReason } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ symbol, signalCount: 0, topScore, topSignal: null, lineSent: false, locked: false, error: msg });
    }

    await delay(300);
  }

  return NextResponse.json({
    ok: true, analyzedAt: new Date().toISOString(),
    minScore, lineReady, usingRedis, coins: coins.length, notified, results,
  });
}

// ── POST — return pending signals for client auto-journal ──────
export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24h window
  const r = getRedis();
  if (r) {
    try {
      const signals = await r.lrange<TradingSignal>('pending_signals', 0, -1);
      await r.del('pending_signals');
      const filtered = signals.filter(s => s && s.timestamp > cutoff);
      return NextResponse.json({ ok: true, signals: filtered, source: 'redis' });
    } catch { /* fall through to in-memory */ }
  }
  const signals = pendingSignals.splice(0).filter(s => s.timestamp > cutoff);
  return NextResponse.json({ ok: true, signals, source: 'memory' });
}

// ── DELETE — unlock coin (called when trade is closed) ─────────
export async function DELETE(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const symbol = req.nextUrl.searchParams.get('symbol')?.toUpperCase();
  if (symbol) await unlockSymbol(symbol);
  return NextResponse.json({ ok: true, symbol, unlocked: true, usingRedis: !!getRedis() });
}

function buildFlexMessages(signal: TradingSignal): object[] {
  const { buildLineFlexMessage } = require('@/lib/line');
  const flex = buildLineFlexMessage(signal);
  const coin = signal.symbol.replace('USDT', '/USDT');
  const dir  = signal.direction === 'LONG' ? '做多▲' : '做空▼';
  return [{ type: 'flex', altText: `${dir} ${coin} 交易信號 | 得分 ${signal.score} | RR ${signal.riskReward}:1`, contents: flex }];
}

function delay(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}
