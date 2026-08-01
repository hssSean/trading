// 推薦單失效（掛單未成交）影子模擬 —— docs/TODO.md 2026-08-01 策略檢討。
//
// 背景：策略A的進場永遠是「等回調」（多單掛現價下方、空單掛現價上方），但能
// 拿到高分的訊號，靠的正是 EMA 完美排列/BOS突破/大時框偏多空+3 這些「趨勢夠
// 強」的證據——這正是市場最不容易回調的時候。8/1 當日 10 筆候選全數
// 推薦單失效（4筆直達TP1未成交、5筆逾期未成交、1筆行情走遠），懷疑「等回調」
// 設計跟「趨勢夠強才給高分」互相矛盾，但沒有數據能回答「如果當下直接市價
// 進場，淨R會是正是負」。
//
// 做法：跟 timeStopShadow.ts 同一套模式——每筆掛單被取消時，額外模擬「用
// 訊號當下價格（signal_price，即 sp）市價進場」會怎樣，從取消當下開始
// walkTpSl 走到真正的 TP/SL（或跟到 7 天上限放棄）。
//
// 跟時間止損影子模擬不同的地方：這裡沒有「真實出場R」可以當基準比較——
// 真實情況下這筆單從未成交，真實R固定是0。netR本身就是完整的答案：
// 正值代表「早該市價進場，白白錯過」；負值/接近0代表「等回調是對的，
// 沒等到反而躲過虧損」。四種取消原因分開統計（cancel_tp1_direct/
// cancel_ran_away 兩種是價格已朝有利方向走的情況，理論上最可能正值；
// cancel_expired 是原地沒動的情況，勝負未知；cancel_thesis_invalidated
// 是收盤已破壞止損位的情況，理論上最可能負值）。

import type { WalkCandle } from './monitorMath';
import { walkTpSl } from './monitorMath';

export type CancelTrigger =
  | 'cancel_thesis_invalidated' | 'cancel_ran_away'
  | 'cancel_tp1_direct'         | 'cancel_expired';

export type CancelShadowResult = 'WIN_TP1' | 'WIN_TP2' | 'LOSS' | 'STILL_OPEN';

export interface CancelShadow {
  id: string;              // 對應真實 trade id，1:1，不會重複建立
  symbol: string;
  direction: 'LONG' | 'SHORT';
  timeframe: string;
  hypotheticalEntry: number; // 訊號當下價格（signal_price）——假設市價進場的價位
  stopLoss: number;
  tp1: number;
  tp2: number;
  trigger: CancelTrigger;
  cancelledAt: number;
  status: 'live' | 'done';
  tp1Hit: boolean;
  result?: CancelShadowResult;
  exitPrice?: number;
  closedAt?: number;
  lastCheckedAt: number;
}

// 追蹤上限跟時間止損影子模擬同一個數字：超過這麼久還沒走到 TP/SL 就放棄。
export const CANCEL_SHADOW_FOLLOW_MS = 7 * 24 * 3600 * 1000;

export function startCancelShadow(params: {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  timeframe: string;
  hypotheticalEntry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  trigger: CancelTrigger;
  cancelledAt: number;
}): CancelShadow {
  return {
    ...params,
    status: 'live',
    tp1Hit: false,
    lastCheckedAt: params.cancelledAt,
  };
}

// 純函數：回傳更新後的新物件，不修改輸入。candles 需為 1h K 線，closeTime 需
// 覆蓋 cancelledAt 之後的區間（呼叫端負責抓正確窗口）。
export function advanceCancelShadow(
  s: CancelShadow,
  candles: WalkCandle[],
  now: number,
): CancelShadow {
  if (s.status !== 'live') return s;

  const isLong = s.direction === 'LONG';
  const outcome = walkTpSl(
    candles, s.cancelledAt,
    { entry: s.hypotheticalEntry, stopLoss: s.stopLoss, tp1: s.tp1, tp2: s.tp2, isLong },
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

  if (now - s.cancelledAt > CANCEL_SHADOW_FOLLOW_MS) {
    const lastClose = candles.length > 0 ? candles[candles.length - 1].close : s.hypotheticalEntry;
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

export interface CancelShadowStat {
  win: number;
  loss: number;
  stillOpen: number;
  live: number;
  netR: number; // 「如果當下市價進場」的模擬淨R——沒有真實R可比較，這個數字本身就是答案
}

// 依取消原因分組。netR > 0 代表這類取消白白錯過了獲利，該考慮讓進場邏輯
// 對這類情況允許近市價進場；netR ≤ 0 代表等回調是對的，不要動。
export function aggregateCancelShadows(
  shadows: CancelShadow[],
): Record<CancelTrigger, CancelShadowStat> {
  const stats: Record<string, CancelShadowStat> = {};
  for (const s of shadows) {
    const g = (stats[s.trigger] ??= { win: 0, loss: 0, stillOpen: 0, live: 0, netR: 0 });
    const risk = Math.abs(s.hypotheticalEntry - s.stopLoss);
    const rOf = (exit: number) =>
      risk > 0 ? (s.direction === 'LONG' ? exit - s.hypotheticalEntry : s.hypotheticalEntry - exit) / risk : 0;

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
  }
  return stats as Record<CancelTrigger, CancelShadowStat>;
}
