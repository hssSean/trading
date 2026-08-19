import { describe, expect, it } from 'vitest';
import { calcTotalOpenRisk, OpenRiskRow } from '../../src/engine/tradeBridge';

// 2026-08-20 實測撞到的死結，原樣搬成測試。live-runner 原本把所有
// closed_at IS NULL 的列都加總，包含「從沒送出過訂單」的 waiting 推薦單：
//
//   HYPEUSDT [skip_entry] 全局風險上限：目前已開 4   + 這筆 1.5 = 5.5 會超過上限 5
//   BNBUSDT  [skip_entry] 全局風險上限：目前已開 4   + 這筆 1.5 = 5.5 會超過上限 5
//   ZECUSDT  [skip_entry] 全局風險上限：目前已開 4   + 這筆 1.5 = 5.5 會超過上限 5
//   ETHUSDT  [skip_entry] 全局風險上限：目前已開 4.5 + 這筆 1   = 5.5 會超過上限 5
//
// 四張單互相把對方擋在門外，而且沒送出就不會成交、不會平倉，5.5 永遠降不下來
// ——系統零下單卡死。錯在把「推薦單」當「持倉」：沒送出的單在交易所端沒有
// 訂單、沒佔保證金、沒有任何曝險。
const MAX_TOTAL_RISK_PCT = 5; // 跟 src/lib/position.ts 同值，這裡只是重現情境

function row(exchangeEntryOrderId: number | null, suggestedRiskPct: number | null): OpenRiskRow {
  return { exchangeEntryOrderId, suggestedRiskPct };
}

describe('calcTotalOpenRisk', () => {
  it('不算從沒送出過訂單的 waiting 推薦單（死結的根因）', () => {
    // 實測那四張，全部都還沒送出去
    const rows = [
      row(null, 1.5), // HYPE
      row(null, 1.5), // BNB
      row(null, 1.5), // ZEC
      row(null, 1.0), // ETH
    ];
    expect(calcTotalOpenRisk(rows)).toBe(0);
  });

  it('修好後這四張不會再互相擋住——第一張進得去', () => {
    const rows = [row(null, 1.5), row(null, 1.5), row(null, 1.5), row(null, 1.0)];
    const wouldBeTotal = calcTotalOpenRisk(rows) + 1.5; // 其他的 + 這筆
    expect(wouldBeTotal).toBeLessThanOrEqual(MAX_TOTAL_RISK_PCT);
  });

  it('已掛單的要算——限價單在幣安端已經佔住保證金，成交後就是真部位', () => {
    const rows = [
      row(111, 1.5),  // 已送出，未成交
      row(222, 1.0),  // 已送出
      row(null, 1.5), // 還沒送出 → 不算
    ];
    expect(calcTotalOpenRisk(rows)).toBe(2.5);
  });

  it('額度用完時仍然正確擋下（這是真的容量限制，不是死結）', () => {
    // 三張已掛單吃掉 4.5，第四張 1.0 會超過 5 → 應該被擋
    const rows = [row(111, 1.5), row(222, 1.5), row(333, 1.5), row(null, 1.0)];
    const placed = calcTotalOpenRisk(rows);
    expect(placed).toBe(4.5);
    expect(placed + 1.0).toBeGreaterThan(MAX_TOTAL_RISK_PCT);
    // 但關鍵差別：這三張是真的有掛單，它們會成交/過期/平倉，額度會自然釋放，
    // 不像原本那樣被永遠不會動的 waiting 單佔死。
  });

  it('suggested_risk_pct 是 null 時當 1（跟原本 ?? 1 的行為一致）', () => {
    expect(calcTotalOpenRisk([row(111, null), row(222, null)])).toBe(2);
  });

  it('空清單回 0，不是 NaN', () => {
    expect(calcTotalOpenRisk([])).toBe(0);
  });
});
