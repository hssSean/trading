import { describe, it, expect } from 'vitest';
import { isCryptoPerp } from '../src/api/binance';
import { isExcludedSymbol } from '../src/lib/s3s1/rules';

// 2026-11-12：幣安有 237 個股票／商品／外匯合約與數個指數合約，不能進 S3／S1／BR 的幣池與廣度。
describe('isCryptoPerp', () => {
  const s = (o: Partial<{ contractType: string; quoteAsset: string; underlyingType: string }>) =>
    ({ contractType: 'PERPETUAL', quoteAsset: 'USDT', underlyingType: 'COIN', ...o });
  it('加密貨幣永續與盤前合約算', () => {
    expect(isCryptoPerp(s({}))).toBe(true);
    expect(isCryptoPerp(s({ underlyingType: 'PREMARKET' }))).toBe(true);
  });
  it('股票、商品、外匯、指數不算（即使 contractType 被標成 PERPETUAL）', () => {
    for (const u of ['EQUITY', 'HK_EQUITY', 'KR_EQUITY', 'CN_EQUITY', 'COMMODITY', 'FX', 'INDEX']) expect(isCryptoPerp(s({ underlyingType: u }))).toBe(false);
    expect(isCryptoPerp(s({ contractType: 'TRADIFI_PERPETUAL', underlyingType: 'EQUITY' }))).toBe(false);
  });
  it('交割合約、非 USDT 計價不算；沒有 underlyingType（testnet／舊格式）不擋', () => {
    expect(isCryptoPerp(s({ contractType: 'CURRENT_QUARTER' }))).toBe(false);
    expect(isCryptoPerp(s({ quoteAsset: 'USDC' }))).toBe(false);
    expect(isCryptoPerp({ contractType: 'PERPETUAL', quoteAsset: 'USDT' })).toBe(true);
  });
  it('指數的名稱清單也補上 ALL', () => {
    expect(isExcludedSymbol('ALLUSDT')).toBe(true);
    expect(isExcludedSymbol('BTCDOMUSDT')).toBe(true);
    expect(isExcludedSymbol('BTCUSDT')).toBe(false);
  });
});
