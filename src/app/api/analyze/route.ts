import { NextRequest, NextResponse } from 'next/server';
import { fetchCandles, fetchTicker24h } from '@/api/binance';
import { generateSignals } from '@/analysis/signals';
import { sendSignalToLine, sendLineMessage } from '@/lib/line';
import { Timeframe, TradingSignal } from '@/types';

// Called by UptimeRobot / cron-job.org every hour
// GET /api/analyze?secret=YOUR_SECRET&coins=BTCUSDT,ETHUSDT
export async function GET(req: NextRequest) {
  const secret    = req.nextUrl.searchParams.get('secret');
  const envSecret = process.env.WEBHOOK_SECRET;

  // Allow Vercel Cron (sends Authorization header) or secret param
  const cronAuth = req.headers.get('authorization');
  const isVercelCron = cronAuth === `Bearer ${process.env.CRON_SECRET}`;

  if (envSecret && secret !== envSecret && !isVercelCron) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const coinsParam  = req.nextUrl.searchParams.get('coins') ?? process.env.WATCH_COINS ?? 'BTCUSDT,ETHUSDT';
  const tfParam     = process.env.ANALYSIS_TIMEFRAMES ?? '4h,1h';
  const lineToken   = process.env.LINE_CHANNEL_TOKEN ?? '';
  const lineUserId  = process.env.LINE_USER_ID ?? '';
  const minScore    = parseInt(process.env.MIN_SCORE ?? '5', 10);

  const coins      = coinsParam.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const timeframes = tfParam.split(',').map((s) => s.trim()) as Timeframe[];

  // Validate LINE credentials early
  const lineReady = !!(lineToken && lineUserId);

  const results: {
    symbol: string;
    signalCount: number;
    topScore: number;
    topSignal: { direction: string; strength: string; score: number; entry: number } | null;
    lineSent: boolean;
    lineError?: string;
    error?: string;
  }[] = [];
  const notified: string[] = [];

  for (const symbol of coins) {
    const allSignals: TradingSignal[] = [];
    let topScore = 0;
    let lineSent = false;
    let lineError: string | undefined;
    let coinError: string | undefined;

    try {
      await fetchTicker24h(symbol).catch(() => null);

      for (const tf of timeframes) {
        try {
          const candles = await fetchCandles(symbol, tf, 200);
          const sigs = generateSignals(symbol, tf, candles);
          allSignals.push(...sigs);
          sigs.forEach((s) => { if (s.score > topScore) topScore = s.score; });
        } catch {
          // skip failed timeframe
        }
      }
      // topScore=0 means gates blocked all signals; report raw candle count for diagnostics
      if (topScore === 0 && allSignals.length === 0) topScore = -1;

      const strong = allSignals
        .filter((s) => s.score >= minScore)
        .sort((a, b) => b.score - a.score);

      if (strong.length > 0 && lineReady) {
        const { ok, error } = await sendLineMessage(lineToken, lineUserId, buildFlexMessages(strong[0]));
        lineSent  = ok;
        lineError = error;
        if (ok) notified.push(symbol);
      }

      results.push({
        symbol,
        signalCount: strong.length,
        topScore,
        topSignal: strong[0]
          ? { direction: strong[0].direction, strength: strong[0].strength, score: strong[0].score, entry: strong[0].entry }
          : null,
        lineSent,
        ...(lineError ? { lineError } : {}),
      });
    } catch (err) {
      coinError = err instanceof Error ? err.message : String(err);
      results.push({ symbol, signalCount: 0, topScore, topSignal: null, lineSent: false, error: coinError });
    }

    await delay(300);
  }

  return NextResponse.json({
    ok: true,
    analyzedAt: new Date().toISOString(),
    minScore,
    lineReady,
    coins: coins.length,
    notified,
    results,
  });
}

function buildFlexMessages(signal: TradingSignal): object[] {
  // Inline import to avoid circular deps — re-use the builder from lib/line
  const { buildLineFlexMessage } = require('@/lib/line');
  const flex = buildLineFlexMessage(signal);
  const coin = signal.symbol.replace('USDT', '/USDT');
  const dir  = signal.direction === 'LONG' ? '做多▲' : '做空▼';
  return [{ type: 'flex', altText: `${dir} ${coin} 交易信號 | 得分 ${signal.score} | RR ${signal.riskReward}:1`, contents: flex }];
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
