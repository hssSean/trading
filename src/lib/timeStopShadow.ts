// 時間止損影子模擬（docs/TODO.md P1 #1，最有價值的量測盲區）。
//
// 背景：62.5%（15/24）的單走時間止損出場，平均 +0.244R，但完全沒有數據能回答
// 「如果不砍會怎樣」——可能砍掉了正在醞釀的贏家。這裡把每一筆被時間止損強制
// 關掉的真實交易，從關單當下繼續模擬到真正的 TP/SL（或跟到 7 天上限放棄），
// 算出「如果讓它繼續走」的淨 R，拿來跟真實出場的 R 比較。
//
// 觸發來源只有兩種（都是「還沒到 TP1 就被時間強制關掉」，跟已經鎖利的
// TP1 後到期平倉是不同性質，不列入）：
//   'stall'  — 8 根 K 線停滯在 ±0.3R（route.ts 的 timeStopFired）
//   'expiry' — 24h/72h/168h 到期，且尚未達 TP1

import type { WalkCandle } from './monitorMath';
import { walkTpSl } from './monitorMath';

export type TimeStopTrigger = 'stall' | 'expiry';
export type TimeStopResult = 'WIN_TP1' | 'WIN_TP2' | 'LOSS' | 'STILL_OPEN';

export interface TimeStopShadow {
  id: string;              // 對應真實 trade id，1:1，不會重複建立
  symbol: string;
  direction: 'LONG' | 'SHORT';
  timeframe: string;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  trigger: TimeStopTrigger;
  realExitPrice: number;   // 真實出場價（時間止損當下）
  realClosedAt: number;    // 真實出場時間
  status: 'live' | 'done';
  tp1Hit: boolean;
  result?: TimeStopResult;
  exitPrice?: number;
  closedAt?: number;
  lastCheckedAt: number;
}

// 追蹤上限：超過這麼久還沒走到 TP/SL 就放棄，標記 STILL_OPEN（不計入勝敗，
// 避免無限期佔用 Redis 空間，也避免用過舊的價格去談「如果不砍」）。
export const TIME_STOP_SHADOW_FOLLOW_MS = 7 * 24 * 3600 * 1000;

export function startTimeStopShadow(params: {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  timeframe: string;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  trigger: TimeStopTrigger;
  realExitPrice: number;
  realClosedAt: number;
}): TimeStopShadow {
  return {
    ...params,
    status: 'live',
    tp1Hit: false,
    lastCheckedAt: params.realClosedAt,
  };
}

// 純函數：回傳更新後的新物件，不修改輸入。candles 需為 1h K 線，closeTime 需
// 覆蓋 realClosedAt 之後的區間（呼叫端負責抓正確窗口，跟 monitorActiveTrades
// 的 fetchCandles 用法一致）。
export function advanceTimeStopShadow(
  s: TimeStopShadow,
  candles: WalkCandle[],
  now: number,
): TimeStopShadow {
  if (s.status !== 'live') return s;

  const isLong = s.direction === 'LONG';
  const outcome = walkTpSl(
    candles, s.realClosedAt,
    { entry: s.entry, stopLoss: s.stopLoss, tp1: s.tp1, tp2: s.tp2, isLong },
    s.tp1Hit,
  );

  if (outcome.done) {
    return {
      ...s,
      status: 'done',
      tp1Hit: outcome.tp1Hit,
      result: outcome.result,
      exitPrice: outcome.exitPrice,
      closedAt: outcome.closedAt,
      lastCheckedAt: now,
    };
  }

  if (now - s.realClosedAt > TIME_STOP_SHADOW_FOLLOW_MS) {
    const lastClose = candles.length > 0 ? candles[candles.length - 1].close : s.realExitPrice;
    return {
      ...s,
      status: 'done',
      tp1Hit: outcome.tp1Hit,
      result: 'STILL_OPEN',
      exitPrice: outcome.tp1Hit ? s.tp1 : lastClose,
      closedAt: now,
      lastCheckedAt: now,
    };
  }

  return { ...s, tp1Hit: outcome.tp1Hit, lastCheckedAt: now };
}

export interface TimeStopStat {
  win: number;
  loss: number;
  stillOpen: number;
  live: number;
  netR: number;       // 「如果不砍會怎樣」的模擬淨 R
  realNetR: number;   // 真實時間止損出場的淨 R（同一批單，方便直接比較）
}

// 依 trigger 分組，回傳模擬淨R vs 真實淨R——正差值代表「時間止損確實砍在半路，
// 讓它走完會更好」；負或接近0代表「時間止損砍得對，繼續放著更差或差不多」。
export function aggregateTimeStopShadows(
  shadows: TimeStopShadow[],
): Record<TimeStopTrigger, TimeStopStat> {
  const stats: Record<string, TimeStopStat> = {};
  for (const s of shadows) {
    const g = (stats[s.trigger] ??= { win: 0, loss: 0, stillOpen: 0, live: 0, netR: 0, realNetR: 0 });
    const risk = Math.abs(s.entry - s.stopLoss);
    const rOf = (exit: number) =>
      risk > 0 ? (s.direction === 'LONG' ? exit - s.entry : s.entry - exit) / risk : 0;

    g.realNetR += rOf(s.realExitPrice);

    if (s.status !== 'done') { g.live++; continue; }
    if (s.result === 'WIN_TP1' || s.result === 'WIN_TP2') {
      g.win++;
      g.netR += rOf(s.exitPrice ?? s.tp1);
    } else if (s.result === 'LOSS') {
      g.loss++;
      g.netR -= 1;
    } else {
      g.stillOpen++;
      if (s.exitPrice) g.netR += rOf(s.exitPrice);
    }
  }
  for (const g of Object.values(stats)) {
    g.netR = parseFloat(g.netR.toFixed(2));
    g.realNetR = parseFloat(g.realNetR.toFixed(2));
  }
  return stats as Record<TimeStopTrigger, TimeStopStat>;
}
