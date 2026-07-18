// 移植自 core/ingest/loader.py（逐函式對照，CLI 專屬訊息改為網頁語境）。
// 通用交易資料載入：CSV / JSON、欄位同義詞自動辨識、有效性守門與略過原因。
// 隱私：本模組只處理呼叫端傳入的字串，絕不發出網路請求。

import { estimateRoundTripCost } from './costs';
import { contractMultiplier, inferMarket, Market, Side } from './markets';
import { AgTrade, AgTradeLog, buildTrade } from './models';

// ── 欄位同義詞對照（全部轉小寫、去空白後比對）──────────────────
export const FIELD_SYNONYMS: Record<string, string[]> = {
  symbol: [
    'symbol', 'ticker', '代號', '股票代號', '標的', '商品', '幣別', 'pair',
    'instrument', 'code', 'stockcode', '證券代號',
    '證券名稱', '股票名稱', '商品名稱', 'market', 'underlyingsymbol', 'contract',
    // 本站「紀錄」頁匯出檔（超出原 Python 對照表的擴充，見 merge-notes）
    '幣種',
  ],
  side: [
    'side', '方向', '買賣', '買賣別', '交易別', 'buysell', 'direction', 'type',
    'action', 'long_short', '多空',
  ],
  entry_time: [
    'entry_time', 'entrytime', '進場時間', '買進時間', 'open_time', 'opentime',
    '成交日期', '進場日', 'date', 'buy_date', '開倉時間',
    '成交日', '交易日期', '委託日期', 'date(utc)', 'tradedate', 'datetime',
  ],
  exit_time: [
    'exit_time', 'exittime', '出場時間', '賣出時間', 'close_time', 'closetime',
    '平倉時間', 'sell_date', 'exit_date', '平倉日',
  ],
  entry_price: [
    'entry_price', 'entryprice', '進場價', '買進價', 'open_price', '成交價',
    '買價', 'cost', '成本', '開倉價', 'buy_price',
    '成交均價', 'price', 'tradeprice', '成交單價',
  ],
  exit_price: [
    'exit_price', 'exitprice', '出場價', '賣出價', 'close_price', '平倉價',
    '賣價', 'sell_price',
  ],
  quantity: [
    'quantity', 'qty', '數量', '股數', '張數', '張', 'size', 'amount', 'volume',
    '口數', '成交數量', '成交股數', 'shares', '成交量',
  ],
  fees: [
    'fees', 'fee', '手續費', '費用', '成本費用', 'commission', '手續費及稅',
    '交易成本', 'total_fee',
    '證交稅', '交易稅', '手續費及交易稅', 'ibcommission',
  ],
  pnl: [
    'pnl', 'profit', '損益', '盈虧', '已實現損益', 'realized_pnl', '獲利',
    'net_pnl', '賺賠',
    // 注意：不收 "return" —— 它常指「報酬率(%)」而非損益金額
    '損益金額', '淨收付', '淨收付金額', 'realized profit', 'fifopnlrealized',
    // 百分比損益（本站匯出檔用「損益%」）：放在最末 —— 同檔若有金額欄
    // 會先被比中；只剩 % 欄時以「%」為損益單位分析（統計檢定不受尺度影響），
    // 並在 warnings 明確告知使用者單位是 %
    '損益%', '損益率', '報酬率%',
  ],
  tag: [
    'tag', '策略', 'strategy', '標籤', '備註', 'note', 'remark', '策略名稱',
    'setup', '進場理由',
  ],
};

export const STANDARD_FIELDS = Object.keys(FIELD_SYNONYMS);

const LONG_TOKENS = new Set(['long', 'buy', 'b', '做多', '多', '買', '買進', '1']);
const SHORT_TOKENS = new Set(['short', 'sell', 's', '做空', '空', '賣', '賣出', '放空', '-1']);

function norm(name: unknown): string {
  return String(name).replace(/\s+/g, '').trim().toLowerCase();
}

/** 把實際欄位名對應到標準欄位名。回傳 {標準名: 實際欄位名}。 */
export function buildFieldMap(columns: string[]): Record<string, string> {
  const normalized = new Map<string, string>();
  for (const c of columns) normalized.set(norm(c), c);
  const fieldMap: Record<string, string> = {};
  for (const [std, synonyms] of Object.entries(FIELD_SYNONYMS)) {
    for (const syn of synonyms) {
      const key = norm(syn);
      if (normalized.has(key)) {
        fieldMap[std] = normalized.get(key)!;
        break;
      }
    }
  }
  return fieldMap;
}

