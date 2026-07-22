export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export type Timeframe = '5m' | '15m' | '1h' | '4h' | '1d';
export type SignalDirection = 'LONG' | 'SHORT';
export type SignalStrength = 'WEAK' | 'MODERATE' | 'STRONG';

export interface OrderBlock {
  type: 'bullish' | 'bearish';
  high: number;
  low: number;
  open: number;
  close: number;
  time: number;
  strength: number;
  mitigated: boolean;
}

export interface FairValueGap {
  type: 'bullish' | 'bearish';
  top: number;
  bottom: number;
  time: number;
  filled: boolean;
}

export interface SwingPoint {
  type: 'high' | 'low';
  price: number;
  time: number;
  index: number;
}

export interface MarketStructure {
  trend: 'bullish' | 'bearish' | 'ranging';
  lastBOS: { direction: 'bullish' | 'bearish'; price: number; time: number } | null;
  lastChoCH: { direction: 'bullish' | 'bearish'; price: number; time: number } | null;
  swingHighs: SwingPoint[];
  swingLows: SwingPoint[];
}

export interface SRLevel {
  price: number;
  type: 'support' | 'resistance';
  strength: number;
  lastTouchTime: number;
  touchCount: number;
}

export type Regime = 'trending' | 'ranging' | 'transitional';

export interface BollingerBands {
  upper: number;
  middle: number;
  lower: number;
  bandwidth: number;
}

export interface DonchianChannel {
  upper: number;
  lower: number;
  middle: number;
}

export interface TechnicalIndicators {
  rsi: number;
  macd: number;
  macdSignal: number;
  macdHistogram: number;
  ema20: number;
  ema50: number;
  ema200: number;
  trend: 'bullish' | 'bearish' | 'neutral';
  // Previous-candle values, read from the same series (avoids a 2nd full compute)
  rsiPrev?: number;
  macdHistogramPrev?: number;
  // Phase 1 additions — optional for backward compat
  adx?: number;
  adxPlus?: number;  // +DI
  adxMinus?: number; // -DI
  bb?: BollingerBands;
  donchian?: DonchianChannel;
  atrPercentile?: number; // 0-100, position in 90-day ATR distribution
}

// v2 spec §5: per-group score contributions, persisted for win-rate attribution (§6)
export interface ScoreBreakdown {
  trend: number;
  momentum: number;
  structure: number;
  volume: number;
  priceAction: number;
  penalties: number; // negative; includes no-level penalty
}

export interface TradingSignal {
  id: string;
  symbol: string;
  direction: SignalDirection;
  strength: SignalStrength;
  score: number;
  entry: number;
  takeProfits: number[];
  stopLoss: number;
  riskReward: number;
  timeframe: Timeframe;
  timestamp: number;
  reasons: string[];
  orderBlock?: OrderBlock;
  fvg?: FairValueGap;
  srLevel?: SRLevel;
  indicators: TechnicalIndicators;
  isRead: boolean;
  signalPrice?: number;
  // Phase 1/2/3/4 additions — optional for backward compat
  regime?: Regime;
  fundingRate?: number;
  strategy?: 'A' | 'B' | 'C';
  confidence?: number; // 0-100; informational only (not used as gate yet)
  // Phase 5: position sizing guidance — informational, user applies manually
  suggestedRiskPct?: number;  // 0.5 | 1.0 | 1.5 — from ATR percentile
  suggestedLeverage?: number; // risk% / SL-distance%, capped 10x
  // v2.1 §2: signal tier — A (65+, ≥3 groups, 1% risk) | B (55-64, ≥2 groups, 0.5% risk)
  tier?: 'A' | 'B';
  scoreBreakdown?: ScoreBreakdown;
}

export interface WatchedCoin {
  symbol: string;
  displayName: string;
  baseAsset: string;
  quoteAsset: string;
  timeframes: Timeframe[];
  currentPrice: number;
  priceChange24h: number;
  priceChangePercent24h: number;
  lastAnalyzed: number;
  signals: TradingSignal[];
  isLoading: boolean;
}

export interface AppSettings {
  analysisIntervalMinutes: number;
  notificationsEnabled: boolean;
  minSignalStrength: SignalStrength;
  defaultTimeframes: Timeframe[];
  vibrationEnabled: boolean;
  soundEnabled: boolean;
  accountSize: number;      // USDT, for position sizing
  riskPctPerTrade?: number; // % of account risked per A-tier trade (default 1; B tier = half)
}

export type TradeResult = 'WIN_TP1' | 'WIN_TP2' | 'LOSS' | 'MANUAL_CLOSE';

export interface TradeRecord {
  id: string;
  signalId: string;
  symbol: string;
  direction: SignalDirection;
  timeframe: Timeframe;
  strength: SignalStrength;
  score: number;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  reasons: string[];
  entryNotes?: string;
  openedAt: number;
  filledAt?: number;           // timestamp when limit order was filled (undefined for market orders)
  closedAt?: number;
  result?: TradeResult;
  exitPrice?: number;
  pnlPercent?: number;
  status?: 'waiting' | 'active' | 'tp1_hit'; // 'tp1_hit' = TP1 reached, monitoring for TP2
  signalPrice?: number;           // market price when signal was generated
  tier?: 'A' | 'B';               // v2.1 signal tier (B = half-risk light position)
  scoreBreakdown?: ScoreBreakdown; // per-group contributions for attribution
  currentStop?: number;           // live trailing stop level (set after TP1)
}

export interface AnalysisResult {
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
  orderBlocks: OrderBlock[];
  fvgs: FairValueGap[];
  srLevels: SRLevel[];
  structure: MarketStructure;
  indicators: TechnicalIndicators;
  signals: TradingSignal[];
}
