#!/usr/bin/env npx tsx
/**
 * 清查「捏造出場」—— 拿 Supabase 已結束的交易去對幣安真實成交紀錄。
 *
 * ## 為什麼需要這支
 *
 * 2026-08-27 修掉一個 bug（commit 6e357a3）：`/api/analyze` 的 DB 模擬監控
 * 會去「關」live-runner 開的**真倉**。DB 模擬是拿 K 線收盤價推演的，而幣安
 * 是用標記價觸發——一根influence插針就能讓模擬判定「這單止損了」，於是：
 *
 *   - Supabase 寫入 result='LOSS'、exit_price、pnl_percent
 *   - 幣安那邊倉位**還開著、而且在賺錢**
 *
 * 實際後果：使用者 App 顯示 0 持倉，幣安 demo 帳戶有 5 筆獲利中的倉位；
 * 而那些捏造出來的假虧損累積起來觸發了回撤停機，系統把自己停掉了。
 *
 * bug 已修，但**已經寫進 DB 的假紀錄不會自己修正**。341 筆歷史已結束交易
 * 裡有多少是假的，沒有人知道——而所有績效統計、影子模擬基準、回撤計算
 * 都建立在這批資料上。**在清查完之前，任何策略判斷都不可信。**
 *
 * ## 判斷方式
 *
 * `exchange_entry_order_id` 是分水嶺：
 *
 *   - **NULL** = 這單從來沒送到交易所，純 DB 推演。它的出場本來就是模擬的，
 *     那是設計如此（給 live_trading_enabled=false 的使用者用），不算捏造。
 *     這支腳本會跳過它們並單獨計數。
 *   - **有值** = 真倉。它的出場**必須**對應到幣安上真實的平倉成交。對不到
 *     就是被 DB 模擬捏造的。
 *
 * 對每一筆真倉：用 entry order id 去 userTrades 撈進場成交（拿到真實均價與
 * 數量），再往後找反向成交湊滿同樣的數量當作平倉，比對：
 *
 *   1. **有沒有平倉成交** — 沒有 = 捏造出場，而且那個倉位可能還開著
 *   2. **損益方向對不對** — DB 說 LOSS 但真實 realizedPnl > 0 = 捏造
 *   3. **幅度差多少** — 價格變動% 對不上 pnl_percent
 *
 * `realizedPnl` 是幣安自己算的已實現損益，那是 USDT 計價的絕對事實，不需要
 * 我們重算。價格變動% 才是拿來跟 DB 的 pnl_percent 對照的口徑。
 *
 * ## 這支腳本只讀不寫
 *
 * 不下單、不改單、不寫 Supabase。只呼叫 GET 端點並把結果印出來 + 存 JSON。
 * 修正資料是下一步，要看過報告再決定怎麼修（有些單可能該重新開啟而不是
 * 改數字——倉位如果還在幣安上開著，改 DB 只會讓兩邊更不一致）。
 *
 * ## 用法
 *
 *   npx tsx scripts/audit-fabricated-exits.ts [天數]     # 預設 90 天
 *
 * 環境變數（跟 live-runner 同一組，設在 shell 裡，不要貼進 chat）：
 *   NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 *   TRADING_USER_ID
 *   BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET
 *
 * ## 已知限制（報告裡也會印出來）
 *
 * 同一個 symbol 上時間重疊的多筆單，無法從 userTrades 百分之百還原「哪筆
 * 平倉屬於哪筆進場」——幣安只記錄倉位淨額，不記錄我們的 trade_id。這裡用
 * 時間順序 FIFO 配對並標記已消耗的成交，是近似。所以 `AMOUNT_MISMATCH`
 * （幅度對不上）要當成「需要人工看」，只有 `NO_CLOSE_FILL` 和 `SIGN_FLIP`
 * 是硬證據。
 */

import { createClient } from '@supabase/supabase-js';
import { BinanceFuturesClient, loadBinanceConfigFromEnv, UserTrade } from '../src/engine/binanceClient';
import { auditTradeExit, type AuditVerdict } from '../src/lib/exitAudit';
import { writeFileSync } from 'fs';

const DAYS = Number(process.argv[2] ?? 90);
// 幣安 userTrades 單次查詢時間範圍上限 7 天，要分段撈。
const WINDOW_MS = 7 * 24 * 3600 * 1000;

interface TradeRow {
  id: string;
  symbol: string;
  direction: string;
  entry: number | null;
  stop_loss: number | null;
  exit_price: number | null;
  pnl_percent: number | null;
  result: string | null;
  close_reason: string | null;
  opened_at: number | null;
  filled_at: number | null;
  closed_at: number | null;
  exchange_entry_order_id: string | number | null;
}

// 判語與配對邏輯都在 src/lib/exitAudit.ts（有單元測試）。這裡只負責查詢與呈現。
const VERDICT_NOTE: Record<AuditVerdict, string> = {
  OK:              '有平倉成交、方向一致、幅度接近',
  NO_CLOSE_FILL:   'DB 說平了但幣安查無平倉成交——倉位很可能還開著',
  SIGN_FLIP:       'DB 記的損益方向與實際相反',
  AMOUNT_MISMATCH: '方向對但幅度差太多',
  PARTIAL_CLOSE:   '平倉量不足進場量，倉位還有剩',
  NO_ENTRY_FILL:   '連進場成交都查不到（掛單從未成交，或超出查詢範圍）',
};

