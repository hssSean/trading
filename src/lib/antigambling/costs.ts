// 移植自 core/ingest/costs.py（逐函式對照）。
// 三市場交易成本模型：使用者沒提供 fees 時用常見費率自動估算，
// 讓盈虧回到誠實的數字（忽略成本是賭徒最常見的自我欺騙）。

import { Market, Side } from './markets';

export interface CostModel {
  commissionRate: number;      // 手續費率（以契約價值計）
  commissionMin: number;       // 最低手續費（每筆）
  taxRate: number;             // 交易稅率
  slippageRate: number;        // 預估滑價率（每邊）
  commissionPerUnit?: number;  // 每口固定手續費（期貨常見）
  taxBothSides?: boolean;      // 稅是否買賣雙邊都收
  sellPerShareFee?: number;     // 賣出端按股數規費（FINRA TAF）
  sellPerShareFeeCap?: number;  // 每筆上限
}

/** 估算「單邊」成本（進場一次、出場一次各算一次）。稅基一律用契約價值。 */
function estimateSide(
  m: CostModel,
  price: number,
  quantity: number,
  isSell: boolean,
  contractMultiplier = 1.0,
): number {
  const value = Math.abs(price * quantity * contractMultiplier);
  const commission = Math.max(
    value * m.commissionRate + (m.commissionPerUnit ?? 0) * Math.abs(quantity),
    m.commissionMin,
  );
  const chargeTax = isSell || !!m.taxBothSides;
  const tax = chargeTax ? value * m.taxRate : 0.0;
  // 賣出端按股數的規費（FINRA TAF）：低價例外 —— 成交價低於每股費率時不收
  let perShare = 0.0;
  const psf = m.sellPerShareFee ?? 0;
  if (isSell && psf > 0 && price >= psf) {
    perShare = psf * Math.abs(quantity);
    const cap = m.sellPerShareFeeCap ?? 0;
    if (cap > 0) perShare = Math.min(perShare, cap);
  }
  const slippage = value * m.slippageRate;
  return commission + tax + perShare + slippage;
}

// 各市場預設成本模型（2026 年常見值，僅供估算）
export const DEFAULT_COST_MODELS: Record<Market, CostModel> = {
  tw_stock: { commissionRate: 0.001425, commissionMin: 20.0, taxRate: 0.003, slippageRate: 0.0005 },
  us_stock: {
    commissionRate: 0.0, commissionMin: 0.0, taxRate: 0.0000206, slippageRate: 0.0005,
    sellPerShareFee: 0.000195, sellPerShareFeeCap: 9.79,
  },
  crypto:   { commissionRate: 0.001, commissionMin: 0.0, taxRate: 0.0, slippageRate: 0.0010 },
  tw_etf:   { commissionRate: 0.001425, commissionMin: 20.0, taxRate: 0.001, slippageRate: 0.0005 },
  tw_futures: {
    commissionRate: 0.0, commissionMin: 0.0, commissionPerUnit: 20.0,
    taxRate: 0.00002, taxBothSides: true, slippageRate: 0.00005,
  },
  tw_options: {
    commissionRate: 0.0, commissionMin: 0.0, commissionPerUnit: 15.0,
    taxRate: 0.001, taxBothSides: true, slippageRate: 0.0010,
  },
  forex:    { commissionRate: 0.0, commissionMin: 0.0, taxRate: 0.0, slippageRate: 0.0002 },
  unknown:  { commissionRate: 0.001, commissionMin: 0.0, taxRate: 0.0, slippageRate: 0.0005 },
};

// 台股現股當沖證交稅減半（0.3% → 0.15%），截至 2026 年仍有效
export const TW_DAY_TRADE_TAX_RATE = 0.0015;

/** 估算一筆「完整來回」交易的總成本（進場 + 出場）。 */
export function estimateRoundTripCost(
  market: Market,
  side: Side,
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  opts: { isDayTrade?: boolean; contractMultiplier?: number; model?: CostModel } = {},
): number {
  let m = opts.model ?? DEFAULT_COST_MODELS[market] ?? DEFAULT_COST_MODELS.unknown;
  const mult = opts.contractMultiplier ?? 1.0;

  // 台股當沖：證交稅減半（只調稅率，不動其他參數）
  if (opts.isDayTrade && market === 'tw_stock' && m.taxRate > TW_DAY_TRADE_TAX_RATE) {
    m = { ...m, taxRate: TW_DAY_TRADE_TAX_RATE };
  }

  if (side === 'long') {
    return estimateSide(m, entryPrice, quantity, false, mult)
         + estimateSide(m, exitPrice, quantity, true, mult);
  }
  // short：賣出（進場，收稅）→ 買回（出場，不收稅）
  return estimateSide(m, entryPrice, quantity, true, mult)
       + estimateSide(m, exitPrice, quantity, false, mult);
}
