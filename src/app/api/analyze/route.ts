import { NextRequest, NextResponse } from 'next/server';
import { fetchCandles, fetchTicker24h } from '@/api/binance';
import { generateSignals } from '@/analysis/signals';
import { sendSignalToLine } from '@/lib/line';
import { Timeframe, TradingSignal } from '@/types';

// Called by UptimeRobot every N minutes
// GET /api/analyze?secret=YOUR_SECRET&coins=BTCUSDT,ETHUSDT
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret');
  const envSecret = process.env.WEBHOOK_SECRET;

  if (envSecret && secret !== envSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const coinsParam =
    req.nextUrl.searchParams.get('coins') ?? process.env.WATCH_COINS ?? 'BTCUSDT,ETHUSDT';
  const tfParam = process.env.ANALYSIS_TIMEFRAMES ?? '4h,1h';
  const lineToken = process.env.LINE_CHANNEL_TOKEN ?? '';
  const lineUserId = process.env.LINE_USER_ID ?? '';
  const minScore = parseInt(process.env.MIN_SCORE ?? '7', 10);

  const coins = coinsParam.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const timeframes = tfParam.split(',').map((s) => s.trim()) as Timeframe[];

  const results: {
    symbol: string;
    signalCount: number;
    topSignal: { direction: string; strength: string; score: number; entry: number } | null;
    error?: string;
  }[] = [];
  const notified: string[] = [];

  for (const symbol of coins) {
    const allSignals: TradingSignal[] = [];
    let topError: string | undefined;

    try {
      // Fetch price for context
      await fetchTicker24h(symbol).catch(() => null);

      for (const tf of timeframes) {
        try {
          const candles = await fetchCandles(symbol, tf, 200);
          allSignals.push(...generateSignals(symbol, tf, candles));
        } catch {
          // Skip failed timeframe, continue with others
        }
      }

      const strong = allSignals
        .filter((s) => s.score >= minScore)
        .sort((a, b) => b.score - a.score);

      if (strong.length > 0 && lineToken && lineUserId) {
        const sent = await sendSignalToLine(strong[0], lineToken, lineUserId);
        if (sent) notified.push(symbol);
      }

      results.push({
        symbol,
        signalCount: strong.length,
        topSignal: strong[0]
          ? {
              direction: strong[0].direction,
              strength: strong[0].strength,
              score: strong[0].score,
              entry: strong[0].entry,
            }
          : null,
      });
    } catch (err) {
      topError = err instanceof Error ? err.message : String(err);
      results.push({ symbol, signalCount: 0, topSignal: null, error: topError });
    }

    await delay(300);
  }

  return NextResponse.json({
    ok: true,
    analyzedAt: new Date().toISOString(),
    coins: coins.length,
    notified,
    results,
  });
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
