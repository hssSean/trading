import { describe, it, expect } from 'vitest';
import { tp1MarkPayload, tp1RollbackPayload, resultOnTp1FinalClose } from '../src/lib/tp1Mark';

// 這一組測試釘住的不變量只有一條：
//
//     status === 'tp1_hit'  ⇒  result === 'WIN_TP1'
//
// 兩個寫入者（route.ts 的 DB 模擬、live-runner 的真倉）在 2026-09-19 之前
// 對這條的認知不一致：route.ts 標 TP1 時同時寫 status 與 result，
// live-runner 的 markTp1Hit 只寫 status。單看兩邊都說得通，交接時才出事——
// route.ts 關一筆 status='tp1_hit' 的單時走 isFinalClosingTp1 分支，
// **刻意不覆寫 result**（它假設 TP1 當下已經寫過了），於是 result 永遠是 NULL。
//
// 下游沒有任何錯誤訊息，只是靜默算錯：activeCooldowns 用
// `result === 'LOSS'` 判虧損冷卻，NULL 拿不到 24h 同向鎖定。

describe('tp1MarkPayload', () => {
  it('同時寫 status 與 result —— 只寫 status 正是 2026-09-19 抓到的 bug', () => {
    expect(tp1MarkPayload()).toEqual({ status: 'tp1_hit', result: 'WIN_TP1' });
  });
});

describe('tp1RollbackPayload', () => {
  // live-runner 有一段反向自我修復：DB 說 tp1_hit，但那張 TP1 條件單此刻
  // 還掛在交易所上（＝一定沒成交），於是把 status 退回 active。
  // 既然標記時會寫 result，回滾就必須一起清掉，否則會留下一筆
  // 「還在跑、卻已經記成 WIN_TP1」的活單。
  it('把 status 退回 active 的同時清掉 result', () => {
    expect(tp1RollbackPayload()).toEqual({ status: 'active', result: null });
  });
});

describe('resultOnTp1FinalClose', () => {
  it('走到 TP2 → 升級成 WIN_TP2', () => {
    expect(resultOnTp1FinalClose('WIN_TP1', 'WIN_TP2')).toEqual({ result: 'WIN_TP2' });
  });

  it('已經有 WIN_TP1 且不是升級 → 不動它（維持既有行為）', () => {
    expect(resultOnTp1FinalClose('WIN_TP1', 'LOSS')).toEqual({});
  });

  it('result 是 NULL 的 tp1_hit 單關單時補寫 WIN_TP1 —— 這是修掉的漏洞', () => {
    expect(resultOnTp1FinalClose(null, 'LOSS')).toEqual({ result: 'WIN_TP1' });
  });

  it('result 是 NULL 且走到 TP2 → 直接寫 WIN_TP2，不是 WIN_TP1', () => {
    expect(resultOnTp1FinalClose(null, 'WIN_TP2')).toEqual({ result: 'WIN_TP2' });
  });

  it('undefined 跟 null 一樣處理（欄位沒被 select 出來時）', () => {
    expect(resultOnTp1FinalClose(undefined, 'MANUAL_CLOSE')).toEqual({ result: 'WIN_TP1' });
  });
});
