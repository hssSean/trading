import { Candle, TradingSignal, SignalStrength, Timeframe, OrderBlock, FairValueGap, SRLevel } from '../types';
import { computeIndicators, rsi as rsiCalc } from './indicators';
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

// ── Candle pattern recognition ────────────────────────────────
function detectCandlePatterns(candles: Candle[]): {
  bullishEngulfing: boolean;
  bearishEngulfing: boolean;
  hammer: boolean;
  shootingStar: boolean;
} {
  if (candles.length < 3) {
    return { bullishEngulfing: false, bearishEngulfing: false, hammer: false, shootingStar: false };
  }
  const cur  = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const curBody   = Math.abs(cur.close  - cur.open);
  const prevBody  = Math.abs(prev.close - prev.open);
  const curBullish  = cur.close  > cur.open;
  const prevBullish = prev.close > prev.open;
  const lowerWick = Math.min(cur.open, cur.close) - cur.low;
  const upperWick = cur.high - Math.max(cur.open, cur.close);

  const bullishEngulfing =
    !prevBullish && curBullish &&
    cur.open  <= prev.close &&
    cur.close >= prev.open  &&
    curBody > prevBody * 0.8;

  const bearishEngulfing =
    prevBullish && !curBullish &&
    cur.open  >= prev.close &&
    cur.close <= prev.open  &&
    curBody > prevBody * 0.8;

  const hammer =
    curBody > 0 &&
    lowerWick >= curBody * 2 &&
    upperWick <= curBody * 0.5;

  const shootingStar =
    curBody > 0 &&
    upperWick >= curBody * 2 &&
    lowerWick <= curBody * 0.5;

  return { bullishEngulfing, bearishEngulfing, hammer, shootingStar };
}

// ── RSI divergence (lookback last N candles) ──────────────────
function detectRsiDivergence(
  candles: Candle[],
  lookback = 12,
): { bullish: boolean; bearish: boolean } {
  if (candles.length < 30) return { bullish: false, bearish: false };

  const closes    = candles.map((c) => c.close);
  const rsiValues = rsiCalc(closes, 14);
  const curClose  = closes[closes.length - 1];
  const curRsi    = rsiValues[rsiValues.length - 1];
  if (isNaN(curRsi)) return { bullish: false, bearish: false };

  const start = closes.length - lookback - 1;
  let lowestClose = Infinity,  lowestRsi  = Infinity;
  let highestClose = -Infinity, highestRsi = -Infinity;

  for (let i = start; i < closes.length - 1; i++) {
    const r = rsiValues[i];
    if (isNaN(r)) continue;
    if (closes[i] < lowestClose)  { lowestClose  = closes[i]; lowestRsi  = r; }
    if (closes[i] > highestClose) { highestClose = closes[i]; highestRsi = r; }
  }

  // Bullish: price makes lower low, RSI makes higher low
  const bullish = curClose < lowestClose  && curRsi > lowestRsi  + 3;
  // Bearish: price makes higher high, RSI makes lower high
  const bearish = curClose > highestClose && curRsi < highestRsi - 3;

  return { bullish, bearish };
}

// ════════════════════════════════════════════════════════════════
// Gate  : EMA200 position decides allowed direction.
//         ±1.5% zone around EMA200 → both directions scored.
// Score : Minimum 9 to fire a signal.
// RR    : Minimum 2.0 (raised from 1.5 for better risk management).
// Stop  : ATR × 1.5 (dynamic).
// Volatility gate: ATR > 3% of price requires score +4.
// ════════════════════════════════════════════════════════════════
const MIN_SCORE      = 9;
const MIN_RR         = 2.0;
const HIGH_VOLIT_PCT = 0.03; // ATR > 3% = high volatility
const HIGH_VOLIT_EXTRA = 4;  // extra score required in high-vol

