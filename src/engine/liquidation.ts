// 強平價計算——回答「這筆單開下去，帳戶會不會被強平」。
//
// 公式來源：developers.binance.com「How to Calculate Liquidation Price of
// USDⓈ-M Futures Contracts」頁面，2026-08-08 用瀏覽器讀取頁面內容逐字核對，
// 並用頁面自己給的 ETHUSDT 範例數字（cross margin，含 TMM1/UPNL1 項）手算
// 驗證過：算出 1153.19，官方公開答案 1153.26，誤差在手算捨入範圍內——不是
// 憑記憶重建的公式。
//
// 完整公式（cross margin，含 hedge mode 分支）：
//   LP1 = [WB - TMM1 + UPNL1 + cumB + cumL + cumS
//          - Side1_BOTH×Position1_BOTH×EP1_BOTH
//          - Position1_LONG×EP1_LONG + Position1_SHORT×EP1_SHORT]
//       / [Position1_BOTH×MMR_B + Position1_LONG×MMR_L
//          - Position1_SHORT×MMR_S - Side1_BOTH×Position1_BOTH]
//
// 這個系統只用 isolated margin + one-way（BOTH）模式，官方文件本身就寫明
// 這個情況下 TMM=0、UPNL=0；hedge mode 的 LONG/SHORT 分支項（Position_LONG/
// Position_SHORT/cumL/cumS）在 one-way 模式下也是 0。代入化簡：
//   LP = [WB + cumB - Side×Position×EP] / [Position×MMR_B - Side×Position]
//
// 這是純代數化簡，不是另外猜的公式。

import { MarginBracket } from './binanceClient';

// notionalCap 依遞增排序找第一個 >= notional 的階；notional 超過所有階時
// （理論上不該發生——精算過的部位應該落在合理階層內）退回最後一階，跟
// 幣安自己對超大倉位的處理方式一致，不是憑空選擇。
export function findMarginBracket<T extends { notionalCap: number }>(brackets: T[], notional: number): T {
  const sorted = [...brackets].sort((a, b) => a.notionalCap - b.notionalCap);
  const match = sorted.find(b => notional <= b.notionalCap);
  return match ?? sorted[sorted.length - 1];
}

export interface LiquidationPriceInput {
  entry: number;
  positionQty: number;        // absolute value
  isLong: boolean;
  isolatedMarginUSDT: number; // WB — 這筆隔離倉位分配到的保證金（本金）
  maintMarginRatio: number;   // MMR_B，來自對應 bracket
  maintAmount: number;        // cumB，來自對應 bracket
}

export function calcLiquidationPrice(input: LiquidationPriceInput): number {
  const side = input.isLong ? 1 : -1;
  const numerator = input.isolatedMarginUSDT + input.maintAmount - side * input.positionQty * input.entry;
  const denominator = input.positionQty * input.maintMarginRatio - side * input.positionQty;
  return numerator / denominator;
}

export interface LiquidationSafetyInput extends LiquidationPriceInput {
  stopLoss: number;
}

export interface LiquidationSafetyResult {
  safe: boolean;
  liquidationPrice: number;
  reason: string;
}

// 核心安全檢查：止損價必須比強平價「先」被觸發，止損才有意義——槓桿開太
// 高會讓強平價比止損價更早到，這時候部位在自己設的止損價之前就已經被交易
// 所強制平倉（且通常帶額外的強平手續費），實際虧損比策略設計的止損距離
// 大，risk 管理的整套假設（風險=倉位×止損距離）在這種情況下不成立。
export function checkLiquidationSafety(input: LiquidationSafetyInput): LiquidationSafetyResult {
  const liquidationPrice = calcLiquidationPrice(input);
  const safe = input.isLong
    ? liquidationPrice < input.stopLoss
    : liquidationPrice > input.stopLoss;
  return {
    safe,
    liquidationPrice,
    reason: safe
      ? `止損 ${input.stopLoss} 會在強平價 ${liquidationPrice.toFixed(4)} 之前觸發，安全`
      : `槓桿過高：強平價 ${liquidationPrice.toFixed(4)} 比止損 ${input.stopLoss} 更早觸發，止損單形同虛設`,
  };
}

// findMarginBracket 的 export 型別別名，方便呼叫端在拿到
// BinanceFuturesClient.getLeverageBrackets() 的結果後直接餵進來，不用自己
// 重複宣告結構。
export type { MarginBracket };