function parseSide(value: unknown): Side {
  const v = norm(value);
  if (SHORT_TOKENS.has(v)) return 'short';
  if (LONG_TOKENS.has(v)) return 'long';
  return 'long'; // 預設做多（最常見）
}

// 時間格式（依 Python 版的嘗試順序；%m/%d/%Y 先於 %d/%m/%Y）
// state.assumedYear：遇到缺年份的中文格式（如「7/17 上午08:00」，本站舊版
// 匯出檔）時假設為今年，並回報給呼叫端在 warnings 揭露
function parseTime(value: unknown, state?: { assumedYear?: boolean }): Date {
  if (value instanceof Date) return value;
  const s = String(value).trim();
  let m: RegExpExecArray | null;

  // zh-TW toLocaleString 格式：[YYYY/]M/D 上午|下午HH:MM[:SS]
  m = /^(?:(\d{4})[/\-年])?(\d{1,2})[/月](\d{1,2})日?\s*(上午|下午)\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    let year: number;
    if (m[1]) {
      year = +m[1];
    } else {
      year = new Date().getFullYear();
      if (state) state.assumedYear = true;
    }
    let hour = +m[5];
    // zh-TW 慣例：上午12 → 0 時；下午12 → 12 時；下午1-11 → +12
    if (m[4] === '上午' && hour === 12) hour = 0;
    else if (m[4] === '下午' && hour !== 12) hour += 12;
    return mkDate(year, +m[2], +m[3], hour, +m[6], +(m[7] ?? 0), s);
  }

  // %Y-%m-%d [%H:%M[:%S]] 與 %Y/%m/%d [%H:%M[:%S]]
  m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    return mkDate(+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), s);
  }
  // %Y%m%d
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return mkDate(+m[1], +m[2], +m[3], 0, 0, 0, s);
  // %m/%d/%Y（美式優先，與 Python 格式表一致）
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    const mm = +m[1], dd = +m[2], yy = +m[3];
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) return mkDate(yy, mm, dd, 0, 0, 0, s);
    // %d/%m/%Y
    if (dd >= 1 && dd <= 12) return mkDate(yy, dd, mm, 0, 0, 0, s);
  }
  // ISO（含時區）→ 去除時區保留掛鐘時間（與 Python _naive 一致）
  const isoM = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.exec(s);
  if (isoM) {
    return mkDate(+isoM[1], +isoM[2], +isoM[3], +isoM[4], +isoM[5], +(isoM[6] ?? 0), s);
  }
  throw new Error(`無法解析時間格式: ${JSON.stringify(String(value))}`);
}

function mkDate(y: number, mo: number, d: number, h: number, mi: number, se: number, raw: string): Date {
  const dt = new Date(y, mo - 1, d, h, mi, se);
  // 與 Python strptime 一樣拒絕溢位日期（如 2月30日）
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) {
    throw new Error(`無法解析時間格式: ${JSON.stringify(raw)}`);
  }
  return dt;
}

function toFloat(value: unknown, dflt: number | null = null): number | null {
  if (value === null || value === undefined || value === '') return dflt;
  if (typeof value === 'number') return Number.isFinite(value) ? value : dflt;
  const s = String(value).replace(/[,$￥¥\s]/g, '');
  if (s === '' || s === '-' || s === '—') return dflt;
  const f = Number(s);
  if (Number.isNaN(f) || !Number.isFinite(f)) return dflt;
  return f;
}

// ── 檔案文字 → 列 ─────────────────────────────────────────────

/** RFC4180 風格 CSV 解析（引號、引號內逗號與換行）。 */
export function parseCsv(text: string, delimiter = ','): { columns: string[]; rows: Record<string, unknown>[] } {
  const grid: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, ''); // BOM
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      grid.push(row); row = [];
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) { row.push(cell); grid.push(row); }

  const nonEmpty = grid.filter(r => r.some(c => c.trim() !== ''));
  if (nonEmpty.length === 0) return { columns: [], rows: [] };
  const columns = nonEmpty[0].map(c => c.trim());
  const rows = nonEmpty.slice(1).map(r => {
    const obj: Record<string, unknown> = {};
    columns.forEach((c, idx) => { obj[c] = r[idx] ?? ''; });
    return obj;
  });
  return { columns, rows };
}

