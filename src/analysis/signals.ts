import { Candle, TradingSignal, SignalStrength, Timeframe, OrderBlock, FairValueGap, SRLevel, Regime } from '../types';
import { computeIndicators, rsi as rsiCalc } from './indicators';
import { findOrderBlocks, findFairValueGaps, analyzeMarketStructure, findEqualLevels } from './smc';
import { findSRLevels, nearestSupport, nearestResistance } from './snr';

function simpleId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function scoreToStrength(score: number): SignalStrength {
  if (score >= 80) return 'STRONG';
  if (score >= 65) return 'MODERATE';
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

  const start = Math.max(0, closes.length - lookback - 1);
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
// Strategy A — SMC + Trend Following
//
// Hard gates (intraday only):
//   1. Ranging market → return [] immediately (no signal)
//   2. Candle confirmation required (engulfing / hammer / shooting star)
//   3. 5m must have HTF bias from 15m/1h; no bias → no 5m signal
//
// §4.2 v2 scoring: base 40 + 5 groups (trend/momentum/structure/volume/PA).
//   Each group capped at its max. Score ≥ 65. Min 3 groups must contribute.
//   MIN_RR: 1.2 (intraday) / 2.0 (swing)
// ════════════════════════════════════════════════════════════════
// §4.2 v2: Group-capped scoring. Base 40 + 5 groups (max 100).
// Signal emitted only when score ≥ 65 AND ≥3 groups contribute.
const MIN_SCORE          = 65; // v2 threshold (was 12/13)
const MIN_SCORE_LONGTF   = 67; // 4h/1d need 2 extra points
const MIN_RR_INTRADAY    = 1.2;
const MIN_RR_SWING       = 2.0;
const HIGH_VOLIT_PCT     = 0.03;
const NO_LEVEL_PENALTY   = 3;
const GROUP_CAPS = { trend: 15, momentum: 10, structure: 15, volume: 10, priceAction: 10 } as const;

function isIntradayTF(tf: Timeframe): boolean {
  return tf === '5m' || tf === '15m';
}

// htfBias: if provided, bonus +3 for aligned direction, penalty -2 for opposite
// regime: determined from 4H ADX — 'trending' enables Strategy A extras,
//         'ranging' skips new entry candidates (Strategy B handled separately),
//         'transitional' (ADX 20-25) blocks all new signals from this function.
export function generateSignals(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
  htfBias?: 'LONG' | 'SHORT' | null,
  regime?: Regime,
): TradingSignal[] {
  if (candles.length < 55) return [];

  // ── Phase 2 gate: ADX transitional zone (20-25) → no new signals ──
  // This is correct behaviour; caller receives empty array and should surface
  // regime='transitional' in the API response for transparency.
  if (regime === 'transitional') return [];

  const intraday  = isIntradayTF(timeframe);
  const isLongTF  = timeframe === '4h' || timeframe === '1d';
  // 4h/1d needs 2 extra points (§4.2 v2)
  const effectiveMinScore = isLongTF ? MIN_SCORE_LONGTF : MIN_SCORE;
  const MIN_RR    = intraday ? MIN_RR_INTRADAY    : MIN_RR_SWING;

  const cur             = candles[candles.length - 1];
  const price           = cur.close;
  const isBullishCandle = cur.close > cur.open;

  // ── Hard gate 1 (intraday): skip ranging markets entirely ────
  // Ranging = no momentum = no clean TP target reachable in a day.
  // Structure is also used later, so compute it once here.
  const structure = analyzeMarketStructure(candles);
  if (intraday) {
    if (structure.trend === 'ranging') return [];
    // Hard gate 2 (5m only): must have HTF bias — no counter-trend 5m entries
    if (timeframe === '5m' && !htfBias) return [];
  }

  const ind     = computeIndicators(candles);
  const prevInd = computeIndicators(candles.slice(0, -1));
  // structure already computed above for hard gate 1
  const obs     = findOrderBlocks(candles).filter((ob) => !ob.mitigated);
  const fvgs      = findFairValueGaps(candles).filter((f) => !f.filled);
  const srLevels  = findSRLevels(candles);

  const atrVal     = calcAtr(candles);
  const atrPct     = atrVal / price;
  const volRatio   = calcVolRatio(candles);
  const ema50Slope = calcEmaSlope(candles, intraday ? 20 : 50); // faster slope for intraday
  const patterns   = detectCandlePatterns(candles);
  const divergence = detectRsiDivergence(candles);

  // Hard gate: ATR > 40% means the coin swings too wildly to set a meaningful SL
  if (atrPct > 0.40) return [];

  // EMA200 zone: wider for short TF (5m/15m EMA200 fluctuates more)
  const ema200Zone  = intraday ? 0.015 : 0.008;
  const aboveEma200     = price > ind.ema200;
  const ema20AboveEma50 = ind.ema20 > ind.ema50;
  const nearEma200      = Math.abs(price - ind.ema200) / ind.ema200 < ema200Zone;
  const allowLong       = aboveEma200 || nearEma200;
  const allowShort      = !aboveEma200 || nearEma200;

  // EMA perfect alignment
  const emaPerfectLong  = ind.ema20 > ind.ema50 && ind.ema50 > ind.ema200;
  const emaPerfectShort = ind.ema20 < ind.ema50 && ind.ema50 < ind.ema200;

  const support    = nearestSupport(srLevels, price);
  const resistance = nearestResistance(srLevels, price);
  const signals: TradingSignal[] = [];

  // ── LONG SCORING (§4.2 v2 group-capped) ──────────────────────
  // Accumulate raw group scores, then cap each at its limit.
  // Penalties are uncapped and applied after grouping.
  let lTrend = 0, lMom = 0, lStruct = 0, lVol = 0, lPA = 0, lPenalties = 0;
  const longReasons: string[] = [];
  let longOB:  OrderBlock | undefined;
  let longFVG: FairValueGap | undefined;
  let longSR:  SRLevel | undefined;

  if (allowLong) {
    // Trend group
    if (aboveEma200)          { lTrend += 3; longReasons.push('EMA200 上方（多頭趨勢）'); }
    else if (nearEma200)      { lTrend += 1; longReasons.push('EMA200 附近（關鍵支撐）'); }
    if (emaPerfectLong)       { lTrend += 5; longReasons.push('EMA 完美多頭排列 (20>50>200)'); }
    else if (ema20AboveEma50) { lTrend += 2; longReasons.push('EMA20 > EMA50（短期強勢）'); }
    if (ema50Slope === 'up')  { lTrend += 2; longReasons.push('EMA50 斜率向上'); }

    // Momentum group
    if (ind.rsi < 35)      { lMom += 5; longReasons.push(`RSI 超賣 ${ind.rsi.toFixed(1)}`); }
    else if (ind.rsi < 45) { lMom += 3; longReasons.push(`RSI 超賣回升 ${ind.rsi.toFixed(1)}`); }
    else if (ind.rsi > 70) { lPenalties -= 3; }
    if (divergence.bullish) { lMom += 4; longReasons.push('RSI 看漲背離'); }
    if (ind.macdHistogram > 0 && ind.macd > ind.macdSignal)         { lMom += 3; longReasons.push('MACD 黃金交叉'); }
    if (ind.macdHistogram > 0 && ind.macdHistogram > prevInd.macdHistogram) { lMom += 2; longReasons.push('MACD 動能增強'); }

    // Structure group
    if (structure.trend === 'bullish')                { lStruct += 3; longReasons.push('結構做多（HH HL）'); }
    if (structure.lastBOS?.direction === 'bullish')   { lStruct += 3; longReasons.push('BOS 突破向上'); }
    if (structure.lastChoCH?.direction === 'bullish') { lStruct += 5; longReasons.push('ChoCH 轉多'); }
    if (structure.lastChoCH?.direction === 'bearish') { lPenalties -= 3; }

    const bullOB = obs.find(ob => ob.type === 'bullish' && price >= ob.low * 0.999 && price <= ob.high * 1.005);
    if (bullOB) { lStruct += 4; longReasons.push(`看漲 OB（強度 ${bullOB.strength}）`); longOB = bullOB; }

    const bullFVG = fvgs.find(f => f.type === 'bullish' && price >= f.bottom * 0.999 && price <= f.top * 1.001);
    if (bullFVG) { lStruct += 3; longReasons.push('看漲 FVG 回補'); longFVG = bullFVG; }

    if (support && Math.abs(price - support.price) / price <= 0.015) {
      lStruct += Math.min(support.touchCount, 5);
      longReasons.push(`支撐 $${support.price.toFixed(4)}（${support.touchCount} 次）`);
      longSR = support;
    }

    // Volume group
    if      (volRatio >= 2.5 && isBullishCandle) { lVol = 10; longReasons.push(`多頭量能爆量 ${volRatio.toFixed(1)}×`); }
    else if (volRatio >= 2.0 && isBullishCandle) { lVol = 8;  longReasons.push(`多頭量能放大 ${volRatio.toFixed(1)}×`); }
    else if (volRatio >= 1.5 && isBullishCandle) { lVol = 5;  longReasons.push(`多頭量能放大 ${volRatio.toFixed(1)}×`); }
    else if (volRatio >= 1.3 && isBullishCandle) { lVol = 3;  longReasons.push(`多頭量能放大 ${volRatio.toFixed(1)}×`); }

    // Price Action group
    if (patterns.bullishEngulfing) { lPA += 7; longReasons.push('看漲吞噬K線'); }
    if (patterns.hammer)           { lPA += 5; longReasons.push('錘子線'); }

    if (atrPct > HIGH_VOLIT_PCT) { lPenalties -= 3; longReasons.push(`⚠ 高波動（ATR ${(atrPct * 100).toFixed(1)}%）-3分`); }
  }

  // ── SHORT SCORING (§4.2 v2 group-capped) ─────────────────────
  let sTrend = 0, sMom = 0, sStruct = 0, sVol = 0, sPA = 0, sPenalties = 0;
  const shortReasons: string[] = [];
  let shortOB:  OrderBlock | undefined;
  let shortFVG: FairValueGap | undefined;
  let shortSR:  SRLevel | undefined;

  if (allowShort) {
    // Trend group
    if (!aboveEma200)           { sTrend += 3; shortReasons.push('EMA200 下方（空頭趨勢）'); }
    else if (nearEma200)        { sTrend += 1; shortReasons.push('EMA200 附近（關鍵阻力）'); }
    if (emaPerfectShort)        { sTrend += 5; shortReasons.push('EMA 完美空頭排列 (20<50<200)'); }
    else if (!ema20AboveEma50)  { sTrend += 2; shortReasons.push('EMA20 < EMA50（短期弱勢）'); }
    if (ema50Slope === 'down')  { sTrend += 2; shortReasons.push('EMA50 斜率向下'); }

    // Momentum group
    if (ind.rsi > 65)      { sMom += 5; shortReasons.push(`RSI 超買 ${ind.rsi.toFixed(1)}`); }
    else if (ind.rsi > 55) { sMom += 3; shortReasons.push(`RSI 超買回落 ${ind.rsi.toFixed(1)}`); }
    else if (ind.rsi < 30) { sPenalties -= 3; }
    if (divergence.bearish) { sMom += 4; shortReasons.push('RSI 看跌背離'); }
    if (ind.macdHistogram < 0 && ind.macd < ind.macdSignal)         { sMom += 3; shortReasons.push('MACD 死亡交叉'); }
    if (ind.macdHistogram < 0 && ind.macdHistogram < prevInd.macdHistogram) { sMom += 2; shortReasons.push('MACD 跌勢加速'); }

    // Structure group
    if (structure.trend === 'bearish')                { sStruct += 3; shortReasons.push('結構做空（LH LL）'); }
    if (structure.lastBOS?.direction === 'bearish')   { sStruct += 3; shortReasons.push('BOS 向下突破'); }
    if (structure.lastChoCH?.direction === 'bearish') { sStruct += 5; shortReasons.push('ChoCH 轉空'); }
    if (structure.lastChoCH?.direction === 'bullish') { sPenalties -= 3; }

    const bearOB = obs.find(ob => ob.type === 'bearish' && price <= ob.high * 1.001 && price >= ob.low * 0.995);
    if (bearOB) { sStruct += 4; shortReasons.push(`看跌 OB（強度 ${bearOB.strength}）`); shortOB = bearOB; }

    const bearFVG = fvgs.find(f => f.type === 'bearish' && price >= f.bottom * 0.999 && price <= f.top * 1.001);
    if (bearFVG) { sStruct += 3; shortReasons.push('看跌 FVG 回補'); shortFVG = bearFVG; }

    if (resistance && Math.abs(price - resistance.price) / price <= 0.015) {
      sStruct += Math.min(resistance.touchCount, 5);
      shortReasons.push(`阻力 $${resistance.price.toFixed(4)}（${resistance.touchCount} 次）`);
      shortSR = resistance;
    }

    // Volume group
    if      (volRatio >= 2.5 && !isBullishCandle) { sVol = 10; shortReasons.push(`空頭量能爆量 ${volRatio.toFixed(1)}×`); }
    else if (volRatio >= 2.0 && !isBullishCandle) { sVol = 8;  shortReasons.push(`空頭量能放大 ${volRatio.toFixed(1)}×`); }
    else if (volRatio >= 1.5 && !isBullishCandle) { sVol = 5;  shortReasons.push(`空頭量能放大 ${volRatio.toFixed(1)}×`); }
    else if (volRatio >= 1.3 && !isBullishCandle) { sVol = 3;  shortReasons.push(`空頭量能放大 ${volRatio.toFixed(1)}×`); }

    // Price Action group
    if (patterns.bearishEngulfing) { sPA += 7; shortReasons.push('看跌吞噬K線'); }
    if (patterns.shootingStar)     { sPA += 5; shortReasons.push('流星線'); }

    if (atrPct > HIGH_VOLIT_PCT) { sPenalties -= 3; shortReasons.push(`⚠ 高波動（ATR ${(atrPct * 100).toFixed(1)}%）-3分`); }
  }

  // ── HTF Bias: add to trend group ─────────────────────────────
  if (htfBias === 'LONG')  { lTrend += 3; longReasons.push('大時框偏多 +3'); sPenalties -= 5; }
  if (htfBias === 'SHORT') { sTrend += 3; shortReasons.push('大時框偏空 +3'); lPenalties -= 5; }

  // ── Strategy A extras → trend group ──────────────────────────
  if (regime === 'trending') {
    const ema20Zone = atrVal * 0.5;
    if (allowLong && price >= ind.ema20 - ema20Zone && price <= ind.ema20 + ema20Zone) {
      lTrend += 3; longReasons.push(`策略A: 回調 EMA20±0.5ATR（$${ind.ema20.toFixed(4)}）`);
    }
    if (allowShort && price >= ind.ema20 - ema20Zone && price <= ind.ema20 + ema20Zone) {
      sTrend += 3; shortReasons.push(`策略A: 反彈 EMA20±0.5ATR（$${ind.ema20.toFixed(4)}）`);
    }
    const don = ind.donchian;
    if (don && !isNaN(don.upper) && !isNaN(don.lower)) {
      if (allowLong  && price > don.upper) { lTrend += 4; longReasons.push(`策略A: Donchian20 向上突破（$${don.upper.toFixed(4)}）`); }
      if (allowShort && price < don.lower) { sTrend += 4; shortReasons.push(`策略A: Donchian20 向下突破（$${don.lower.toFixed(4)}）`); }
    }
  }

  // ── Breaker blocks → structure group ─────────────────────────
  const allOBs    = findOrderBlocks(candles);
  const breakerBull = allOBs.find(ob => ob.mitigated && ob.type === 'bearish' && price >= ob.low * 0.999 && price <= ob.high * 1.005);
  const breakerBear = allOBs.find(ob => ob.mitigated && ob.type === 'bullish' && price <= ob.high * 1.001 && price >= ob.low * 0.995);
  if (breakerBull) { lStruct += 2; longReasons.push('看漲破壞塊（空頭 OB 突破轉支撐）'); }
  if (breakerBear) { sStruct += 2; shortReasons.push('看跌破壞塊（多頭 OB 突破轉阻力）'); }

  // ── Fibonacci GP + EQL → structure group ─────────────────────
  const fmtF = (n: number) => n >= 1000 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toFixed(6);
  const { swingHighs: shs, swingLows: sls } = structure;
  if (shs.length >= 1 && sls.length >= 1) {
    const swHigh  = Math.max(...shs.slice(-3).map(s => s.price));
    const swLow   = Math.min(...sls.slice(-3).map(s => s.price));
    const fibRange = swHigh - swLow;
    if (fibRange / swLow > 0.02) {
      const gp618 = swHigh - fibRange * 0.618;
      const gp65  = swHigh - fibRange * 0.65;
      if (allowLong  && price >= Math.min(gp618,gp65) * 0.998 && price <= Math.max(gp618,gp65) * 1.002)
        { lStruct += 3; longReasons.push(`Fib 黃金口袋 0.618–0.65（$${fmtF(Math.min(gp618,gp65))}–$${fmtF(Math.max(gp618,gp65))}）`); }
      const gpS618 = swLow + fibRange * 0.618;
      const gpS65  = swLow + fibRange * 0.65;
      if (allowShort && price >= Math.min(gpS618,gpS65) * 0.998 && price <= Math.max(gpS618,gpS65) * 1.002)
        { sStruct += 3; shortReasons.push(`Fib 黃金口袋 0.618–0.65（$${fmtF(Math.min(gpS618,gpS65))}–$${fmtF(Math.max(gpS618,gpS65))}）`); }
    }
  }
  const { eqHighs, eqLows } = findEqualLevels(candles);
  const nearEQL = eqLows.filter(l => l < price).sort((a, b) => b - a)[0];
  if (nearEQL && (price - nearEQL) / price <= 0.015) { lStruct += 2; longReasons.push(`EQL 流動性支撐 $${fmtF(nearEQL)}`); }
  const nearEQH = eqHighs.filter(h => h > price).sort((a, b) => a - b)[0];
  if (nearEQH && (nearEQH - price) / price <= 0.015) { sStruct += 2; shortReasons.push(`EQH 流動性阻力 $${fmtF(nearEQH)}`); }

  // ── Cap each group and compute totals ─────────────────────────
  const longTrend  = Math.min(lTrend,  GROUP_CAPS.trend);
  const longMom    = Math.min(lMom,    GROUP_CAPS.momentum);
  const longStruct = Math.min(lStruct, GROUP_CAPS.structure);
  const longVol    = Math.min(lVol,    GROUP_CAPS.volume);
  const longPAction= Math.min(lPA,     GROUP_CAPS.priceAction);
  const longGroupsOk = [longTrend, longMom, longStruct, longVol, longPAction].filter(g => g > 0).length >= 3;
  let   longScore  = 40 + longTrend + longMom + longStruct + longVol + longPAction + lPenalties;

  const shortTrend  = Math.min(sTrend,  GROUP_CAPS.trend);
  const shortMom    = Math.min(sMom,    GROUP_CAPS.momentum);
  const shortStruct = Math.min(sStruct, GROUP_CAPS.structure);
  const shortVol    = Math.min(sVol,    GROUP_CAPS.volume);
  const shortPAction= Math.min(sPA,     GROUP_CAPS.priceAction);
  const shortGroupsOk = [shortTrend, shortMom, shortStruct, shortVol, shortPAction].filter(g => g > 0).length >= 3;
  let   shortScore  = 40 + shortTrend + shortMom + shortStruct + shortVol + shortPAction + sPenalties;

  // ── BUILD SIGNALS ─────────────────────────────────────────────
  // Dynamic SL buffer: scale ATR multiplier by current volatility vs 1.5% baseline.
  // High-vol markets widen the buffer so SL isn't prematurely triggered.
  const atrMulti = intraday
    ? Math.min(Math.max(1.0, atrPct / 0.015), 2.0)
    : Math.min(Math.max(1.5, atrPct / 0.015), 2.5);
  // Cap SL distance: never wider than 5% (intraday) or 12% (swing) of price
  const MAX_SL_PCT = intraday ? 0.05 : 0.12;
  const slBuffer = Math.min(
    intraday
      ? Math.max(atrVal * atrMulti, price * 0.004)
      : Math.max(atrVal * atrMulti, price * 0.010),
    price * MAX_SL_PCT,
  );

  // Entry zone thresholds — how far below/above current price counts as a limit order
  //   5m  : ±0.3%  (price moves fast, entries must be close)
  //   15m : ±0.5%
  //   1h+ : ±0.7% (original ±0.3% was too tight even for swing)
  const entryThreshLong  = timeframe === '5m' ? 0.003 : timeframe === '15m' ? 0.005 : 0.007;
  const entryThreshShort = entryThreshLong;
  // Search window for pending OB/SR: tighter for intraday
  const searchWindow = timeframe === '5m' ? 0.015 : timeframe === '15m' ? 0.025 : 0.07;

  // ── LONG: find best entry level ──────────────────────────────
  let longEntry = price;
  const pendingBullOB = obs
    .filter(o => o.type === 'bullish' && !o.mitigated
               && o.high < price * (1 - entryThreshLong) && o.high > price * (1 - searchWindow))
    .sort((a, b) => b.high - a.high)[0];
  const pendingSupport = srLevels
    .filter(l => l.type === 'support' && l.price < price * (1 - entryThreshLong) && l.price > price * (1 - searchWindow))
    .sort((a, b) => b.price - a.price)[0];
  if (pendingBullOB && (!pendingSupport || pendingBullOB.high >= pendingSupport.price)) {
    longEntry = (pendingBullOB.high + pendingBullOB.low) / 2;
    longOB    = pendingBullOB;
  } else if (pendingSupport) {
    longEntry = pendingSupport.price;
    longSR    = pendingSupport;
  }

  // Strategy A: EMA20 as pullback entry candidate (only if it's deeper than current price
  // but within the search window, and is the best available level)
  if (regime === 'trending' && ind.ema20 < price * (1 - entryThreshLong) && ind.ema20 > price * (1 - searchWindow)) {
    // EMA20 is a valid pending pullback level — prefer it over bare SR if closer
    if (!pendingBullOB && (!pendingSupport || ind.ema20 > pendingSupport.price)) {
      longEntry = ind.ema20;
      longReasons.push(`策略A: 等待回調 EMA20 $${ind.ema20.toFixed(4)}`);
    }
  }

  // For intraday: if price is AT or just above an OB/FVG → allow near-market entry
  const atBullOB  = obs.find(o => o.type === 'bullish' && !o.mitigated && price >= o.low && price <= o.high * 1.002);
  const atBullFVG = fvgs.find(f => f.type === 'bullish' && !f.filled && price >= f.bottom && price <= f.top * 1.002);
  if (intraday && (atBullOB || atBullFVG) && longEntry >= price * (1 - entryThreshLong)) {
    longEntry = price; // enter at market since price is inside OB/FVG now
    if (atBullOB)  { longOB = atBullOB;   longReasons.push('現價在多頭 OB 內，市價入場'); }
    if (atBullFVG) { longFVG = atBullFVG; longReasons.push('現價在 FVG 內，市價補位'); }
  }

  if (longEntry < price * (1 - entryThreshLong)) {
    longReasons.push(intraday ? `等待回測 $${longEntry.toFixed(4)} 入場` : '掛限價單，待回測入場');
  } else if (!atBullOB && !atBullFVG) {
    longScore -= NO_LEVEL_PENALTY;
    longReasons.push('⚠ 無明確回測位，扣 3 分');
  }

  // ── SHORT: find best entry level ─────────────────────────────
  let shortEntry = price;
  const pendingBearOB = obs
    .filter(o => o.type === 'bearish' && !o.mitigated
               && o.low > price * (1 + entryThreshShort) && o.low < price * (1 + searchWindow))
    .sort((a, b) => a.low - b.low)[0];
  const pendingResistance = srLevels
    .filter(l => l.type === 'resistance' && l.price > price * (1 + entryThreshShort) && l.price < price * (1 + searchWindow))
    .sort((a, b) => a.price - b.price)[0];
  if (pendingBearOB && (!pendingResistance || pendingBearOB.low <= pendingResistance.price)) {
    shortEntry = (pendingBearOB.high + pendingBearOB.low) / 2;
    shortOB    = pendingBearOB;
  } else if (pendingResistance) {
    shortEntry = pendingResistance.price;
    shortSR    = pendingResistance;
  }

  // Strategy A: EMA20 as bounce-short entry candidate in trending down market
  if (regime === 'trending' && ind.ema20 > price * (1 + entryThreshShort) && ind.ema20 < price * (1 + searchWindow)) {
    if (!pendingBearOB && (!pendingResistance || ind.ema20 < pendingResistance.price)) {
      shortEntry = ind.ema20;
      shortReasons.push(`策略A: 等待反彈 EMA20 $${ind.ema20.toFixed(4)}`);
    }
  }

  const atBearOB  = obs.find(o => o.type === 'bearish' && !o.mitigated && price <= o.high && price >= o.low * 0.998);
  const atBearFVG = fvgs.find(f => f.type === 'bearish' && !f.filled && price <= f.top && price >= f.bottom * 0.998);
  if (intraday && (atBearOB || atBearFVG) && shortEntry <= price * (1 + entryThreshShort)) {
    shortEntry = price;
    if (atBearOB)  { shortOB = atBearOB;   shortReasons.push('現價在空頭 OB 內，市價入場'); }
    if (atBearFVG) { shortFVG = atBearFVG; shortReasons.push('現價在空頭 FVG 內，市價做空'); }
  }

  if (shortEntry > price * (1 + entryThreshShort)) {
    shortReasons.push(intraday ? `等待反彈 $${shortEntry.toFixed(4)} 入場` : '掛限價單，待反彈入場');
  } else if (!atBearOB && !atBearFVG) {
    shortScore -= NO_LEVEL_PENALTY;
    shortReasons.push('⚠ 無明確回測位，扣 3 分');
  }

  // ── Hard gate 3 (intraday): candle pattern + trend alignment ─
  // For intraday we need the current candle to CONFIRM the direction.
  // Without confirmation, the price may be mid-move and the level hasn't held yet.
  const hasLongPattern  = patterns.bullishEngulfing || patterns.hammer;
  const hasShortPattern = patterns.bearishEngulfing || patterns.shootingStar;

  const longIntradayOk = !intraday || (
    hasLongPattern &&                        // candle confirms bullish
    structure.trend !== 'bearish'            // not trading against main trend
  );
  const shortIntradayOk = !intraday || (
    hasShortPattern &&                       // candle confirms bearish
    structure.trend !== 'bullish'            // not trading against main trend
  );

  // ── LONG signal ──────────────────────────────────────────────
  if (longScore >= effectiveMinScore && longGroupsOk && longScore > shortScore && longIntradayOk) {
    const sl   = longOB  ? Math.min(longOB.low  * 0.995, longEntry - slBuffer)
               : longSR  ? Math.min(longSR.price * 0.995, longEntry - slBuffer)
               : longEntry - slBuffer;
    const risk = Math.max(longEntry - sl, 1e-6);

    // Intraday: conservative TP1 (1.2× risk), TP2 (2.0× risk) — achievable in hours
    // Swing: wider TP1 (2.0× risk), TP2 (3.5× risk)
    const tp1Max = intraday ? longEntry + risk * 1.5 : longEntry + risk * 2.0;
    const tp1Raw = resistance ? Math.min(resistance.price, tp1Max) : tp1Max;
    const tp1    = Math.max(tp1Raw, longEntry + risk * MIN_RR);
    const tp2Cap = intraday ? longEntry + risk * 2.0 : longEntry + risk * 3.5;
    const nextR  = srLevels.find(l => l.type === 'resistance' && l.price > tp1 * 1.003 && l.price <= tp2Cap);
    const tp2    = nextR ? Math.min(nextR.price, tp2Cap) : tp2Cap;
    const rr     = parseFloat(((tp1 - longEntry) / risk).toFixed(2));

    if (intraday) {
      longReasons.push(`⏱ 日內單 · TP1 ${((tp1 - longEntry) / longEntry * 100).toFixed(2)}% · SL ${((longEntry - sl) / longEntry * 100).toFixed(2)}%`);
    }
    signals.push({
      id: simpleId(), symbol, direction: 'LONG',
      strength: scoreToStrength(longScore), score: longScore,
      entry: longEntry, takeProfits: [tp1, tp2], stopLoss: sl,
      riskReward: rr, timeframe, timestamp: Date.now(),
      reasons: longReasons, orderBlock: longOB, fvg: longFVG,
      srLevel: longSR ?? support ?? undefined, indicators: ind, isRead: false,
      signalPrice: price,
      regime: regime ?? 'ranging',
      strategy: 'A',
    });
  }

  // ── SHORT signal ─────────────────────────────────────────────
  if (shortScore >= effectiveMinScore && shortGroupsOk && shortScore > longScore && shortIntradayOk) {
    const sl   = shortOB ? Math.max(shortOB.high * 1.005, shortEntry + slBuffer)
               : shortSR ? Math.max(shortSR.price * 1.005, shortEntry + slBuffer)
               : shortEntry + slBuffer;
    const risk = Math.max(sl - shortEntry, 1e-6);

    const tp1Max = intraday ? shortEntry - risk * 1.5 : shortEntry - risk * 2.0;
    const tp1Raw = support ? Math.max(support.price, tp1Max) : tp1Max;
    const tp1    = Math.min(tp1Raw, shortEntry - risk * MIN_RR);
    const tp2Cap = intraday ? shortEntry - risk * 2.0 : shortEntry - risk * 3.5;
    const nextS  = srLevels.find(l => l.type === 'support' && l.price < tp1 * 0.997 && l.price >= tp2Cap);
    const tp2    = nextS ? Math.max(nextS.price, tp2Cap) : tp2Cap;
    const rr     = parseFloat(((shortEntry - tp1) / risk).toFixed(2));

    if (intraday) {
      shortReasons.push(`⏱ 日內單 · TP1 ${((shortEntry - tp1) / shortEntry * 100).toFixed(2)}% · SL ${((sl - shortEntry) / shortEntry * 100).toFixed(2)}%`);
    }
    signals.push({
      id: simpleId(), symbol, direction: 'SHORT',
      strength: scoreToStrength(shortScore), score: shortScore,
      entry: shortEntry, takeProfits: [tp1, tp2], stopLoss: sl,
      riskReward: rr, timeframe, timestamp: Date.now(),
      reasons: shortReasons, orderBlock: shortOB, fvg: shortFVG,
      srLevel: shortSR ?? resistance ?? undefined, indicators: ind, isRead: false,
      signalPrice: price,
      regime: regime ?? 'ranging',
      strategy: 'A',
    });
  }

  return signals;
}

// ════════════════════════════════════════════════════════════════
// Strategy B — Mean Reversion (ranging regime, 1H timeframe)
//
// Hard gates (both must be true):
//   LONG : price touches BB(20,2) lower band AND RSI crosses above 30
//   SHORT: price touches BB(20,2) upper band AND RSI crosses below 70
//
// TP = BB middle; SL = closer of (entry±1.0ATR) or (band±0.5ATR)
// Own MIN_SCORE_B = 10; route still applies STRONG_THRESHOLD = 15.
// ════════════════════════════════════════════════════════════════
const MIN_SCORE_B = 10;
const MIN_RR_B    = 1.5;

export function generateMeanReversionSignals(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
): TradingSignal[] {
  if (candles.length < 35) return [];

  const ind     = computeIndicators(candles);
  const prevInd = computeIndicators(candles.slice(0, -1));

  const bb = ind.bb;
  if (!bb || isNaN(bb.upper) || isNaN(bb.lower) || isNaN(bb.middle)) return [];

  const cur      = candles[candles.length - 1];
  const price    = cur.close;
  const atrVal   = calcAtr(candles);
  const volRatio = calcVolRatio(candles);
  const patterns = detectCandlePatterns(candles);
  const signals: TradingSignal[] = [];

  // ── LONG: BB lower touch + RSI crosses above 30 ─────────────
  const rsiCrossAbove30 = prevInd.rsi < 30 && ind.rsi >= 30;
  const atBBLower       = price <= bb.lower * 1.002;

  if (rsiCrossAbove30 && atBBLower) {
    const entry = price;
    const tp1   = bb.middle;

    // SL: closer to entry wins → max() for LONG
    const slAtr     = entry - atrVal;
    const slChannel = bb.lower - atrVal * 0.5;
    const sl        = Math.max(slAtr, slChannel);

    const risk = Math.max(entry - sl, 1e-6);
    const rr   = (tp1 - entry) / risk;

    if (rr >= MIN_RR_B) {
      let score = 10;
      const reasons: string[] = [
        '策略B: 均值回歸做多',
        `RSI 回升穿越30（${prevInd.rsi.toFixed(1)} → ${ind.rsi.toFixed(1)}）`,
        `觸及布林下軌 $${bb.lower.toFixed(4)}`,
        `止盈目標：布林中軌 $${bb.middle.toFixed(4)}`,
      ];

      if (volRatio >= 1.3)                           { score += 3; reasons.push(`放量確認 ${volRatio.toFixed(1)}×`); }
      if (patterns.hammer || patterns.bullishEngulfing) { score += 3; reasons.push(patterns.hammer ? '錘子線確認' : '看漲吞噬確認'); }
      if (prevInd.rsi < 25)                          { score += 2; reasons.push(`RSI 深度超賣 ${prevInd.rsi.toFixed(1)}`); }
      if (bb.bandwidth < 0.05)                       { score += 1; reasons.push('布林帶收窄，回歸動能強'); }

      if (score >= MIN_SCORE_B) {
        signals.push({
          id: simpleId(), symbol, direction: 'LONG',
          strength: scoreToStrength(score), score,
          entry, takeProfits: [tp1, tp1], stopLoss: sl,
          riskReward: parseFloat(rr.toFixed(2)),
          timeframe, timestamp: Date.now(),
          reasons, indicators: ind, isRead: false,
          signalPrice: price, regime: 'ranging', strategy: 'B',
        });
      }
    }
  }

  // ── SHORT: BB upper touch + RSI crosses below 70 ────────────
  const rsiCrossBelow70 = prevInd.rsi > 70 && ind.rsi <= 70;
  const atBBUpper       = price >= bb.upper * 0.998;

  if (rsiCrossBelow70 && atBBUpper) {
    const entry = price;
    const tp1   = bb.middle;

    // SL: closer to entry wins → min() for SHORT
    const slAtr     = entry + atrVal;
    const slChannel = bb.upper + atrVal * 0.5;
    const sl        = Math.min(slAtr, slChannel);

    const risk = Math.max(sl - entry, 1e-6);
    const rr   = (entry - tp1) / risk;

    if (rr >= MIN_RR_B) {
      let score = 10;
      const reasons: string[] = [
        '策略B: 均值回歸做空',
        `RSI 回落穿越70（${prevInd.rsi.toFixed(1)} → ${ind.rsi.toFixed(1)}）`,
        `觸及布林上軌 $${bb.upper.toFixed(4)}`,
        `止盈目標：布林中軌 $${bb.middle.toFixed(4)}`,
      ];

      if (volRatio >= 1.3)                              { score += 3; reasons.push(`放量確認 ${volRatio.toFixed(1)}×`); }
      if (patterns.shootingStar || patterns.bearishEngulfing) { score += 3; reasons.push(patterns.shootingStar ? '流星線確認' : '看跌吞噬確認'); }
      if (prevInd.rsi > 75)                             { score += 2; reasons.push(`RSI 深度超買 ${prevInd.rsi.toFixed(1)}`); }
      if (bb.bandwidth < 0.05)                          { score += 1; reasons.push('布林帶收窄，回歸動能強'); }

      if (score >= MIN_SCORE_B) {
        signals.push({
          id: simpleId(), symbol, direction: 'SHORT',
          strength: scoreToStrength(score), score,
          entry, takeProfits: [tp1, tp1], stopLoss: sl,
          riskReward: parseFloat(rr.toFixed(2)),
          timeframe, timestamp: Date.now(),
          reasons, indicators: ind, isRead: false,
          signalPrice: price, regime: 'ranging', strategy: 'B',
        });
      }
    }
  }

  return signals;
}

// Highest timeframe's direction is the master — filter out conflicting directions.
// Prevents simultaneous LONG (1h) + SHORT (4h) signals for the same coin.
const TF_RANK: Partial<Record<Timeframe, number>> = { '1d': 5, '4h': 4, '1h': 3, '15m': 2, '5m': 1 };

export function unifySignalDirection(signals: TradingSignal[]): TradingSignal[] {
  if (signals.length === 0) return [];
  const master = [...signals].sort(
    (a, b) => (TF_RANK[b.timeframe] ?? 0) - (TF_RANK[a.timeframe] ?? 0),
  )[0];
  return signals.filter(s => s.direction === master.direction);
}
