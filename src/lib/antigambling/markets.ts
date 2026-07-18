// 移植自 reference/anti-gambling-trader-tw core/markets.py（逐函式對照）。
// 市場與商品規格：契約乘數白名單、代號辨識、槓桿標註。
// 原則：查不到就標 unknown 並拒絕猜測 —— 寧可不算，不可算錯。

export type Market =
  | 'tw_stock' | 'tw_etf' | 'us_stock' | 'crypto'
  | 'tw_futures' | 'tw_options' | 'forex' | 'unknown';

export type Side = 'long' | 'short';

export const LAST_REVIEWED = '2026-07';

interface MarketSpec {
  unitName: string;
  isLeveraged: boolean;
  note?: string;
}

export const MARKET_SPECS: Record<Market, MarketSpec> = {
  tw_stock:   { unitName: '股', isLeveraged: false },
  tw_etf:     { unitName: '股', isLeveraged: false, note: '股票型 ETF 證交稅 0.1%（非 0.3%）' },
  us_stock:   { unitName: '股', isLeveraged: false },
  crypto:     { unitName: '幣', isLeveraged: false, note: '永續合約有資金費率，本工具未建模' },
  tw_futures: { unitName: '口', isLeveraged: true, note: '乘數必須查白名單；查不到不可自動估成本' },
  tw_options: { unitName: '口', isLeveraged: true, note: '賣方風險左尾極厚，樣本內可能完全看不到爆倉' },
  forex:      { unitName: '手', isLeveraged: true, note: '隔夜利息（swap）可正可負，本工具未建模' },
  unknown:    { unitName: '單位', isLeveraged: false },
};

// 契約乘數白名單（只放有把握的；查不到就是查不到，不猜）
export const SYMBOL_MULTIPLIERS: Record<string, number> = {
  TXF: 200.0,  // 大台
  MXF: 50.0,   // 小台
  TMF: 10.0,   // 微台
  EXF: 4000.0, // 電子期
  FXF: 1000.0, // 金融期
  TXO: 50.0,   // 台指選擇權
};

// 台期權代號 = 白名單前綴 + 契約月份碼（必須含數字）。
// TMF/FXF/TXO 都是真實美股代號 —— 裸前綴比對會把美股損益放大 10~4000 倍。
const TW_DERIV_PATTERN = new RegExp(
  '^(' + Object.keys(SYMBOL_MULTIPLIERS).sort((a, b) => b.length - a.length).join('|') + ')(?=[A-Z0-9]*\\d)',
);

const ISO_CCY = new Set([
  'USD', 'EUR', 'JPY', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF',
  'CNY', 'CNH', 'HKD', 'SGD', 'TWD', 'KRW', 'SEK', 'NOK',
  'MXN', 'ZAR', 'TRY', 'PLN',
]);

const CRYPTO_QUOTE = /(USDT|USDC|BUSD|DAI)$/i;
// 主流幣基底只有在「分隔符或明確計價幣」後才算 crypto（SOL/ETHA 是真實美股代號）
const CRYPTO_BASE = /^(BTC|ETH|SOL|XRP|DOGE|ADA|BNB)(?=[-/_]|(USD|EUR|JPY|GBP|TWD|KRW|BTC|ETH|BNB)$)/i;
const BARE_COINS = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'BNB']);

const FOREX_PAIR = /^([A-Z]{3})([A-Z]{3})$/;
const TW_ETF_RE = /^00\d{2,4}[A-Z]?$/;
const TW_STOCK_RE = /^\d{4,6}[A-Z]?$/;
const US_STOCK_RE = /^[A-Z]{1,5}$/;

/** 查契約乘數。回傳 [乘數, 是否查得到]。 */
export function contractMultiplier(symbol: string): [number, boolean] {
  const s = String(symbol).trim().toUpperCase();
  const m = TW_DERIV_PATTERN.exec(s);
  if (m) return [SYMBOL_MULTIPLIERS[m[1]], true];
  return [1.0, false];
}

/** 從標的代號推斷市場別。模稜兩可時一律回 unknown（寧可不判，不可錯判）。 */
export function inferMarket(symbol: string, hint?: Market | null): Market {
  if (hint && hint !== 'unknown') return hint;
  const s = String(symbol).trim().toUpperCase();
  if (!s) return 'unknown';

  // 1. 期貨/選擇權：白名單前綴 + 必須帶月份碼
  const mDeriv = TW_DERIV_PATTERN.exec(s);
  if (mDeriv) {
    return mDeriv[1].endsWith('O') ? 'tw_options' : 'tw_futures';
  }

  // 2. 外匯（必須早於加密貨幣，否則 EURUSD 被誤判）
  const mFx = FOREX_PAIR.exec(s);
  if (mFx && ISO_CCY.has(mFx[1]) && ISO_CCY.has(mFx[2])) return 'forex';

  // 3. 加密貨幣
  if (CRYPTO_QUOTE.test(s) || CRYPTO_BASE.test(s)) return 'crypto';

  // 3.5 裸幣名與美股代號空間衝突 → unknown
  if (BARE_COINS.has(s)) return 'unknown';

  // 4~6. 台 ETF → 台股 → 美股
  if (TW_ETF_RE.test(s)) return 'tw_etf';
  if (TW_STOCK_RE.test(s)) return 'tw_stock';
  if (US_STOCK_RE.test(s)) return 'us_stock';

  return 'unknown';
}

export function isLeveraged(market: Market): boolean {
  return !!MARKET_SPECS[market]?.isLeveraged;
}

export function unitName(market: Market): string {
  return MARKET_SPECS[market]?.unitName ?? '單位';
}

/** 本工具「未涵蓋」的成本 —— 必須誠實告訴使用者。 */
export function uncoveredCostWarnings(market: Market): string[] {
  const out: string[] = [];
  if (market === 'forex') {
    out.push('外匯的隔夜利息（swap）可正可負、逐日浮動、各券商加價不一，本工具未建模。請以對帳單的實際費用填入 fees 欄位。');
  }
  if (market === 'crypto') {
    out.push('加密貨幣永續合約的資金費率（funding rate）未建模。若你做的是永續合約，請把資金費用計入 fees。');
  }
  if (market === 'tw_etf') {
    out.push('一般債券 ETF（不含槓桿型/反向型）至 2026-12-31 暫停課徵證交稅，但本工具無法從代號辨識 ETF 型別，一律用股票型 0.1% 保守估算 —— 若你交易的是適用免稅的債券 ETF，賣出稅被高估，請在 fees 欄位填實際費用。');
  }
  if (market === 'tw_futures' || market === 'tw_options') {
    out.push('期貨/選擇權的保證金追繳、強制平倉未建模；報酬率以契約價值為母體計算，與以保證金為母體的算法差距可達數十倍，不可與股票的報酬率直接比較。');
  }
  if (market === 'tw_options') {
    out.push('⚠️ 選擇權賣方的虧損左尾極厚：歷史樣本裡「剛好沒發生爆倉」時，統計檢定會誤判為穩定獲利。顯著為正的結果對賣方策略特別不可信。');
  }
  return out;
}