/** JSON 文字 → 列。支援 [{...}] 或 {"trades"/"data"/"records"/"orders": [...]}。 */
export function parseJsonRows(text: string): { columns: string[]; rows: Record<string, unknown>[] } {
  let data: unknown = JSON.parse(text);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    let found = false;
    for (const key of ['trades', 'data', 'records', 'orders']) {
      if (Array.isArray(obj[key])) { data = obj[key]; found = true; break; }
    }
    if (!found) throw new Error('JSON 物件中找不到交易陣列（預期鍵: trades/data/records）');
  }
  if (!Array.isArray(data) || data.length === 0) throw new Error('JSON 必須是非空的交易陣列');
  const rows = data as Record<string, unknown>[];
  return { columns: Object.keys(rows[0] ?? {}), rows };
}

/**
 * 讀檔位元組 → 文字。UTF-8（fatal）失敗時回退 Big5（繁中版 Excel 另存 CSV
 * 預設 ANSI/cp950）—— 與 Python 版 utf-8-sig → cp950 的語意一致。
 */
export function decodeFileBytes(buf: ArrayBuffer): { text: string; encoding: 'utf-8' | 'big5' } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch {
    try {
      return { text: new TextDecoder('big5').decode(buf), encoding: 'big5' };
    } catch {
      throw new Error('無法解讀檔案的文字編碼（試過 UTF-8 與 Big5）。請用 Excel 另存為「CSV UTF-8」格式後重試。');
    }
  }
}

// ── 主載入流程 ────────────────────────────────────────────────

export interface IngestResult {
  log: AgTradeLog;
  columns: string[];
  fieldMap: Record<string, string>;
  validCount: number;
  skipped: number;
  skipReasons: string[];
  warnings: string[];
  usedEncoding: 'utf-8' | 'big5';
  qtyInLots: boolean;
}

export class FieldMappingError extends Error {
  columns: string[];
  missing: string[];
  constructor(message: string, columns: string[], missing: string[]) {
    super(message);
    this.name = 'FieldMappingError';
    this.columns = columns;
    this.missing = missing;
  }
}

/**
 * 解析交易紀錄文字（等價於 loader.load_trades，但輸入為已解碼文字）。
 * 丟出 FieldMappingError 時，UI 應顯示手動欄位對應介面。
 */
