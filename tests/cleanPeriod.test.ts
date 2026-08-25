import { describe, it, expect } from 'vitest';
import {
  CLEAN_DATA_SINCE, RISK_CONTROL_GAP_START, RISK_CONTROL_GAP_END,
  isCleanPeriod, isInRiskControlGap,
} from '../src/lib/cleanPeriod';

// 這條分界線決定「哪些交易的統計可以拿來判斷策略好壞」。判錯的後果是首頁
// 顯示一個誤導的數字——8/25 查出戰績卡的 +25.8R 幾乎全部來自 8/18 前的
// 污染資料，而乾淨期間其實是 −2.64R。使用者每天看那個數字做判斷。

const day = 24 * 3600 * 1000;

describe('isCleanPeriod', () => {
  it('分界線當下算乾淨（>= 而不是 >）', () => {
    expect(isCleanPeriod({ closedAt: CLEAN_DATA_SINCE })).toBe(true);
  });

  it('分界線前一毫秒算污染', () => {
    expect(isCleanPeriod({ closedAt: CLEAN_DATA_SINCE - 1 })).toBe(false);
  });

  it('分界線之後算乾淨', () => {
    expect(isCleanPeriod({ closedAt: CLEAN_DATA_SINCE + 7 * day })).toBe(true);
  });

  // 還沒平倉的單沒有結果可以統計，不能被當成任一邊——尤其不能被當成
  // 「乾淨期的 0R」把平均拉低。
  it('沒有 closedAt 一律不算（還沒結束）', () => {
    expect(isCleanPeriod({})).toBe(false);
    expect(isCleanPeriod({ closedAt: undefined })).toBe(false);
  });

  it('可以覆寫分界線（給分析腳本用）', () => {
    const t = { closedAt: Date.UTC(2026, 6, 1) };
    expect(isCleanPeriod(t)).toBe(false);
    expect(isCleanPeriod(t, Date.UTC(2026, 5, 1))).toBe(true);
  });
});

describe('isInRiskControlGap', () => {
  // Redis 額度用盡期間訊號鎖／冷卻／熔斷的 fallback 都是「不擋」，
  // 可能有重複發單。資料不是錯的，但特性不同，要能單獨排除。
  it('區間開始當下算在內', () => {
    expect(isInRiskControlGap({ closedAt: RISK_CONTROL_GAP_START })).toBe(true);
  });

  it('區間結束當下算在外（額度重置，風控恢復）', () => {
    expect(isInRiskControlGap({ closedAt: RISK_CONTROL_GAP_END })).toBe(false);
  });

  it('區間中間算在內', () => {
    expect(isInRiskControlGap({ closedAt: RISK_CONTROL_GAP_START + 3 * day })).toBe(true);
  });

  it('區間之前算在外', () => {
    expect(isInRiskControlGap({ closedAt: RISK_CONTROL_GAP_START - 1 })).toBe(false);
  });

  it('沒有 closedAt 不算', () => {
    expect(isInRiskControlGap({})).toBe(false);
  });

  // 風控空窗完全落在乾淨期內——這兩個判斷是獨立的維度，不是互斥的分類。
  // 混淆的話會把空窗期的單從乾淨期整批砍掉，或反過來當成完全正常。
  it('風控空窗期同時也屬於乾淨期', () => {
    const t = { closedAt: RISK_CONTROL_GAP_START + day };
    expect(isCleanPeriod(t)).toBe(true);
    expect(isInRiskControlGap(t)).toBe(true);
  });
});