interface Finding {
  id: string;
  symbol: string;
  direction: string;
  verdict: AuditVerdict;
  closedAt: number | null;
  dbResult: string | null;
  dbPnlPct: number | null;
  realPnlPct: number | null;
  realizedPnlUsdt: number | null;
  entryQty: number | null;
  closedQty: number | null;
  note: string;
}

function fmt(n: number | null | undefined, d = 2): string {
  return n == null || !Number.isFinite(n) ? '—' : n.toFixed(d);
}
function ts(t: number | null): string {
  return t == null ? '—' : new Date(t).toISOString().slice(0, 16).replace('T', ' ');
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 撈某個 symbol 在 [from, to] 區間內的全部成交，自動分 7 天一段。 */
async function fetchAllUserTrades(
  client: BinanceFuturesClient, symbol: string, from: number, to: number,
): Promise<UserTrade[]> {
  const out: UserTrade[] = [];
  for (let start = from; start < to; start += WINDOW_MS) {
    const end = Math.min(start + WINDOW_MS, to);
    // limit 1000 是單次上限。理論上單一 symbol 七天內超過 1000 筆成交會截斷，
    // 但那個量級遠超這個系統的交易頻率；真的發生時下面的 warn 會講出來。
    const batch = await client.getUserTrades(symbol, { startTime: start, endTime: end, limit: 1000 });
    if (batch.length === 1000) {
      console.warn(`⚠ ${symbol} ${ts(start)} 起七天內成交達 1000 筆上限，可能被截斷`);
    }
    out.push(...batch);
    await sleep(250); // 幣安 REST 權重限制，慢一點沒關係
  }
  return out.sort((a, b) => a.time - b.time);
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const userId = process.env.TRADING_USER_ID;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 未設定');
  if (!userId) throw new Error('TRADING_USER_ID 未設定');

  const since = Date.now() - DAYS * 24 * 3600 * 1000;
  const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  console.log(`查詢 ${DAYS} 天內已結束的交易（${ts(since)} 起）…`);
  const { data, error } = await db
    .from('trades')
    .select('id, symbol, direction, entry, stop_loss, exit_price, pnl_percent, result, close_reason, opened_at, filled_at, closed_at, exchange_entry_order_id')
    .eq('user_id', userId)
    .not('result', 'is', null)
    .gte('closed_at', since)
    .order('closed_at', { ascending: true });
  if (error) throw new Error(`Supabase 查詢失敗：[${error.code}] ${error.message}`);

  const all = (data ?? []) as TradeRow[];
  // CANCELLED 從來沒開過倉，沒有出場可言，不在清查範圍。
  const closed = all.filter(t => t.result !== 'CANCELLED');
  const simulated = closed.filter(t => t.exchange_entry_order_id == null);
  const real = closed.filter(t => t.exchange_entry_order_id != null);

  console.log(`\n總共 ${all.length} 筆已結束（含 ${all.length - closed.length} 筆 CANCELLED，已排除）`);
  console.log(`  純 DB 模擬（無 exchange_entry_order_id）：${simulated.length} 筆 — 出場本來就是推演的，跳過`);
  console.log(`  真倉（有 exchange_entry_order_id）：${real.length} 筆 — 以下逐筆對帳\n`);

  if (real.length === 0) {
    console.log('沒有真倉紀錄可對帳。若預期應該要有，先確認 TRADING_USER_ID 是不是 live_trading_enabled 的那位。');
    return;
  }

  const client = new BinanceFuturesClient(loadBinanceConfigFromEnv(true));
  const symbols = Array.from(new Set(real.map(t => t.symbol)));
  console.log(`涉及 ${symbols.length} 個 symbol，開始撈幣安成交紀錄…`);

  const findings: Finding[] = [];

  for (const symbol of symbols) {
    const rows = real.filter(t => t.symbol === symbol)
      .sort((a, b) => (a.opened_at ?? 0) - (b.opened_at ?? 0));
    const earliest = Math.min(...rows.map(t => t.opened_at ?? t.filled_at ?? since));
    const fills = await fetchAllUserTrades(client, symbol, earliest - 3600_000, Date.now());
    console.log(`  ${symbol}: ${rows.length} 筆單 / ${fills.length} 筆成交`);

    // FIFO 配對：已被前面的單消耗掉的成交不再重複使用。幣安不記我們的
    // trade_id，重疊倉位只能這樣近似——見檔頭「已知限制」。
    const consumed = new Set<number>();

    for (const t of rows) {
      const r = auditTradeExit({
        entryOrderId: Number(t.exchange_entry_order_id),
        dbPnlPercent: t.pnl_percent,
        fills,
        consumed,
      });
      r.consumedIds.forEach(id => consumed.add(id));

      // 判語一律來自純函數，這裡只把它翻成人看得懂的一行。
      let note = VERDICT_NOTE[r.verdict];
      switch (r.verdict) {
        case 'OK':
          note = `${fmt(r.realizedPnlUsdt, 4)} USDT（${fmt(r.realPnlPct)}%）`;
          break;
        case 'NO_CLOSE_FILL':
          note = `DB 記 ${t.result}（${fmt(t.pnl_percent)}%）但幣安查無任何平倉成交——倉位很可能還開著`;
          break;
        case 'SIGN_FLIP':
          note = `DB 記 ${fmt(t.pnl_percent)}% 但實際 ${fmt(r.realPnlPct)}%（${fmt(r.realizedPnlUsdt, 4)} USDT）——方向相反`;
          break;
        case 'AMOUNT_MISMATCH':
          note = `DB ${fmt(t.pnl_percent)}% vs 實際 ${fmt(r.realPnlPct)}%，`
            + `差 ${fmt(Math.abs((t.pnl_percent ?? 0) - (r.realPnlPct ?? 0)))} 個百分點`;
          break;
        case 'PARTIAL_CLOSE':
          note = `只平掉 ${fmt((r.closedQty ?? 0) / (r.entryQty || 1) * 100, 1)}%，剩餘部位還在倉上但 DB 已標記結束`;
          break;
        case 'NO_ENTRY_FILL':
          note = `entry order ${t.exchange_entry_order_id} 查無成交——掛單從未成交，或成交時間超出查詢範圍`;
          break;
      }

      findings.push({
        id: t.id, symbol, direction: t.direction, verdict: r.verdict,
        closedAt: t.closed_at, dbResult: t.result, dbPnlPct: t.pnl_percent,
        realPnlPct: r.realPnlPct, realizedPnlUsdt: r.realizedPnlUsdt,
        entryQty: r.entryQty, closedQty: r.closedQty, note,
      });
    }
  }

  // ── 報告 ──
  const byVerdict = (v: AuditVerdict) => findings.filter(f => f.verdict === v);
  const hard = [...byVerdict('NO_CLOSE_FILL'), ...byVerdict('SIGN_FLIP')];
  const soft = [...byVerdict('PARTIAL_CLOSE'), ...byVerdict('AMOUNT_MISMATCH'), ...byVerdict('NO_ENTRY_FILL')];

  console.log(`\n${'='.repeat(76)}`);
  console.log('對帳結果');
  console.log('='.repeat(76));
  for (const v of ['OK', 'NO_CLOSE_FILL', 'SIGN_FLIP', 'PARTIAL_CLOSE', 'AMOUNT_MISMATCH', 'NO_ENTRY_FILL'] as AuditVerdict[]) {
    const n = byVerdict(v).length;
    if (n > 0) console.log(`  ${v.padEnd(16)} ${String(n).padStart(4)} 筆`);
  }

  const show = (title: string, list: Finding[]) => {
    if (list.length === 0) return;
    console.log(`\n── ${title} ──`);
    for (const f of list) {
      console.log(`  ${ts(f.closedAt)}  ${f.symbol.replace('USDT', '').padEnd(6)} ${f.direction.padEnd(5)} `
        + `[${f.verdict}] ${f.note}`);
      console.log(`     trade_id=${f.id}`);
    }
  };
  show('硬證據：出場是捏造的', hard);
  show('需要人工判讀', soft);

  // 真實損益總計——只算對得上的，這是目前唯一可信的績效數字。
  const okAndMismatch = findings.filter(f => f.realizedPnlUsdt != null);
  const realTotal = okAndMismatch.reduce((s, f) => s + (f.realizedPnlUsdt ?? 0), 0);
  const dbTotalPct = findings.reduce((s, f) => s + (f.dbPnlPct ?? 0), 0);

  console.log(`\n${'='.repeat(76)}`);
  console.log(`真倉實際已實現損益（${okAndMismatch.length} 筆有成交紀錄的單）：${fmt(realTotal, 4)} USDT`);
  console.log(`同一批單 DB 記錄的 pnl_percent 加總：${fmt(dbTotalPct)}%（口徑不同，不能直接比，只看方向是否一致）`);
  if (hard.length > 0) {
    console.log(`\n⚠ ${hard.length} 筆是捏造出場。所有含這些單的統計（戰績卡、回撤、影子基準）都不可信。`);
    console.log('  修正前先確認：NO_CLOSE_FILL 的倉位是否還在幣安上開著——那種情況改 DB 會讓兩邊更不一致。');
  } else {
    console.log('\n沒有查到硬證據等級的捏造出場。');
  }

  const outPath = `audit-fabricated-exits-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(outPath, JSON.stringify({ generatedAt: Date.now(), days: DAYS, findings }, null, 2), 'utf-8');
  console.log(`\n完整結果已寫入 ${outPath}（UTF-8）`);
  console.log('這支腳本只讀不寫，沒有動任何倉位或 DB 資料。');
}

main().catch(e => {
  const detail = e && typeof e === 'object' && 'response' in e
    ? JSON.stringify((e as { response?: { data?: unknown } }).response?.data)
    : e instanceof Error ? e.message : String(e);
  console.error('對帳中止：', detail);
  process.exitCode = 1;
});
