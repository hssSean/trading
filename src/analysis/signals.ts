import { Candle, TradingSignal, SignalStrength, Timeframe, OrderBlock, FairValueGap, SRLevel } from '../types';
import { computeIndicators } from './indicators';
import { findOrderBlocks, findFairValueGaps, analyzeMarketStructure } from './smc';
import { findSRLevels, nearestSupport, nearestResistance } from './snr';

function simpleId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function scoreToStrength(score: number): SignalStrength {
  if (score >= 12) return 'STRONG';
  if (score >= 7)  return 'MODERATE';
  return 'WEAK';
}

// Dynamic proximity: wider for volatile/cheap coins
function proximity(price: number): number {
  if (price < 1)    return 0.025; // small caps: ±2.5%
  if (price < 100)  return 0.018;
  return 0.015; // BTC/ETH: ±1.5%
}

function isNear(price: number, level: number): boolean {
  return Math.abs(price - level) / price <= proximity(price);
}

const MIN_SCORE = 7;
const MIN_RR    = 1.5;

export function generateSignals(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
): TradingSignal[] {
  if (candles.length < 50) return [];

  const currentCandle = candles[candles.length - 1];
  const prevCandle    = candles[candles.length - 2];
  const currentPrice  = currentCandle.close;

  const indicators  = computeIndicators(candles);
  const structure   = analyzeMarketStructure(candles);
  const orderBlocks = findOrderBlocks(candles).filter((ob) => !ob.mitigated);
  const fvgs        = findFairValueGaps(candles).filter((f) => !f.filled);
  const srLevels    = findSRLevels(candles);

  const signals: TradingSignal[] = [];

  // ──────────────────────────────────────────────────────────────────
  // LONG SIGNAL SCORING
  // ──────────────────────────────────────────────────────────────────
  let longScore = 0;
  const longReasons: string[] = [];
  let longOB:  OrderBlock | undefined;
  let longFVG: FairValueGap | undefined;
  let longSR:  SRLevel | undefined;

  // Market structure
  if (structure.trend === 'bullish')                 { longScore += 2; longReasons.push('趨勢向上 (看漲結構)'); }
  if (structure.lastBOS?.direction === 'bullish')    { longScore += 3; longReasons.push('突破結構 BOS ↑'); }
  if (structure.lastChoCH?.direction === 'bullish')  { longScore += 4; longReasons.push('結構轉換 ChoCH → 看漲'); }

  // Order Block — price touching or inside bullish OB
  const nearBullOB = orderBlocks.find(
    (ob) => ob.type === 'bullish' && currentPrice >= ob.low && currentPrice <= ob.high * 1.01,
  );
  if (nearBullOB) {
    longScore += 3 + nearBullOB.strength;
    longReasons.push(`看漲訂單塊 OB (強度 ${nearBullOB.strength})`);
    longOB = nearBullOB;
  }

  // FVG — price inside bullish fair value gap
  const inBullFVG = fvgs.find(
    (f) => f.type === 'bullish' && currentPrice >= f.bottom && currentPrice <= f.top,
  );
  if (inBullFVG) {
    longScore += 2;
    longReasons.push('位於看漲 FVG 公平價值缺口內');
    longFVG = inBullFVG;
  }

  // SNR support
  const support = nearestSupport(srLevels, currentPrice);
  if (support && isNear(currentPrice, support.price)) {
    longScore += Math.min(1 + support.touchCount, 5); // cap at +5
    longReasons.push(`支撐位 $${support.price.toFixed(4)} (觸碰 ${support.touchCount} 次)`);
    longSR = support;
  }

  // RSI
  if (indicators.rsi < 30)      { longScore += 4; longReasons.push(`RSI 超賣 (${indicators.rsi.toFixed(1)})`); }
  else if (indicators.rsi < 40) { longScore += 2; longReasons.push(`RSI 偏低 (${indicators.rsi.toFixed(1)})`); }
  else if (indicators.rsi > 70)   longScore -= 2;

  // MACD
  if (indicators.macdHistogram > 0 && indicators.macd > indicators.macdSignal) {
    longScore += 2;
    longReasons.push('MACD 黃金交叉 ↑');
  }
  // Histogram expanding (momentum building)
  const prevInd = candles.length > 3 ? computeIndicators(candles.slice(0, -1)) : null;
  if (prevInd && indicators.macdHistogram > 0 && indicators.macdHistogram > prevInd.macdHistogram) {
    longScore += 1;
    longReasons.push('MACD 動能增強');
  }

  // EMA alignment
  if (currentPrice > indicators.ema200) { longScore += 2; longReasons.push('價格在 EMA200 上方'); }
  if (currentPrice > indicators.ema50)  { longScore += 1; longReasons.push('價格在 EMA50 上方'); }
  if (currentPrice > indicators.ema20)    longScore += 1;

  // Bullish candle confirmation
  if (currentCandle.close > currentCandle.open && currentCandle.close > prevCandle.close) {
    longScore += 1;
    longReasons.push('看漲K線確認');
  }

  // ──────────────────────────────────────────────────────────────────
  // SHORT SIGNAL SCORING
  // ──────────────────────────────────────────────────────────────────
  let shortScore = 0;
  const shortReasons: string[] = [];
  let shortOB:  OrderBlock | undefined;
  let shortFVG: FairValueGap | undefined;
  let shortSR:  SRLevel | undefined;

  if (structure.trend === 'bearish')                { shortScore += 2; shortReasons.push('趨勢向下 (看跌結構)'); }
  if (structure.lastBOS?.direction === 'bearish')   { shortScore += 3; shortReasons.push('突破結構 BOS ↓'); }
  if (structure.lastChoCH?.direction === 'bearish') { shortScore += 4; shortReasons.push('結構轉換 ChoCH → 看跌'); }

  const nearBearOB = orderBlocks.find(
    (ob) => ob.type === 'bearish' && currentPrice <= ob.high && currentPrice >= ob.low * 0.99,
  );
  if (nearBearOB) {
    shortScore += 3 + nearBearOB.strength;
    shortReasons.push(`看跌訂單塊 OB (強度 ${nearBearOB.strength})`);
    shortOB = nearBearOB;
  }

  const inBearFVG = fvgs.find(
    (f) => f.type === 'bearish' && currentPrice >= f.bottom && currentPrice <= f.top,
  );
  if (inBearFVG) {
    shortScore += 2;
    shortReasons.push('位於看跌 FVG 公平價值缺口內');
    shortFVG = inBearFVG;
  }

  const resistance = nearestResistance(srLevels, currentPrice);
  if (resistance && isNear(currentPrice, resistance.price)) {
    shortScore += Math.min(1 + resistance.touchCount, 5);
    shortReasons.push(`阻力位 $${resistance.price.toFixed(4)} (觸碰 ${resistance.touchCount} 次)`);
    shortSR = resistance;
  }

  if (indicators.rsi > 70)      { shortScore += 4; shortReasons.push(`RSI 超買 (${indicators.rsi.toFixed(1)})`); }
  else if (indicators.rsi > 60) { shortScore += 2; shortReasons.push(`RSI 偏高 (${indicators.rsi.toFixed(1)})`); }
  else if (indicators.rsi < 30)   shortScore -= 2;

  if (indicators.macdHistogram < 0 && indicators.macd < indicators.macdSignal) {
    shortScore += 2;
    shortReasons.push('MACD 死亡交叉 ↓');
  }
  if (prevInd && indicators.macdHistogram < 0 && indicators.macdHistogram < prevInd.macdHistogram) {
    shortScore += 1;
    shortReasons.push('MACD 跌勢動能增強');
  }

  if (currentPrice < indicators.ema200) { shortScore += 2; shortReasons.push('價格在 EMA200 下方'); }
  if (currentPrice < indicators.ema50)  { shortScore += 1; shortReasons.push('價格在 EMA50 下方'); }
  if (currentPrice < indicators.ema20)    shortScore += 1;

  if (currentCandle.close < currentCandle.open && currentCandle.close < prevCandle.close) {
    shortScore += 1;
    shortReasons.push('看跌K線確認');
  }

  // ──────────────────────────────────────────────────────────────────
  // BUILD SIGNALS
  // ──────────────────────────────────────────────────────────────────

  // LONG
  if (longScore >= MIN_SCORE && longScore >= shortScore) {
    const sl = longOB
      ? longOB.low * 0.997
      : longSR
      ? longSR.price * 0.997
      : currentPrice * 0.97;

    const tp1 = resistance ? resistance.price : currentPrice * (1 + defaultTP(timeframe));
    const nextRes = srLevels.find((l) => l.type === 'resistance' && l.price > tp1 * 1.002);
    const tp2     = nextRes ? nextRes.price : tp1 * (1 + defaultTP(timeframe) * 0.5);

    const rr = parseFloat(((tp1 - currentPrice) / Math.max(currentPrice - sl, 0.0001)).toFixed(2));
    if (rr >= MIN_RR) {
      signals.push({
        id: simpleId(),
        symbol,
        direction: 'LONG',
        strength: scoreToStrength(longScore),
        score: longScore,
        entry: currentPrice,
        takeProfits: [tp1, tp2],
        stopLoss: sl,
        riskReward: rr,
        timeframe,
        timestamp: Date.now(),
        reasons: longReasons,
        orderBlock: longOB,
        fvg: longFVG,
        srLevel: longSR ?? support ?? undefined,
        indicators,
        isRead: false,
      });
    }
  }

  // SHORT
  if (shortScore >= MIN_SCORE && shortScore > longScore) {
    const sl = shortOB
      ? shortOB.high * 1.003
      : shortSR
      ? shortSR.price * 1.003
      : currentPrice * 1.03;

    const tp1 = support ? support.price : currentPrice * (1 - defaultTP(timeframe));
    const nextSup = srLevels.find((l) => l.type === 'support' && l.price < tp1 * 0.998);
    const tp2     = nextSup ? nextSup.price : tp1 * (1 - defaultTP(timeframe) * 0.5);

    const rr = parseFloat(((currentPrice - tp1) / Math.max(sl - currentPrice, 0.0001)).toFixed(2));
    if (rr >= MIN_RR) {
      signals.push({
        id: simpleId(),
        symbol,
        direction: 'SHORT',
        strength: scoreToStrength(shortScore),
        score: shortScore,
        entry: currentPrice,
        takeProfits: [tp1, tp2],
        stopLoss: sl,
        riskReward: rr,
        timeframe,
        timestamp: Date.now(),
        reasons: shortReasons,
        orderBlock: shortOB,
        fvg: shortFVG,
        srLevel: shortSR ?? resistance ?? undefined,
        indicators,
        isRead: false,
      });
    }
  }

  return signals;
}

// Default TP distance by timeframe (as fraction of price)
function defaultTP(tf: Timeframe): number {
  switch (tf) {
    case '15m': return 0.015;
    case '1h':  return 0.025;
    case '4h':  return 0.04;
    case '1d':  return 0.08;
  }
}
