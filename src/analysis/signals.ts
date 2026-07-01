import { Candle, TradingSignal, SignalStrength, Timeframe, OrderBlock, FairValueGap, SRLevel } from '../types';
import { computeIndicators } from './indicators';
import { findOrderBlocks, findFairValueGaps, analyzeMarketStructure } from './smc';
import { findSRLevels, nearestSupport, nearestResistance } from './snr';

function simpleId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function scoreToStrength(score: number): SignalStrength {
  if (score >= 16) return 'STRONG';
  if (score >= 9)  return 'MODERATE';
  return 'WEAK';
}

function calcAtr(candles: Candle[], period = 14): number {
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function calcVolRatio(candles: Candle[]): number {
  const avg = candles.slice(-21, -1).reduce((a, c) => a + c.volume, 0) / 20;
  return avg > 0 ? candles[candles.length - 1].volume / avg : 1;
}

function calcEmaSlope(candles: Candle[], period: number, lookback = 5): 'up' | 'down' | 'flat' {
  const closes = candles.map((c) => c.close);
  const k = 2 / (period + 1);
  let val = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const hist: number[] = [];
  for (let i = period; i < closes.length; i++) {
    val = closes[i] * k + val * (1 - k);
    hist.push(val);
  }
  if (hist.length < lookback + 1) return 'flat';
  const pct = (hist[hist.length - 1] - hist[hist.length - 1 - lookback]) / hist[hist.length - 1 - lookback];
  if (pct > 0.002) return 'up';
  if (pct < -0.002) return 'down';
  return 'flat';
}

// ════════════════════════════════════════════════════════════
// Gate  : EMA200 position decides allowed direction.
//         ±1.5% zone around EMA200 → both directions scored,
//         highest wins.
// Score : Minimum 9 to fire a signal.
// RR    : Minimum 2.0.
// Stop  : ATR × 1.5 (dynamic).
// ════════════════════════════════════════════════════════════
const MIN_SCORE = 7;
const MIN_RR    = 1.8;

export function generateSignals(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
): TradingSignal[] {
  if (candles.length < 55) return [];

  const cur    = candles[candles.length - 1];
  const price  = cur.close;

  const ind       = computeIndicators(candles);
  const prevInd   = computeIndicators(candles.slice(0, -1));
  const structure = analyzeMarketStructure(candles);
  const obs       = findOrderBlocks(candles).filter((ob) => !ob.mitigated);
  const fvgs      = findFairValueGaps(candles).filter((f) => !f.filled);
  const srLevels  = findSRLevels(candles);

  const atrVal     = calcAtr(candles);
  const volRatio   = calcVolRatio(candles);
  const ema50Slope = calcEmaSlope(candles, 50);

  const aboveEma200     = price > ind.ema200;
  const ema20AboveEma50 = ind.ema20 > ind.ema50;
  // Within 1.5% of EMA200: allow both directions, let score decide
  const nearEma200  = Math.abs(price - ind.ema200) / ind.ema200 < 0.015;
  const allowLong   = aboveEma200 || nearEma200;
  const allowShort  = !aboveEma200 || nearEma200;

  const support    = nearestSupport(srLevels, price);
  const resistance = nearestResistance(srLevels, price);
  const signals: TradingSignal[] = [];

  // ── LONG SCORING ─────────────────────────────────────────
  let longScore = 0;
  const longReasons: string[] = [];
  let longOB:  OrderBlock | undefined;
  let longFVG: FairValueGap | undefined;
  let longSR:  SRLevel | undefined;

  if (allowLong) {
    // EMA200 position — more points when clearly above
    if (aboveEma200)       { longScore += 3; longReasons.push('EMA200 上方（多頭趨勢）'); }
    else if (nearEma200)   { longScore += 1; longReasons.push('EMA200 附近（關鍵支撐）'); }
    // Short-term momentum alignment
    if (ema20AboveEma50)   { longScore += 2; longReasons.push('EMA20 > EMA50（短期強勢）'); }
    if (ema50Slope === 'up') { longScore += 1; longReasons.push('EMA50 斜率向上'); }

    // Market structure
    if (structure.trend === 'bullish')                { longScore += 2; longReasons.push('結構做多（HH HL）'); }
    if (structure.lastBOS?.direction === 'bullish')   { longScore += 2; longReasons.push('BOS 突破向上'); }
    if (structure.lastChoCH?.direction === 'bullish') { longScore += 3; longReasons.push('ChoCH 轉多'); }
    if (structure.lastChoCH?.direction === 'bearish') longScore -= 2;

    // Order Block
    const bullOB = obs.find(
      (ob) => ob.type === 'bullish' && price >= ob.low * 0.999 && price <= ob.high * 1.005,
    );
    if (bullOB) {
      longScore += 3 + Math.min(bullOB.strength, 2);
      longReasons.push(`看漲 OB（強度 ${bullOB.strength}）`);
      longOB = bullOB;
    }

    // FVG
    const bullFVG = fvgs.find(
      (f) => f.type === 'bullish' && price >= f.bottom * 0.999 && price <= f.top * 1.001,
    );
    if (bullFVG) { longScore += 2; longReasons.push('看漲 FVG 回補'); longFVG = bullFVG; }

    // Support
    if (support && Math.abs(price - support.price) / price <= 0.015) {
      longScore += Math.min(support.touchCount, 4);
      longReasons.push(`支撐 $${support.price.toFixed(4)}（${support.touchCount} 次）`);
      longSR = support;
    }

    // RSI — buy dips, not breakouts
    if (ind.rsi < 35)      { longScore += 4; longReasons.push(`RSI 超賣 ${ind.rsi.toFixed(1)}`); }
    else if (ind.rsi < 50) { longScore += 2; longReasons.push(`RSI 回調 ${ind.rsi.toFixed(1)}`); }
    else if (ind.rsi > 70) longScore -= 3;

    // MACD
    if (ind.macdHistogram > 0 && ind.macd > ind.macdSignal) {
      longScore += 2; longReasons.push('MACD 黃金交叉');
    }
    if (ind.macdHistogram > 0 && ind.macdHistogram > prevInd.macdHistogram) {
      longScore += 1; longReasons.push('MACD 動能增強');
    }

    // Volume surge
    if (volRatio >= 1.5) { longScore += 2; longReasons.push(`量能放大 ${volRatio.toFixed(1)}×`); }

    // Candle body
    if ((cur.close - cur.open) / cur.open > 0.003) {
      longScore += 1; longReasons.push('看漲實體K線');
    }
  }

  // ── SHORT SCORING ────────────────────────────────────────
  let shortScore = 0;
  const shortReasons: string[] = [];
  let shortOB:  OrderBlock | undefined;
  let shortFVG: FairValueGap | undefined;
  let shortSR:  SRLevel | undefined;

  if (allowShort) {
    // EMA200 position
    if (!aboveEma200)       { shortScore += 3; shortReasons.push('EMA200 下方（空頭趨勢）'); }
    else if (nearEma200)    { shortScore += 1; shortReasons.push('EMA200 附近（關鍵阻力）'); }
    // Short-term momentum
    if (!ema20AboveEma50)   { shortScore += 2; shortReasons.push('EMA20 < EMA50（短期弱勢）'); }
    if (ema50Slope === 'down') { shortScore += 1; shortReasons.push('EMA50 斜率向下'); }

    // Market structure
    if (structure.trend === 'bearish')                 { shortScore += 2; shortReasons.push('結構做空（LH LL）'); }
    if (structure.lastBOS?.direction === 'bearish')    { shortScore += 2; shortReasons.push('BOS 向下突破'); }
    if (structure.lastChoCH?.direction === 'bearish')  { shortScore += 3; shortReasons.push('ChoCH 轉空'); }
    if (structure.lastChoCH?.direction === 'bullish')  shortScore -= 2;

    // Order Block
    const bearOB = obs.find(
      (ob) => ob.type === 'bearish' && price <= ob.high * 1.001 && price >= ob.low * 0.995,
    );
    if (bearOB) {
      shortScore += 3 + Math.min(bearOB.strength, 2);
      shortReasons.push(`看跌 OB（強度 ${bearOB.strength}）`);
      shortOB = bearOB;
    }

    // FVG
    const bearFVG = fvgs.find(
      (f) => f.type === 'bearish' && price >= f.bottom * 0.999 && price <= f.top * 1.001,
    );
    if (bearFVG) { shortScore += 2; shortReasons.push('看跌 FVG 回補'); shortFVG = bearFVG; }

    // Resistance
    if (resistance && Math.abs(price - resistance.price) / price <= 0.015) {
      shortScore += Math.min(resistance.touchCount, 4);
      shortReasons.push(`阻力 $${resistance.price.toFixed(4)}（${resistance.touchCount} 次）`);
      shortSR = resistance;
    }

    // RSI — short bounces, not capitulation
    if (ind.rsi > 65)      { shortScore += 4; shortReasons.push(`RSI 超買 ${ind.rsi.toFixed(1)}`); }
    else if (ind.rsi > 50) { shortScore += 2; shortReasons.push(`RSI 反彈 ${ind.rsi.toFixed(1)}`); }
    else if (ind.rsi < 30) shortScore -= 3;

    // MACD
    if (ind.macdHistogram < 0 && ind.macd < ind.macdSignal) {
      shortScore += 2; shortReasons.push('MACD 死亡交叉');
    }
    if (ind.macdHistogram < 0 && ind.macdHistogram < prevInd.macdHistogram) {
      shortScore += 1; shortReasons.push('MACD 跌勢加速');
    }

    // Volume
    if (volRatio >= 1.5) { shortScore += 2; shortReasons.push(`量能放大 ${volRatio.toFixed(1)}×`); }

    // Candle body
    if ((cur.open - cur.close) / cur.open > 0.003) {
      shortScore += 1; shortReasons.push('看跌實體K線');
    }
  }

  // ── BUILD SIGNALS ─────────────────────────────────────────
  const slBuffer = Math.max(atrVal * 1.5, price * 0.01);

  // LONG — only fires when clearly stronger than short
  if (longScore >= MIN_SCORE && longScore > shortScore) {
    const sl  = longOB  ? Math.min(longOB.low  * 0.995, price - slBuffer)
              : longSR  ? Math.min(longSR.price * 0.995, price - slBuffer)
              : price - slBuffer;
    const tp1 = resistance ? resistance.price : price + slBuffer * 2;
    const nextR = srLevels.find((l) => l.type === 'resistance' && l.price > tp1 * 1.005);
    const tp2   = nextR ? nextR.price : tp1 + (tp1 - price) * 0.618;
    const rr    = parseFloat(((tp1 - price) / Math.max(price - sl, 1e-6)).toFixed(2));
    if (rr >= MIN_RR) {
      signals.push({
        id: simpleId(), symbol, direction: 'LONG',
        strength: scoreToStrength(longScore), score: longScore,
        entry: price, takeProfits: [tp1, tp2], stopLoss: sl,
        riskReward: rr, timeframe, timestamp: Date.now(),
        reasons: longReasons, orderBlock: longOB, fvg: longFVG,
        srLevel: longSR ?? support ?? undefined, indicators: ind, isRead: false,
      });
    }
  }

  // SHORT — only fires when clearly stronger than long
  if (shortScore >= MIN_SCORE && shortScore > longScore) {
    const sl  = shortOB ? Math.max(shortOB.high * 1.005, price + slBuffer)
              : shortSR ? Math.max(shortSR.price * 1.005, price + slBuffer)
              : price + slBuffer;
    const tp1 = support ? support.price : price - slBuffer * 2;
    const nextS = srLevels.find((l) => l.type === 'support' && l.price < tp1 * 0.995);
    const tp2   = nextS ? nextS.price : tp1 - (price - tp1) * 0.618;
    const rr    = parseFloat(((price - tp1) / Math.max(sl - price, 1e-6)).toFixed(2));
    if (rr >= MIN_RR) {
      signals.push({
        id: simpleId(), symbol, direction: 'SHORT',
        strength: scoreToStrength(shortScore), score: shortScore,
        entry: price, takeProfits: [tp1, tp2], stopLoss: sl,
        riskReward: rr, timeframe, timestamp: Date.now(),
        reasons: shortReasons, orderBlock: shortOB, fvg: shortFVG,
        srLevel: shortSR ?? resistance ?? undefined, indicators: ind, isRead: false,
      });
    }
  }

  return signals;
}
