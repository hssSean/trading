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
 * 環境變數（跟 live-runner 同一組）。寫進專案根目錄的 `.env.local`
 * （已在 .gitignore 裡）或設在 shell 裡皆可，shell 優先：
 *   NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 *   TRADING_USER_ID
 *   BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET
 *
 * ⚠ 這些值不要貼進任何聊天視窗、issue 或截圖。service role key 是繞過所有
 *   RLS 的資料庫管理員權限，幣安 secret 有合約交易權限。載入器只印變數名
 *   不印值，這支腳本的錯誤處理也只吐回應內容不吐請求標頭。
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
import { pairedCompare } from '../src/lib/exitPolicy';
import { loadEnvFile, reportEnvLoad } from './loadEnvFile';
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
  /** TP1 條件單的 algoId。有值＝真的掛上過。 */
  exchange_tp1_algo_id?: string | number | null;
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
  /** 這筆單真正冒的風險（USDT）＝ 成交數量 × |進場價 − 止損價|。 */
  riskUsdt: number | null;
  /** 真實 R 倍數 ＝ 已實現損益 ÷ 風險。專案一律用 R 衡量，不用原始 %。 */
  realR: number | null;
  note: string;
}

function fmt(n: number | null | undefined, d = 2): string {
  return n == null || !Number.isFinite(n) ? '—' : n.toFixed(d);
}
function ts(t: number | null): string {
  return t == null ? '—' : new Date(t).toISOString().slice(0, 16).replace('T', ' ');
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const PAGE = 1000; // 幣安 userTrades 單次上限

/**
 * 撈某個 symbol 在 [from, to] 區間內的**全部**成交。
 *
 * 分 7 天一段（幣安時間窗上限），而**單一時間窗塞滿 1000 筆時要用 fromId
 * 續抓**——2026-08-30 實測 HYPEUSDT 七天內 1012 筆成交，原本只用時間窗的
 * 版本會靜默漏掉超出的部分，而漏掉的成交會讓對帳把正常平倉判成
 * NO_CLOSE_FILL（硬證據等級的誤判），也讓已實現損益總計失真。
 *
 * fromId 不能跟 startTime/endTime 併用（幣安會忽略時間參數），所以續抓時
 * 只帶 fromId，回傳的結果自己按時間濾回窗內。
 */
async function fetchAllUserTrades(
  client: BinanceFuturesClient, symbol: string, from: number, to: number,
): Promise<UserTrade[]> {
  const byId = new Map<number, UserTrade>(); // 時間窗與 id 遊標會重疊，用 id 去重

  for (let start = from; start < to; start += WINDOW_MS) {
    const end = Math.min(start + WINDOW_MS, to);
    let batch = await client.getUserTrades(symbol, { startTime: start, endTime: end, limit: PAGE });
    batch.forEach(f => byId.set(f.id, f));
    await sleep(250); // 幣安 REST 權重限制，慢一點沒關係

    // 這個窗被塞滿了，代表可能還有更多。用 id 遊標往前推到拿不滿一頁，
    // 或推出這個時間窗為止。
    //
    // 迴圈上界是保險絲：分頁條件寫錯（例如 fromId 沒有往前）會變成無限
    // 迴圈打幣安 API，那比漏資料更糟。100 頁 = 10 萬筆，遠超任何合理情況。
    let guard = 0;
    while (batch.length === PAGE && guard++ < 100) {
      const lastId = Math.max(...batch.map(f => f.id));
      batch = await client.getUserTrades(symbol, { fromId: lastId + 1, limit: PAGE });
      await sleep(250);
      if (batch.length === 0) break;

      const inWindow = batch.filter(f => f.time <= end);
      inWindow.forEach(f => byId.set(f.id, f));
      // 有成交超出這個窗了，剩下的交給下一個窗的時間查詢處理。
      if (inWindow.length < batch.length) break;
    }
    if (guard >= 100) {
      console.warn(`⚠ ${symbol} ${ts(start)} 起分頁超過 100 頁，已中止——結果可能不完整`);
    }
  }

  return Array.from(byId.values()).sort((a, b) => a.time - b.time);
}

async function main() {
  reportEnvLoad(loadEnvFile());

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
    .select('id, symbol, direction, entry, stop_loss, exit_price, pnl_percent, result, close_reason, opened_at, filled_at, closed_at, exchange_entry_order_id, exchange_tp1_algo_id')
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
  /** 每個 symbol 的「成交筆數 ÷ 單數」。密度越高，FIFO 配對越不可靠。 */
  const fillDensity = new Map<string, number>();
  /** trade_id → TP1 條件單有沒有真的掛上。用來衡量「執行忠實度」。 */
  const tp1Placed = new Map<string, boolean | null>();

  for (const symbol of symbols) {
    const rows = real.filter(t => t.symbol === symbol)
      .sort((a, b) => (a.opened_at ?? 0) - (b.opened_at ?? 0));
    const earliest = Math.min(...rows.map(t => t.opened_at ?? t.filled_at ?? since));
    const fills = await fetchAllUserTrades(client, symbol, earliest - 3600_000, Date.now());
    fillDensity.set(symbol, rows.length > 0 ? fills.length / rows.length : 0);
    console.log(`  ${symbol}: ${rows.length} 筆單 / ${fills.length} 筆成交`);

    // FIFO 配對：記錄每筆成交**已被用掉的數量**，不是「用過沒」。一張大額
    // 平倉成交常橫跨多筆單，用布林集合會讓剩餘量永遠配不到（2026-09-04 實測
    // 涵蓋率只有 64.9%）。幣安不記我們的 trade_id，重疊倉位仍只能近似
    // ——見檔頭「已知限制」。
    const consumed = new Map<number, number>();

    for (const t of rows) {
      const r = auditTradeExit({
        entryOrderId: Number(t.exchange_entry_order_id),
        dbPnlPercent: t.pnl_percent,
        fills,
        consumed,
      });
      for (const [id, qty] of r.consumedDelta) consumed.set(id, (consumed.get(id) ?? 0) + qty);

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

      // R 倍數要用**真實成交量與真實進場均價**算風險，不能用 DB 的 entry：
      // DB 記的是訊號價，真實成交可能滑價，而 R 的分母錯了整個 R 就錯了。
      // 止損價只有 DB 有（那是我們的決定，不是交易所的事實）。
      const stopDist = t.stop_loss != null && r.entryAvg != null
        ? Math.abs(r.entryAvg - t.stop_loss) : null;
      const riskUsdt = stopDist != null && stopDist > 0 && r.entryQty != null
        ? stopDist * r.entryQty : null;
      const realR = riskUsdt != null && riskUsdt > 0 && r.realizedPnlUsdt != null
        ? r.realizedPnlUsdt / riskUsdt : null;

      tp1Placed.set(t.id, t.exchange_tp1_algo_id != null);
      findings.push({
        id: t.id, symbol, direction: t.direction, verdict: r.verdict,
        closedAt: t.closed_at, dbResult: t.result, dbPnlPct: t.pnl_percent,
        realPnlPct: r.realPnlPct, realizedPnlUsdt: r.realizedPnlUsdt,
        entryQty: r.entryQty, closedQty: r.closedQty, riskUsdt, realR, note,
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

  // NO_CLOSE_FILL 的下一個問題一定是「那倉位現在還開著嗎」——這決定要不要
  // 立刻處理（真的開著＝有未受管理的曝險），還是只是配對誤差。直接查完，
  // 不要讓人拿著報告再去手動比對。positionRisk 是 GET，唯讀。
  const noClose = byVerdict('NO_CLOSE_FILL');
  if (noClose.length > 0) {
    console.log(`\n── NO_CLOSE_FILL 的 symbol 現在的實際倉位 ──`);
    for (const sym of Array.from(new Set(noClose.map(f => f.symbol)))) {
      try {
        const pos = await client.getPositionRisk(sym);
        const live = pos.filter(p => parseFloat(p.positionAmt) !== 0);
        if (live.length === 0) {
          console.log(`  ${sym}：目前無倉位 → 倉位已經平掉了（可能是手動平的），`
            + `配對不到是因為平倉成交被同 symbol 的其他單先消耗掉`);
        } else {
          for (const p of live) {
            console.log(`  ${sym}：⚠ 仍有倉位 ${p.positionAmt} @ ${p.entryPrice}，`
              + `未實現損益 ${fmt(parseFloat(p.unRealizedProfit), 4)} USDT`);
          }
        }
      } catch (e) {
        console.log(`  ${sym}：查詢失敗 ${e instanceof Error ? e.message : String(e)}`);
      }
      await sleep(250);
    }
  }

  // ── 軟證據分類：realR 到底還能不能信 ──
  //
  // 硬證據（NO_CLOSE_FILL / SIGN_FLIP）已經確定 DB 是錯的。軟證據
  // （AMOUNT_MISMATCH / PARTIAL_CLOSE）比較麻煩：DB 跟現實對不上，但**對不上
  // 不代表 realR 是錯的**——realR 來自交易所成交紀錄，DB 錯不影響它。
  //
  // 真正會讓 realR 失真的只有一件事：**FIFO 把別筆單的平倉成交配給了這筆**。
  // 幣安不記我們的 trade_id，同一個 symbol 上成交筆數遠多於單數時就會發生。
  // 所以分類的關鍵不是「差多少」，是「這個 symbol 的成交密度高不高」。
  //
  // 另外把 -0.05% 那個簽名單獨挑出來——那是保本價扣掉 STOP_EXIT_SLIPPAGE_PCT，
  // 等於捏造出場那個 bug 的殘留，只是這幾筆的真實結果後來是虧的所以沒被判成
  // SIGN_FLIP。它們的 realR 是可信的（DB 錯、交易所對）。
  // NO_ENTRY_FILL 不在這裡分類——那些連 realR 都沒有，沒有東西可判。
  const withRealR = findings.filter(f =>
    f.verdict === 'AMOUNT_MISMATCH' || f.verdict === 'PARTIAL_CLOSE');
  if (withRealR.length > 0) {
    const FAKE_BE = 0.02;            // -0.05% 的容差
    const DENSE = 20;                // 每筆單超過 20 筆成交就當高密度
    const cat = { fabricated: [] as Finding[], fifo: [] as Finding[], normal: [] as Finding[] };
    for (const f of withRealR) {
      const dense = (fillDensity.get(f.symbol) ?? 0) >= DENSE;
      if (f.dbPnlPct != null && Math.abs(f.dbPnlPct + 0.05) < FAKE_BE) cat.fabricated.push(f);
      else if (dense) cat.fifo.push(f);
      else cat.normal.push(f);
    }
    const sumR = (l: Finding[]) => l.reduce((s, f) => s + (f.realR ?? 0), 0);

    console.log(`\n${'='.repeat(76)}`);
    console.log(`軟證據分類（${withRealR.length} 筆）—— 判斷 realR 還能不能用`);
    console.log('='.repeat(76));
    console.log(`  捏造保本出場的殘留（DB 記 -0.05%）  ${String(cat.fabricated.length).padStart(3)} 筆  `
      + `合計 ${fmt(sumR(cat.fabricated), 2)}R  → realR 可信（錯的是 DB）`);
    console.log(`  高成交密度，FIFO 可能誤配            ${String(cat.fifo.length).padStart(3)} 筆  `
      + `合計 ${fmt(sumR(cat.fifo), 2)}R  → realR 存疑`);
    console.log(`  一般滑價/部分成交誤差                ${String(cat.normal.length).padStart(3)} 筆  `
      + `合計 ${fmt(sumR(cat.normal), 2)}R  → realR 可信`);
    if (cat.fifo.length > 0) {
      console.log(`  存疑的 symbol：${Array.from(new Set(cat.fifo.map(f => f.symbol))).join(', ')}`);
    }
  }

  // ── 真實 R 分布 ──
  //
  // 這才是能回答「策略有沒有邊際」的數字。USDT 總額看不出好壞——它同時混了
  // 倉位大小的變化；R 已經除掉風險，每一筆都是可比的。專案慣例（規格書 §4）
  // 一律用 R，原始 % 在 ATR 止損下會嚴重誤導。
  //
  // 單樣本 t 檢定對「平均 R = 0」。t 只是把「效果量」跟「樣本雜訊」放在同一
  // 把尺上，不是「策略好不好」的裁決——|t| < 2 代表**這批資料分不出來**，
  // 不代表沒有邊際，也不代表有。
  const withR = findings.filter(f => f.realR != null && Number.isFinite(f.realR));
  const rStats = (list: Finding[]) => {
    const xs = list.map(f => f.realR as number);
    const n = xs.length;
    if (n < 2) return { n, mean: NaN, sd: NaN, t: NaN, total: NaN };
    const mean = xs.reduce((s, v) => s + v, 0) / n;
    const sd = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));
    return { n, mean, sd, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0, total: mean * n };
  };

  console.log(`\n${'='.repeat(76)}`);
  console.log('真實 R 分布（已實現損益 ÷ 真實風險）');
  console.log('='.repeat(76));

  const show2 = (label: string, s: ReturnType<typeof rStats>) => {
    console.log(`  ${label.padEnd(34)} n=${String(s.n).padStart(3)}  `
      + `每筆 ${fmt(s.mean, 3).padStart(7)}R  合計 ${fmt(s.total, 2).padStart(8)}R  `
      + `sd ${fmt(s.sd, 2)}  t=${fmt(s.t, 2)}`);
  };
  show2('全部', rStats(withR));

  // 同一個 symbol 上成交筆數遠多於單數時，FIFO 配對最不可靠。ZEC/HYPE 是
  // 明顯的例子（800/1012 筆成交對 10/7 筆單），而 HYPE 還撞到查詢上限。
  // 拿掉它們看結論會不會翻——會翻就代表結論是被配對誤差撐起來的。
  const noisy = new Set(['ZECUSDT', 'HYPEUSDT']);
  show2('排除 ZEC/HYPE（配對最不可靠）', rStats(withR.filter(f => !noisy.has(f.symbol))));
  show2('只看判定 OK 的', rStats(withR.filter(f => f.verdict === 'OK')));

  // ── DB 模擬 vs 真實：系統性偏誤有多大 ──
  //
  // 這一段的用途不是評斷這 73 筆，而是評斷**另外那 76 筆**。純 DB 模擬的單
  // 沒有 exchange_entry_order_id，永遠無法對帳——但它們跟真倉共用同一套推演
  // 邏輯（K 線收盤價 + 滑價模型）。所以在真倉上量到的偏誤，就是對那 76 筆
  // 誤差的最好估計。
  //
  // 成對比較（同一筆單的兩個量測），不是兩組平均值相比——配對消掉了「不同
  // 單本來就有不同結果」這個最大的變異來源，檢定力高很多。
  const paired = findings.filter(f => f.dbPnlPct != null && f.realPnlPct != null);
  if (paired.length >= 2) {
    const cmp = pairedCompare(
      paired.map(f => f.dbPnlPct as number),
      paired.map(f => f.realPnlPct as number),
    );
    console.log(`\n── DB 模擬 vs 真實成交（n=${cmp.n} 成對）──`);
    console.log(`  真實 − DB 模擬 = ${fmt(cmp.meanDiff, 3)} 個百分點/筆   t=${fmt(cmp.t, 2)}`
      + `   ${cmp.significant ? '← 顯著' : '（不顯著）'}`);
    // 符號檢定：只看「方向對不對」，不看幅度。
    //
    // 這裡刻意兩種檢定都跑，因為它們會不一致而那個不一致本身就是資訊。
    // t 檢定用到幅度，被幾筆 +4R 的捏造出場（厚尾）稀釋掉檢定力；符號檢定
    // 只數正負，對厚尾免疫。偏誤如果是「方向一致但幅度不定」，t 會看不到而
    // 符號檢定看得到——那正是系統性偏誤的典型形狀。
    const diffs = paired.map(f => (f.realPnlPct as number) - (f.dbPnlPct as number)).filter(d => d !== 0);
    const pos = diffs.filter(d => d > 0).length;
    const nz = diffs.length;
    // 常態近似（n=69 遠超過需要的 30），H0: 正負各半。
    const z = nz > 0 ? (pos - nz / 2) / Math.sqrt(nz * 0.25) : 0;
    console.log(`  DB 低估結果的比例 ${fmt(pos / nz * 100, 1)}%（${pos}/${nz}）  `
      + `符號檢定 z=${fmt(z, 2)}  ${Math.abs(z) >= 1.96 ? '← 顯著' : '（不顯著）'}`);
    console.log(`  偏誤為正代表 DB 模擬系統性地把結果記得比實際差；`);
    console.log(`  同一套推演也用在另外 76 筆無法對帳的純模擬單上。`);
  }

  // ── 執行忠實度：這些單真的照策略跑過嗎 ──
  //
  // 這一段回答的問題跟上面完全不同。上面問「策略賺不賺」，這裡問**「我們到底
  // 有沒有在測策略」**。
  //
  // 策略設計是 TP1 平 50%、剩下交給移動止損。如果 TP1 條件單根本沒掛上，
  // 那筆單就不是「策略的表現」——它是「策略的殘缺版本」的表現：吃到全部的
  // 下檔風險，卻拿不到設計中的部分獲利了結。
  //
  // 2026-09-01 實測有兩種讓單子偏離設計的機制：TP1 單沒掛上（UNI 實測撞到），
  // 以及部分成交被誤標成「從未開倉」變成沒人管的孤兒（ARB 實測撞到，已修）。
  // 兩者都會讓量到的 R 系統性偏低，而且跟策略好壞無關。
  const tp1Groups = { placed: [] as Finding[], notPlaced: [] as Finding[], unknown: [] as Finding[] };
  for (const f of withR) {
    const v = tp1Placed.get(f.id);
    if (v === true) tp1Groups.placed.push(f);
    else if (v === false) tp1Groups.notPlaced.push(f);
    else tp1Groups.unknown.push(f);
  }
  const grpStat = (l: Finding[]) => {
    const s = rStats(l);
    return `n=${String(s.n).padStart(3)}  每筆 ${fmt(s.mean, 3).padStart(7)}R  合計 ${fmt(s.total, 2).padStart(8)}R`;
  };
  console.log(`\n${'='.repeat(76)}`);
  console.log('執行忠實度：TP1 條件單有沒有真的掛上');
  console.log('='.repeat(76));
  console.log(`  有掛上      ${grpStat(tp1Groups.placed)}`);
  console.log(`  沒掛上      ${grpStat(tp1Groups.notPlaced)}`);
  console.log(`  讀不到欄位  ${grpStat(tp1Groups.unknown)}`);
  console.log(`  沒掛上的單吃到全部下檔風險，卻拿不到設計中的 TP1 部分獲利了結——`);
  console.log(`  那不是「策略的表現」，是「策略殘缺版本」的表現。`);

  const wins = withR.filter(f => (f.realR as number) > 0).length;
  console.log(`\n  勝率 ${fmt(wins / withR.length * 100, 1)}%（${wins}/${withR.length}）`);
  console.log('  |t| < 2 代表這批資料分不出「平均 R ≠ 0」——不等於沒有邊際，也不等於有。');

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
