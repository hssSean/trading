import { NextRequest, NextResponse } from 'next/server';
import { fetchCandles } from '@/api/binance';
import { computeIndicators } from '@/analysis/indicators';
import { findOrderBlocks, findFairValueGaps, analyzeMarketStructure } from '@/analysis/smc';
import { findSRLevels, nearestSupport, nearestResistance } from '@/analysis/snr';
import { Timeframe, Candle } from '@/types';

// GET /api/debug-score?secret=abc123&symbol=BTCUSDT&tf=4h
// Returns raw longScore and shortScore before threshold filtering
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret');
  if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const symbol = (req.nextUrl.searchParams.get('symbol') ?? 'BTCUSDT').toUpperCase();
  const tf     = (req.nextUrl.searchParams.get('tf') ?? '4h') as Timeframe;

  try {
    const candles = await fetchCandles(symbol, tf, 200);
    const score   = debugScore(symbol, tf, candles);
    return NextResponse.json({ symbol, tf, ...score });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

function debugScore(symbol: string, tf: Timeframe, candles: Candle[]) {
  const cur   = candles[candles.length - 1];
  const price = cur.close;

  const ind       = computeIndicators(candles);
  const prevInd   = computeIndicators(candles.slice(0, -1));
  const structure = analyzeMarketStructure(candles);
  const obs       = findOrderBlocks(candles).filter((ob) => !ob.mitigated);
  const fvgs      = findFairValueGaps(candles).filter((f) => !f.filled);
  const srLevels  = findSRLevels(candles);

  const aboveEma200     = price > ind.ema200;
  const nearEma200      = Math.abs(price - ind.ema200) / ind.ema200 < 0.015;
  const ema20AboveEma50 = ind.ema20 > ind.ema50;

  const support    = nearestSupport(srLevels, price);
  const resistance = nearestResistance(srLevels, price);

  // ── Raw LONG score ──
  const longFactors: string[] = [];
  let longScore = 0;
  if (aboveEma200)       { longScore += 3; longFactors.push('+3 EMA200 上方'); }
  else if (nearEma200)   { longScore += 1; longFactors.push('+1 EMA200 附近'); }
  if (ema20AboveEma50)   { longScore += 2; longFactors.push('+2 EMA20>EMA50'); }
  if (structure.trend === 'bullish')                { longScore += 2; longFactors.push('+2 結構看漲'); }
  if (structure.lastBOS?.direction === 'bullish')   { longScore += 2; longFactors.push('+2 BOS上'); }
  if (structure.lastChoCH?.direction === 'bullish') { longScore += 3; longFactors.push('+3 ChoCH轉多'); }
  if (structure.lastChoCH?.direction === 'bearish') { longScore -= 2; longFactors.push('-2 ChoCH轉空'); }
  const bullOB = obs.find((ob) => ob.type === 'bullish' && price >= ob.low * 0.999 && price <= ob.high * 1.005);
  if (bullOB) { longScore += 3 + Math.min(bullOB.strength, 2); longFactors.push(`+${3+Math.min(bullOB.strength,2)} 看漲OB`); }
  const bullFVG = fvgs.find((f) => f.type === 'bullish' && price >= f.bottom * 0.999 && price <= f.top * 1.001);
  if (bullFVG) { longScore += 2; longFactors.push('+2 看漲FVG'); }
  if (support && Math.abs(price - support.price) / price <= 0.015) {
    const pts = Math.min(support.touchCount, 4);
    longScore += pts; longFactors.push(`+${pts} 支撐(${support.touchCount}次)`);
  }
  if (ind.rsi < 35)      { longScore += 4; longFactors.push(`+4 RSI超賣(${ind.rsi.toFixed(1)})`); }
  else if (ind.rsi < 50) { longScore += 2; longFactors.push(`+2 RSI回調(${ind.rsi.toFixed(1)})`); }
  else if (ind.rsi > 70) { longScore -= 3; longFactors.push(`-3 RSI超買(${ind.rsi.toFixed(1)})`); }
  if (ind.macdHistogram > 0 && ind.macd > ind.macdSignal) { longScore += 2; longFactors.push('+2 MACD黃金交叉'); }
  if (ind.macdHistogram > 0 && ind.macdHistogram > prevInd.macdHistogram) { longScore += 1; longFactors.push('+1 MACD動能增強'); }

  // ── Raw SHORT score ──
  const shortFactors: string[] = [];
  let shortScore = 0;
  if (!aboveEma200)      { shortScore += 3; shortFactors.push('+3 EMA200 下方'); }
  else if (nearEma200)   { shortScore += 1; shortFactors.push('+1 EMA200 附近'); }
  if (!ema20AboveEma50)  { shortScore += 2; shortFactors.push('+2 EMA20<EMA50'); }
  if (structure.trend === 'bearish')                 { shortScore += 2; shortFactors.push('+2 結構看跌'); }
  if (structure.lastBOS?.direction === 'bearish')    { shortScore += 2; shortFactors.push('+2 BOS下'); }
  if (structure.lastChoCH?.direction === 'bearish')  { shortScore += 3; shortFactors.push('+3 ChoCH轉空'); }
  if (structure.lastChoCH?.direction === 'bullish')  { shortScore -= 2; shortFactors.push('-2 ChoCH轉多'); }
  const bearOB = obs.find((ob) => ob.type === 'bearish' && price <= ob.high * 1.001 && price >= ob.low * 0.995);
  if (bearOB) { shortScore += 3 + Math.min(bearOB.strength, 2); shortFactors.push(`+${3+Math.min(bearOB.strength,2)} 看跌OB`); }
  if (resistance && Math.abs(price - resistance.price) / price <= 0.015) {
    const pts = Math.min(resistance.touchCount, 4);
    shortScore += pts; shortFactors.push(`+${pts} 阻力(${resistance.touchCount}次)`);
  }
  if (ind.rsi > 65)      { shortScore += 4; shortFactors.push(`+4 RSI超買(${ind.rsi.toFixed(1)})`); }
  else if (ind.rsi > 50) { shortScore += 2; shortFactors.push(`+2 RSI反彈(${ind.rsi.toFixed(1)})`); }
  else if (ind.rsi < 30) { shortScore -= 3; shortFactors.push(`-3 RSI超賣(${ind.rsi.toFixed(1)})`); }
  if (ind.macdHistogram < 0 && ind.macd < ind.macdSignal) { shortScore += 2; shortFactors.push('+2 MACD死叉'); }
  if (ind.macdHistogram < 0 && ind.macdHistogram < prevInd.macdHistogram) { shortScore += 1; shortFactors.push('+1 MACD跌勢加速'); }

  return {
    price,
    ema200: ind.ema200,
    ema50: ind.ema50,
    ema20: ind.ema20,
    rsi: ind.rsi,
    macdHistogram: ind.macdHistogram,
    aboveEma200,
    nearEma200,
    allowLong:  aboveEma200 || nearEma200,
    allowShort: !aboveEma200 || nearEma200,
    structure: { trend: structure.trend, lastBOS: structure.lastBOS?.direction ?? null, lastChoCH: structure.lastChoCH?.direction ?? null },
    longScore,
    longFactors,
    shortScore,
    shortFactors,
    minScoreNeeded: 7,
    wouldFireLong:  longScore >= 7 && longScore > shortScore,
    wouldFireShort: shortScore >= 7 && shortScore > longScore,
  };
}
