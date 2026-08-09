// 時間止損判斷——route.ts 的邏輯照抄，不是重新設計。這是「持有中卻沒有
// 觸發 TP1/SL/移動止損」時，要不要主動關單的判斷，decideTradeAction 沒有
// 覆蓋這塊（見該檔案頂部說明），這裡補上。
//
// 兩種機制：
//   1. 盤整停滯（只在 TP1 之前）：filled 之後過了至少 8 根該時框 K 線，
//      價格進度停在 -0.3R ~ +0.3R 之間（不上不下、沒有推進也沒有逼近
//      止損），市價出場釋放倉位——已經接近止損（< -0.3R）不動，讓原止損
//      決定；已經在推進（> +0.3R）也不動，給它走到 TP1 的機會。
//   2. 到期自動平倉（TP1 前後都適用）：intraday 24h／4h timeframe 72h／
//      1d timeframe 168h，超過就強制平倉，不管進度如何。TP1 之後觸發要用
//      clampAutoCloseAfterTp1 夾住出場價（不會比目前的移動止損保護價差）。
//
// route.ts 用 K 線收盤價（lastClose）判斷；這裡即時輪詢版用當下 markPrice
// 代替——跟 decideTradeAction 判斷 TP1 觸價、calcTrailingStopTarget 棘輪
// 用 markPrice 代替 K 線 high/low/close 是同一類簡化，不是另外設計的邏輯。

import { clampAutoCloseAfterTp1 } from '@/lib/monitorMath';

export type TimeStopTimeframe = '5m' | '15m' | '1h' | '4h' | '1d';

function tfBarMinutes(tf: TimeStopTimeframe): number {
  switch (tf) {
    case '5m':  return 5;
    case '15m': return 15;
    case '4h':  return 240;
    case '1d':  return 1440;
    default:    return 60; // '1h'
  }
}

function autoCloseHours(tf: TimeStopTimeframe): number {
  if (tf === '4h') return 72;
  if (tf === '1d') return 168;
  return 24; // route.ts INTRADAY_CLOSE_HOURS
}

export interface TimeStopInput {
  isLong: boolean;
  entry: number;
  stopLoss: number;
  timeframe: TimeStopTimeframe;
  filledAt: number;      // 成交時間；沒有的話呼叫端用 openedAt 頂替
  now: number;
  markPrice: number;     // 即時價格，代替 route.ts 的 K 線收盤價
  isTp1Hit: boolean;
  trailingStop: number;  // 0 = 尚未初始化；isTp1Hit=false 時不會用到
}

export type TimeStopCloseReason = 'time_stop_stall' | 'time_stop_expiry' | 'time_stop_expiry_post_tp1';

export type TimeStopDecision =
  | { fired: false }
  | { fired: true; closePrice: number; closeReason: TimeStopCloseReason };

export function decideTimeStop(input: TimeStopInput): TimeStopDecision {
  const riskDist = Math.abs(input.entry - input.stopLoss); // 絕對價格差，不是百分比
  if (riskDist <= 0) return { fired: false };

  // 1. 盤整停滯——只在尚未觸及 TP1 時檢查。
  if (!input.isTp1Hit) {
    const barMinutes = tfBarMinutes(input.timeframe);
    const ageBars = (input.now - input.filledAt) / (barMinutes * 60_000);
    if (ageBars >= 8) {
      const progressR = (input.isLong
        ? input.markPrice - input.entry
        : input.entry - input.markPrice) / riskDist;
      if (progressR >= -0.3 && progressR <= 0.3) {
        return { fired: true, closePrice: input.markPrice, closeReason: 'time_stop_stall' };
      }
    }
  }

  // 2. 到期自動平倉——TP1 前後都適用。
  const ageHours = (input.now - input.filledAt) / 3_600_000;
  if (ageHours >= autoCloseHours(input.timeframe)) {
    if (input.isTp1Hit) {
      const closePrice = clampAutoCloseAfterTp1(input.markPrice, input.trailingStop, input.entry, input.isLong);
      return { fired: true, closePrice, closeReason: 'time_stop_expiry_post_tp1' };
    }
    return { fired: true, closePrice: input.markPrice, closeReason: 'time_stop_expiry' };
  }

  return { fired: false };
}
