// 移植自 core/models.py（逐函式對照）。
// 統一資料模型：不論資料來自哪個市場/格式，正規化成 Trade / TradeLog。

import { Market, Side } from './markets';

export interface AgTrade {
  symbol: string;
  market: Market;
  side: Side;
  entryTime: Date;   // naive（已去除時區）
  exitTime: Date;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  fees: number;
  pnl: number;       // 建構時若未提供則由價格推算（已扣 fees）
  tag: string | null;
  contractMultiplier: number;
}

export interface AgTradeLog {
  trades: AgTrade[];
  source: string;
  accountLabel: string;
}

/**
 * 建立一筆交易（等價於 Trade.__post_init__）：
 * - 出場早於進場 → 丟出錯誤（髒資料，直接拒絕）
 * - 未提供 pnl → 由價格推算：(出場-進場)×數量×乘數，做空取反，再扣 fees
 */
export function buildTrade(p: {
  symbol: string;
  market: Market;
  side: Side;
  entryTime: Date;
  exitTime: Date;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  fees?: number;
  pnl?: number | null;
  tag?: string | null;
  contractMultiplier?: number;
}): AgTrade {
  if (p.exitTime.getTime() < p.entryTime.getTime()) {
    throw new Error(
      `${p.symbol}: 出場時間（${fmtDt(p.exitTime)}）早於進場時間（${fmtDt(p.entryTime)}），資料有誤`,
    );
  }
  const fees = p.fees ?? 0.0;
  const mult = p.contractMultiplier ?? 1.0;
  let pnl = p.pnl ?? null;
  if (pnl === null || pnl === undefined) {
    let gross = (p.exitPrice - p.entryPrice) * p.quantity * mult;
    if (p.side === 'short') gross = -gross;
    pnl = gross - fees;
  }
  return {
    symbol: p.symbol,
    market: p.market,
    side: p.side,
    entryTime: p.entryTime,
    exitTime: p.exitTime,
    entryPrice: p.entryPrice,
    exitPrice: p.exitPrice,
    quantity: p.quantity,
    fees,
    pnl,
    tag: p.tag ?? null,
    contractMultiplier: mult,
  };
}

function fmtDt(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 進場時的契約價值（股票即市值；期貨為 價格 × 乘數 × 口數）。 */
export function contractValue(t: AgTrade): number {
  return Math.abs(t.entryPrice * t.quantity * t.contractMultiplier);
}

/** 報酬率（相對於進場契約價值；槓桿商品刻意不用保證金當母體）。 */
export function returnPct(t: AgTrade): number {
  const basis = contractValue(t);
  if (basis === 0) return 0.0;
  return t.pnl / basis;
}

/** 持倉天數。 */
export function holdingDays(t: AgTrade): number {
  return (t.exitTime.getTime() - t.entryTime.getTime()) / 86400000;
}

/** 是否為當沖：進出場在同一「日曆日」（全工具統一口徑）。 */
export function isDayTrade(t: AgTrade): boolean {
  return t.entryTime.getFullYear() === t.exitTime.getFullYear()
    && t.entryTime.getMonth() === t.exitTime.getMonth()
    && t.entryTime.getDate() === t.exitTime.getDate();
}

/** 依出場時間排序（回測與回撤計算需要時間順序）。穩定排序與 Python sorted 一致。 */
export function sortedByTime(log: AgTradeLog): AgTradeLog {
  return {
    trades: [...log.trades].sort((a, b) => a.exitTime.getTime() - b.exitTime.getTime()),
    source: log.source,
    accountLabel: log.accountLabel,
  };
}

export function filterByTag(log: AgTradeLog, tag: string): AgTradeLog {
  return {
    trades: log.trades.filter(t => t.tag === tag),
    source: log.source,
    accountLabel: `${log.accountLabel}::${tag}`,
  };
}

export function filterLog(log: AgTradeLog, predicate: (t: AgTrade) => boolean, label = 'filtered'): AgTradeLog {
  return {
    trades: log.trades.filter(predicate),
    source: log.source,
    accountLabel: `${log.accountLabel}::${label}`,
  };
}