export function parseTradeLog(opts: {
  text: string;
  format: 'csv' | 'json' | 'tsv';
  fileName?: string;
  marketHint?: Market | null;
  autoEstimateCosts?: boolean;
  fieldOverrides?: Record<string, string>;
  usedEncoding?: 'utf-8' | 'big5';
}): IngestResult {
  const autoCosts = opts.autoEstimateCosts ?? true;
  const fileName = opts.fileName ?? '上傳檔案';
  const usedEncoding = opts.usedEncoding ?? 'utf-8';

  const { columns, rows } = opts.format === 'json'
    ? parseJsonRows(opts.text)
    : parseCsv(opts.text, opts.format === 'tsv' ? '\t' : ',');

  if (rows.length === 0) throw new Error(`檔案中沒有任何資料列: ${fileName}`);

  const fieldMap = buildFieldMap(columns);
  if (opts.fieldOverrides) Object.assign(fieldMap, opts.fieldOverrides);

  // 必要欄位：pnl 可由價格推算，故 pnl 與（進出場價+數量）二擇一
  const requiredCore = ['symbol', 'entry_price', 'exit_price', 'quantity'];
  const hasPrices = ['entry_price', 'exit_price', 'quantity'].every(k => k in fieldMap);
  const hasPnl = 'pnl' in fieldMap && 'symbol' in fieldMap;
  if (!hasPrices && !hasPnl) {
    const missing = requiredCore.filter(k => !(k in fieldMap));
    throw new FieldMappingError(
      `無法自動辨識必要欄位：${missing.join(', ')}。請在下方手動指定欄位對應，或下載標準範本照填後再上傳。`,
      columns, missing,
    );
  }

  const get = (row: Record<string, unknown>, std: string, dflt: unknown = null): unknown => {
    const col = fieldMap[std];
    return col !== undefined ? (row[col] ?? dflt) : dflt;
  };

  // 台股「張」單位偵測：欄名含「張」→ 1 張 = 1000 股
  const qtyCol = fieldMap['quantity'] ?? '';
  const qtyInLots = String(qtyCol).includes('張');
  const lotMultiplier = qtyInLots ? 1000 : 1;

  const trades: AgTrade[] = [];
  let skipped = 0;
  const skipReasons: string[] = [];
  const unknownMultiplierSymbols = new Set<string>();
  const timeState: { assumedYear?: boolean } = {};

  for (const row of rows) {
    const rowNo = trades.length + skipped + 1;
    const symbol = String(get(row, 'symbol', '') ?? '').trim();
    if (symbol.startsWith('#')) continue; // 註解列，不計入錯誤
    if (!symbol) {
      skipped++;
      if (skipReasons.length < 10) skipReasons.push(`第 ${rowNo} 列：缺少標的代號`);
      continue;
    }

    let entryTime: Date, exitTime: Date;
    try {
      entryTime = parseTime(get(row, 'entry_time', '1970-01-01'), timeState);
      const rawExit = get(row, 'exit_time');
      exitTime = rawExit !== null && rawExit !== undefined && rawExit !== ''
        ? parseTime(rawExit, timeState) : entryTime;
    } catch (exc) {
      skipped++;
      if (skipReasons.length < 10) {
        skipReasons.push(`第 ${rowNo} 列（${symbol}）：時間格式無法解析 — ${(exc as Error).message}`);
      }
      continue;
    }

    const market = inferMarket(symbol, opts.marketHint);
    const side = parseSide(get(row, 'side', 'long'));

    const entryPriceRaw = toFloat(get(row, 'entry_price'), null);
    const exitPriceRaw = toFloat(get(row, 'exit_price'), null);
    const quantityRaw = toFloat(get(row, 'quantity'), null);
    const [mult, multKnown] = contractMultiplier(symbol);
    let fees = toFloat(get(row, 'fees'), null);
    const pnl = toFloat(get(row, 'pnl'), null);

    // 有效性守門：損益必須「算得出來」，缺料就略過並記錄，絕不用 0 補洞
    const rowHasPrices =
      entryPriceRaw !== null && entryPriceRaw > 0 &&
      exitPriceRaw !== null && exitPriceRaw >= 0 &&
      quantityRaw !== null && quantityRaw > 0;
    if (pnl === null && !rowHasPrices) {
      skipped++;
      if (skipReasons.length < 10) {
        skipReasons.push(`第 ${rowNo} 列（${symbol}）：算不出損益（缺 pnl，且進場價/出場價/數量不完整或無法解析）`);
      }
      continue;
    }

    // 台期權且乘數未知：pnl 沒直接給的話，用乘數 1 推算是錯的數字 → 略過
    if (pnl === null && (market === 'tw_futures' || market === 'tw_options') && !multKnown) {
      skipped++;
      if (skipReasons.length < 10) {
        skipReasons.push(`第 ${rowNo} 列（${symbol}）：契約乘數未知，期貨/選擇權損益無法可信推算 —— 請直接提供 pnl 欄位`);
      }
      continue;
    }

    const entryPrice = entryPriceRaw ?? 0.0;
    const exitPrice = exitPriceRaw ?? 0.0;
    const quantity = (quantityRaw ?? 0.0) * lotMultiplier;
    const tagRaw = get(row, 'tag');
    const tag = tagRaw !== null && tagRaw !== undefined && tagRaw !== '' ? String(tagRaw).trim() : null;

    // 成本：沒給 fees 且開啟自動估算時補上估計成本
    if (fees === null && autoCosts && entryPrice && quantity) {
      if ((market === 'tw_futures' || market === 'tw_options') && !multKnown) {
        unknownMultiplierSymbols.add(symbol);
        fees = 0.0;
      } else {
        const dayTrade =
          entryTime.getFullYear() === exitTime.getFullYear() &&
          entryTime.getMonth() === exitTime.getMonth() &&
          entryTime.getDate() === exitTime.getDate();
        fees = estimateRoundTripCost(market, side, entryPrice, exitPrice, quantity, {
          isDayTrade: dayTrade,
          contractMultiplier: mult,
        });
      }
    }
    fees = fees ?? 0.0;

    try {
      trades.push(buildTrade({
        symbol, market, side, entryTime, exitTime,
        entryPrice, exitPrice, quantity, fees,
        pnl, tag, contractMultiplier: mult,
      }));
    } catch (exc) {
      skipped++;
      if (skipReasons.length < 10) skipReasons.push(`第 ${rowNo} 列：${(exc as Error).message}`);
      continue;
    }
  }

  if (trades.length === 0) {
    const detail = skipReasons.length ? skipReasons.join('\n  ') : '請檢查欄位對應與資料格式。';
    throw new Error(`沒有任何有效交易可解析（略過 ${skipped} 列）。\n  ${detail}`);
  }

  const warnings: string[] = [];
  const total = trades.length + skipped;
  const skipRatio = total ? skipped / total : 0;
  let warn = '';
  if (skipRatio > 0.2) warn = `, ⚠️略過比例 ${Math.round(skipRatio * 100)}% 偏高（可能欄位對應有誤）`;
  if (skipped && skipReasons.length) {
    const preview = skipReasons.slice(0, 2).join('；');
    const more = skipped > 2 ? `（其餘 ${skipped - 2} 列原因略）` : '';
    warn += `, 略過原因：${preview}${more}`;
    warnings.push(`略過 ${skipped} 列：${preview}${more}`);
  }
  if (skipRatio > 0.2) warnings.push(`略過比例 ${Math.round(skipRatio * 100)}% 偏高，可能欄位對應有誤`);
  const lotNote = qtyInLots ? ', 數量以「張」×1000 換算為股' : '';
  if (qtyInLots) warnings.push('數量欄名含「張」，已以 1 張 = 1000 股換算');
  if (unknownMultiplierSymbols.size > 0) {
    const syms = Array.from(unknownMultiplierSymbols).sort().slice(0, 3).join(', ');
    warn += `, ⚠️${syms} 為槓桿商品但查不到契約乘數 —— 已跳過成本估算，請自行在 fees 欄位填入實際費用`;
    warnings.push(`${syms} 為槓桿商品但查不到契約乘數，已跳過成本估算 —— 請在 fees 欄位填入實際費用（本工具拒絕用猜測的乘數算錯數字）`);
  }
  if (usedEncoding === 'big5') {
    warnings.push('檔案以 Big5/cp950 編碼讀取 —— 若見亂碼請改存 CSV UTF-8');
  }
  // 百分比損益欄（如本站匯出的「損益%」）：統計檢定不受尺度影響，
  // 但所有金額類指標（期望值/總損益/回撤金額）單位都是「%」而非錢
  const pnlCol = fieldMap['pnl'];
  if (pnlCol && /[%％率]/.test(pnlCol)) {
    warnings.push(`損益欄「${pnlCol}」是百分比 —— 分析結果的期望值/總損益單位為「%」而非金額（統計裁決不受影響）`);
  }
  if (timeState.assumedYear) {
    warnings.push(`時間欄缺年份（如「7/17 上午08:00」），已假設為 ${new Date().getFullYear()} 年 —— 若紀錄跨年請改用含年份的格式重新匯出`);
  }

  const log: AgTradeLog = {
    trades,
    source: `${fileName} (${opts.format}`
      + (usedEncoding === 'big5' ? ', 以 Big5/cp950 編碼讀取 — 若見亂碼請改存 CSV UTF-8' : '')
      + `, 載入 ${trades.length} 筆, 略過 ${skipped} 筆${warn}${lotNote})`,
    accountLabel: fileName.replace(/\.[^.]+$/, ''),
  };

  return {
    log, columns, fieldMap,
    validCount: trades.length,
    skipped, skipReasons, warnings,
    usedEncoding, qtyInLots,
  };
}

/** 空白範本 CSV（對應原 CLI init-template）。 */
export function blankTemplateCsv(): string {
  return [
    'symbol,side,entry_time,exit_time,entry_price,exit_price,quantity,fees,pnl,tag',
    '# symbol=代號(2330/AAPL/BTCUSDT)、side=long或short、時間格式 YYYY-MM-DD',
    '# pnl 與(entry_price+exit_price+quantity)二擇一；fees 留空會自動估算',
    '2330,long,2025-01-06,2025-01-10,1000,1020,1000,,,範例策略',
    'BTCUSDT,long,2025-01-08,2025-01-09,94000,95000,0.1,,,突破',
  ].join('\n');
}
