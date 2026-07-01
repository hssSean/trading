export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export type Timeframe = '15m' | '1h' | '4h' | '1d';
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

export interface TechnicalIndicators {
  rsi: number;
  macd: number;
  macdSignal: number;
  macdHistogram: number;
  ema20: number;
  ema50: number;
  ema200: number;
  trend: 'bullish' | 'bearish' | 'neutral';
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
  openedAt: number;
  closedAt?: number;
  result?: TradeResult;
  exitPrice?: number;
  pnlPercent?: number;
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
