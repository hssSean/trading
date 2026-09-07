// ── Position sizing plan ───────────────────────────────────────
// Turns "risk X% of the account" into a concrete order the user can place:
//   倉位 (notional) = riskUSDT / stopDistance
//   本金 (margin)   = ~20% of account per trade, stretched only when the
//                     leverage cap would otherwise shrink the position
//   槓桿 (leverage) = notional / margin, clamped to [1, maxLev]
// Shared by SignalCard, trades journal, and the server push notifications so
// every surface quotes identical numbers.

// Alt-bucket slot cap: same-direction altcoin risk is bucketed at ≤1.0% total
// (see checkSameDirectionRisk in api/analyze/route.ts), subdivided into ~3 slots
// of ALT_SLOT_RISK each. This must be the SAME multiplier used for the real
// position size shown to the user — otherwise the risk gate's bookkeeping and
// the actual $ risked on an order diverge (bucket accounts 0.33%, order sizes at
// the full 1.0% tier rate).
export const ALT_SLOT_RISK = 0.33;

// Fraction of the user's acctRiskPct actually put on a given signal: tier alone
// (A=100%, B=50%) for BTC/ETH; capped at ALT_SLOT_RISK for altcoins, since an alt
// slot's bookkeeping in checkSameDirectionRisk is capped there too.
export function tierRiskMultiplier(symbol: string, tier: string | null | undefined): number {
  const base = tier === 'B' ? 0.5 : 1.0;
  const isAlt = !symbol.startsWith('BTC') && !symbol.startsWith('ETH');
  return isAlt ? Math.min(base, ALT_SLOT_RISK) : base;
}

export interface PositionPlan {
  /**
   * 止損打到時的最大虧損。**名目被上限夾過時這個數字會低於設定的風險%**
   * （見 calcPositionPlan 的名目上限說明）——夾了倉位卻照報原本的風險金額
   * 就是謊報風險，推播上的「止損虧 XU」會是錯的。
   */
  riskUSDT: number;
  positionUSDT: number;  // notional position size
  marginUSDT: number;    // 本金 to allocate
  leverage: number;      // 槓桿, 1 decimal
  belowMinNotional: boolean; // notional under Binance's ~5 USDT futures minimum
  /** 名目撞到上限被縮小過 → riskUSDT 低於 accountSize × riskPct */
  notionalCapped: boolean;
}

export function calcPositionPlan(
  accountSize: number,
  riskPct: number,       // per-trade risk in % (already tier-adjusted by caller)
  entry: number,
  stopLoss: number,
  maxLev = 10,
): PositionPlan | null {
  if (accountSize <= 0 || riskPct <= 0 || entry <= 0) return null;
  const stopDist = Math.abs(entry - stopLoss) / entry;
  if (stopDist <= 0) return null;

  const requestedRisk = accountSize * riskPct / 100;
  const rawNotional   = requestedRisk / stopDist;

  const marginBudget = accountSize * 0.2; // per-trade margin target: 20% of account

  // ── 名目上限（2026-09-07）────────────────────────────────────────────
  //
  // 舊版只夾槓桿、不夾名目：
  //
  //     leverage   = min(max(notional / marginBudget, 1), maxLev)
  //     marginUSDT = notional / leverage      ← 用夾過的槓桿反推本金
  //
  // 名目超過 marginBudget × maxLev 時，這段不是縮小倉位，而是**放大本金**。
  // 於是「每筆本金約佔帳戶 20%」這個設計意圖在止損距離 ≤ 0.5% 時就失效了。
  // 實測（帳戶 4,847U、風險 1%、maxLev 10）：
  //
  //     止損 0.500%  名目  9,694U  本金   969U  佔 20.0%   ← 設計意圖
  //     止損 0.250%  名目 19,388U  本金 1,939U  佔 40.0%
  //     止損 0.103%  名目 47,059U  本金 4,706U  佔 97.1%   ← 單筆吃掉整個帳戶
  //
  // 而既有的風控一道都攔不到：所有上限都是 R 或百分比，名目 47,059U 的部位
  // 「就是 1R 風險」，沒有違反任何一條；checkLiquidationSafety 檢查的是
  // 「止損比強平先觸發」，槓桿 10 倍時強平距離約 10%，止損 0.103% 確實先到
  // ——**那道檢查會判定通過**。
  //
  // 這件事跟策略參數無關：不改任何訊號的進出場位置、不改 R 倍數，只改
  // 「這一筆願意押多少錢」。詳見 docs/ANALYSIS-2026-09-07-止損距離下限.md §5。
  //
  // 副作用是刻意的：止損距離小到要用 97% 帳戶保證金才湊得出「1% 風險」時，
  // 正確答案是少押一點，不是照押。所以 riskUSDT 會低於設定值，且用
  // notionalCapped 標示出來，不讓它靜默發生。
  const maxNotional    = marginBudget * maxLev;
  const notionalCapped = rawNotional > maxNotional;
  const positionUSDT   = notionalCapped ? maxNotional : rawNotional;

  let leverage = positionUSDT / marginBudget;
  leverage = Math.min(Math.max(leverage, 1), maxLev);
  leverage = Math.round(leverage * 10) / 10;
  const marginUSDT = positionUSDT / leverage;

  // 夾過之後真正會賠掉的錢，不是原本要求的風險%。
  const riskUSDT = positionUSDT * stopDist;

  return {
    riskUSDT:     Math.round(riskUSDT * 100) / 100,
    positionUSDT: Math.round(positionUSDT * 10) / 10,
    marginUSDT:   Math.round(marginUSDT * 10) / 10,
    leverage,
    belowMinNotional: positionUSDT < 5,
    notionalCapped,
  };
}

// Compact zh-TW one-liner for notifications: 倉位 13.3U（本金 4U ×3.3倍）
//
// 名目被夾過時一定要講——推播後面接的是「止損虧 XU」，那個數字已經是縮小
// 後的實際風險，不標示的話看起來就只是「風險%算錯了」。
export function formatPlanLine(plan: PositionPlan): string {
  const base = `倉位 ${plan.positionUSDT}U（本金 ${plan.marginUSDT}U ×${plan.leverage}倍）`;
  if (plan.belowMinNotional) return `${base}⚠低於交易所最低5U`;
  return plan.notionalCapped ? `${base}⚠止損太近，倉位已縮至上限` : base;
}

// 2026-08-08：從 api/analyze/route.ts 搬過來，讓 DB 模擬版（route.ts）跟
// 真倉自動化（src/engine/tradeBridge.ts）用同一個上限，不要各自維護一份會
// 走鐘的數字。
//
// 這是「持倉數量，按波動性加權」的量測代理值，NOT 真實帳戶風險% ——
// suggested_risk_pct 是系統依 ATR 波動性給的建議倉位大小（0.5/1.0/1.5，
// 資訊性質，使用者自己決定要不要照做），跟使用者自己設的 acctRiskPct
// 完全無關。2026-07-31 把顯示文案（拒絕原因/BtcStatusBar/ScanStatusPanel）
// 改過，不再暗示這是真實帳戶風險，數字/門檻本身沒動，只是改了怎麼稱呼它。
export const MAX_TOTAL_RISK_PCT = 5;