// htfBias: if provided, bonus +3 for aligned direction, penalty -2 for opposite
export function generateSignals(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
  htfBias?: 'LONG' | 'SHORT' | null,
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
  const atrPct     = atrVal / price;
  const volRatio   = calcVolRatio(candles);
  const ema50Slope = calcEmaSlope(candles, 50);
  const patterns   = detectCandlePatterns(candles);
  const divergence = detectRsiDivergence(candles);

  // Volatility adaptive threshold
  const effectiveMinScore = atrPct > HIGH_VOLIT_PCT ? MIN_SCORE + HIGH_VOLIT_EXTRA : MIN_SCORE;

  const aboveEma200     = price > ind.ema200;
  const ema20AboveEma50 = ind.ema20 > ind.ema50;
  const nearEma200      = Math.abs(price - ind.ema200) / ind.ema200 < 0.015;
  const allowLong       = aboveEma200 || nearEma200;
  const allowShort      = !aboveEma200 || nearEma200;

  // EMA perfect alignment
  const emaPerfectLong  = ind.ema20 > ind.ema50 && ind.ema50 > ind.ema200;
  const emaPerfectShort = ind.ema20 < ind.ema50 && ind.ema50 < ind.ema200;

  const support    = nearestSupport(srLevels, price);
  const resistance = nearestResistance(srLevels, price);
  const signals: TradingSignal[] = [];

  // ── LONG SCORING ─────────────────────────────────────────────
  let longScore = 0;
  const longReasons: string[] = [];
  let longOB:  OrderBlock | undefined;
  let longFVG: FairValueGap | undefined;
  let longSR:  SRLevel | undefined;

  if (allowLong) {
    if (aboveEma200)         { longScore += 3; longReasons.push('EMA200 上方（多頭趨勢）'); }
    else if (nearEma200)     { longScore += 1; longReasons.push('EMA200 附近（關鍵支撐）'); }
    if (emaPerfectLong)      { longScore += 2; longReasons.push('EMA 完美多頭排列 (20>50>200)'); }
    if (ema20AboveEma50)     { longScore += 2; longReasons.push('EMA20 > EMA50（短期強勢）'); }
    if (ema50Slope === 'up') { longScore += 1; longReasons.push('EMA50 斜率向上'); }

    if (structure.trend === 'bullish')                { longScore += 2; longReasons.push('結構做多（HH HL）'); }
    if (structure.lastBOS?.direction === 'bullish')   { longScore += 2; longReasons.push('BOS 突破向上'); }
    if (structure.lastChoCH?.direction === 'bullish') { longScore += 3; longReasons.push('ChoCH 轉多'); }
    if (structure.lastChoCH?.direction === 'bearish') longScore -= 2;

    const bullOB = obs.find(
      (ob) => ob.type === 'bullish' && price >= ob.low * 0.999 && price <= ob.high * 1.005,
    );
    if (bullOB) {
      longScore += 3 + Math.min(bullOB.strength, 2);
      longReasons.push(`看漲 OB（強度 ${bullOB.strength}）`);
      longOB = bullOB;
    }

    const bullFVG = fvgs.find(
      (f) => f.type === 'bullish' && price >= f.bottom * 0.999 && price <= f.top * 1.001,
    );
    if (bullFVG) { longScore += 2; longReasons.push('看漲 FVG 回補'); longFVG = bullFVG; }

    if (support && Math.abs(price - support.price) / price <= 0.015) {
      longScore += Math.min(support.touchCount, 4);
      longReasons.push(`支撐 $${support.price.toFixed(4)}（${support.touchCount} 次）`);
      longSR = support;
    }

    if (ind.rsi < 35)      { longScore += 4; longReasons.push(`RSI 超賣 ${ind.rsi.toFixed(1)}`); }
    else if (ind.rsi < 50) { longScore += 2; longReasons.push(`RSI 回調 ${ind.rsi.toFixed(1)}`); }
    else if (ind.rsi > 70) longScore -= 3;

    // RSI bullish divergence
    if (divergence.bullish) { longScore += 3; longReasons.push('RSI 看漲背離'); }

    if (ind.macdHistogram > 0 && ind.macd > ind.macdSignal) {
      longScore += 2; longReasons.push('MACD 黃金交叉');
    }
    if (ind.macdHistogram > 0 && ind.macdHistogram > prevInd.macdHistogram) {
      longScore += 1; longReasons.push('MACD 動能增強');
    }

    if (volRatio >= 1.5) { longScore += 2; longReasons.push(`量能放大 ${volRatio.toFixed(1)}×`); }

    // Candle patterns
    if (patterns.bullishEngulfing) { longScore += 2; longReasons.push('看漲吞噬K線'); }
    if (patterns.hammer)           { longScore += 2; longReasons.push('錘子線'); }

    // High-vol note
    if (atrPct > HIGH_VOLIT_PCT) longReasons.push(`⚠ 高波動（ATR ${(atrPct * 100).toFixed(1)}%）需 ${effectiveMinScore} 分`);
  }

  // ── SHORT SCORING ─────────────────────────────────────────────
  let shortScore = 0;
  const shortReasons: string[] = [];
  let shortOB:  OrderBlock | undefined;
  let shortFVG: FairValueGap | undefined;
  let shortSR:  SRLevel | undefined;

  if (allowShort) {
    if (!aboveEma200)          { shortScore += 3; shortReasons.push('EMA200 下方（空頭趨勢）'); }
    else if (nearEma200)       { shortScore += 1; shortReasons.push('EMA200 附近（關鍵阻力）'); }
    if (emaPerfectShort)       { shortScore += 2; shortReasons.push('EMA 完美空頭排列 (20<50<200)'); }
    if (!ema20AboveEma50)      { shortScore += 2; shortReasons.push('EMA20 < EMA50（短期弱勢）'); }
    if (ema50Slope === 'down') { shortScore += 1; shortReasons.push('EMA50 斜率向下'); }

    if (structure.trend === 'bearish')                 { shortScore += 2; shortReasons.push('結構做空（LH LL）'); }
    if (structure.lastBOS?.direction === 'bearish')    { shortScore += 2; shortReasons.push('BOS 向下突破'); }
    if (structure.lastChoCH?.direction === 'bearish')  { shortScore += 3; shortReasons.push('ChoCH 轉空'); }
    if (structure.lastChoCH?.direction === 'bullish')  shortScore -= 2;

    const bearOB = obs.find(
      (ob) => ob.type === 'bearish' && price <= ob.high * 1.001 && price >= ob.low * 0.995,
    );
    if (bearOB) {
      shortScore += 3 + Math.min(bearOB.strength, 2);
      shortReasons.push(`看跌 OB（強度 ${bearOB.strength}）`);
      shortOB = bearOB;
    }

    const bearFVG = fvgs.find(
      (f) => f.type === 'bearish' && price >= f.bottom * 0.999 && price <= f.top * 1.001,
    );
    if (bearFVG) { shortScore += 2; shortReasons.push('看跌 FVG 回補'); shortFVG = bearFVG; }

    if (resistance && Math.abs(price - resistance.price) / price <= 0.015) {
      shortScore += Math.min(resistance.touchCount, 4);
      shortReasons.push(`阻力 $${resistance.price.toFixed(4)}（${resistance.touchCount} 次）`);
      shortSR = resistance;
    }

    if (ind.rsi > 65)      { shortScore += 4; shortReasons.push(`RSI 超買 ${ind.rsi.toFixed(1)}`); }
    else if (ind.rsi > 50) { shortScore += 2; shortReasons.push(`RSI 反彈 ${ind.rsi.toFixed(1)}`); }
    else if (ind.rsi < 30) shortScore -= 3;

    // RSI bearish divergence
    if (divergence.bearish) { shortScore += 3; shortReasons.push('RSI 看跌背離'); }

    if (ind.macdHistogram < 0 && ind.macd < ind.macdSignal) {
      shortScore += 2; shortReasons.push('MACD 死亡交叉');
    }
    if (ind.macdHistogram < 0 && ind.macdHistogram < prevInd.macdHistogram) {
      shortScore += 1; shortReasons.push('MACD 跌勢加速');
    }

    if (volRatio >= 1.5) { shortScore += 2; shortReasons.push(`量能放大 ${volRatio.toFixed(1)}×`); }

    // Candle patterns
    if (patterns.bearishEngulfing) { shortScore += 2; shortReasons.push('看跌吞噬K線'); }
    if (patterns.shootingStar)     { shortScore += 2; shortReasons.push('流星線'); }

    if (atrPct > HIGH_VOLIT_PCT) shortReasons.push(`⚠ 高波動（ATR ${(atrPct * 100).toFixed(1)}%）需 ${effectiveMinScore} 分`);
  }

  // ── HTF Bias bonus / penalty ──────────────────────────────────
  if (htfBias === 'LONG')  { longScore  += 3; longReasons.push('大時框偏多 +3'); shortScore -= 2; }
  if (htfBias === 'SHORT') { shortScore += 3; shortReasons.push('大時框偏空 +3'); longScore  -= 2; }

  // ── BUILD SIGNALS ─────────────────────────────────────────────
  const slBuffer  = Math.max(atrVal * 1.5, price * 0.01);
  // TP fallback: 2.0x and 3.5x risk (raised from 1.5x / 61.8% extension)
  const minTpDist = slBuffer * MIN_RR;

  // LONG — only fires when clearly stronger than short
  if (longScore >= effectiveMinScore && longScore > shortScore) {
    const sl  = longOB  ? Math.min(longOB.low  * 0.995, price - slBuffer)
              : longSR  ? Math.min(longSR.price * 0.995, price - slBuffer)
              : price - slBuffer;
    const risk   = Math.max(price - sl, 1e-6);
    const tp1Raw = resistance ? resistance.price : price + risk * 2.0;
    const tp1    = Math.max(tp1Raw, price + risk * MIN_RR);
    // TP2: next resistance or 3.5x risk extension
    const nextR  = srLevels.find((l) => l.type === 'resistance' && l.price > tp1 * 1.005);
    const tp2    = nextR ? nextR.price : price + risk * 3.5;
    const rr     = parseFloat(((tp1 - price) / risk).toFixed(2));
    signals.push({
      id: simpleId(), symbol, direction: 'LONG',
      strength: scoreToStrength(longScore), score: longScore,
      entry: price, takeProfits: [tp1, tp2], stopLoss: sl,
      riskReward: rr, timeframe, timestamp: Date.now(),
      reasons: longReasons, orderBlock: longOB, fvg: longFVG,
      srLevel: longSR ?? support ?? undefined, indicators: ind, isRead: false,
    });
  }

  // SHORT — only fires when clearly stronger than long
  if (shortScore >= effectiveMinScore && shortScore > longScore) {
    const sl  = shortOB ? Math.max(shortOB.high * 1.005, price + slBuffer)
              : shortSR ? Math.max(shortSR.price * 1.005, price + slBuffer)
              : price + slBuffer;
    const risk   = Math.max(sl - price, 1e-6);
    const tp1Raw = support ? support.price : price - risk * 2.0;
    const tp1    = Math.min(tp1Raw, price - risk * MIN_RR);
    // TP2: next support or 3.5x risk extension
    const nextS  = srLevels.find((l) => l.type === 'support' && l.price < tp1 * 0.995);
    const tp2    = nextS ? nextS.price : price - risk * 3.5;
    const rr     = parseFloat(((price - tp1) / risk).toFixed(2));
    signals.push({
      id: simpleId(), symbol, direction: 'SHORT',
      strength: scoreToStrength(shortScore), score: shortScore,
      entry: price, takeProfits: [tp1, tp2], stopLoss: sl,
      riskReward: rr, timeframe, timestamp: Date.now(),
      reasons: shortReasons, orderBlock: shortOB, fvg: shortFVG,
      srLevel: shortSR ?? resistance ?? undefined, indicators: ind, isRead: false,
    });
  }

  return signals;
}

// Highest timeframe's direction is the master — filter out conflicting directions.
// Prevents simultaneous LONG (1h) + SHORT (4h) signals for the same coin.
const TF_RANK: Partial<Record<Timeframe, number>> = { '1d': 4, '4h': 3, '1h': 2, '15m': 1 };

export function unifySignalDirection(signals: TradingSignal[]): TradingSignal[] {
  if (signals.length === 0) return [];
  const master = [...signals].sort(
    (a, b) => (TF_RANK[b.timeframe] ?? 0) - (TF_RANK[a.timeframe] ?? 0),
  )[0];
  return signals.filter(s => s.direction === master.direction);
}
