#!/usr/bin/env npx tsx
/**
 * 不變量稽核 —— 「資料現在有沒有自相矛盾」，一個指令回答。
 *
 * ## 跟既有診斷工具的分工
 *
 *   status              系統活著嗎（現在這一刻的快照）
 *   audit-exits         幣安真實成交 ↔ DB 損益（需要打交易所 API，慢）
 *   audit-close-fills   觸發過的條件單有沒有平乾淨（近 7 天）
 *   funnel-verdict      各風控濾網在保護還是在害
 *   **audit-invariants  trades 表自己跟自己矛盾的地方（純 Supabase，快）**
 *
 * 這支補的是一個具體的空窗：上面四支都在問「DB 跟外部事實對不對得上」，
 * 沒有一支在問「DB 自己內部一致嗎」。而這個專案真正咬人的 bug 有一大類
 * 正是後者——**兩個寫入者（route.ts 的 DB 模擬、live-runner 的真倉）對同一
 * 張表的欄位語意認知不一致**，寫出來的列單看都合理，合起來才矛盾。
 *
 * 實例（2026-09-19 這支第一次跑就抓到）：`live-runner.markTp1Hit` 只寫
 * `status='tp1_hit'` 不寫 `result`，而 route.ts 接手關單時走
 * `isFinalClosingTp1` 分支、刻意不覆寫 `result`（它假設 TP1 當下已經寫過
 * `WIN_TP1`）。兩邊各自都對，交接處 `result` 永遠是 NULL。下游代價是靜默的：
 * `activeCooldowns` 用 `result === 'LOSS'` 判冷卻，NULL 的虧損單**拿不到
 * 24 小時同向冷卻**——風控漏擋，而且不會有任何錯誤訊息。
 *
 * ## 判讀原則
 *
 * 🔴 = 不變量被破壞，一定有程式或資料要修。
 * 🟡 = 可疑但有合法解釋，要人看一眼（例：止損距離極小的單在名目上限修好
 *      之前是真風險，之後只是「倉位被夾過」）。
 * 每項都印出 trade id，可以直接餵給 SQL 或 apply-audit-marks.ts。
 *
 * **只讀。** 不寫 DB、不碰倉位、不打交易所。
 *
 *   ENV_FILE=env.txt npm run audit-invariants
 *
 * 需要 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY。
 * 離開碼：有 🔴 → 1，只有 🟡 → 0（方便掛 CI 而不會被黃燈卡住）。
 */

import { createClient } from '@supabase/supabase-js';
import { loadEnvFile, reportEnvLoad } from './loadEnvFile';

const H = 3600_000;

/** 只在這裡列一次「已結束」的定義，免得每個檢查各寫一份會走鐘的版本。 */
const isClosed = (t: TradeRow) => t.closed_at != null;
const isCancelled = (t: TradeRow) => t.result === 'CANCELLED' || t.status === 'cancelled';

interface TradeRow {
  id: string;
  user_id: string | null;
  symbol: string;
  direction: string;
  status: string | null;
  result: string | null;
  close_reason: string | null;
  entry: number | null;
  stop_loss: number | null;
  tp1: number | null;
  tp2: number | null;
  exit_price: number | null;
  pnl_percent: number | null;
  opened_at: number | null;
  closed_at: number | null;
  filled_at: number | null;
  entry_qty: number | null;
  exchange_entry_order_id: number | null;
  exchange_stop_algo_id: number | null;
  exchange_tp1_algo_id: number | null;
  audit_verdict: string | null;
}

type Severity = 'red' | 'yellow';

interface Finding {
  severity: Severity;
  /** 穩定的代號，方便在報告/TODO 裡互相引用。 */
  code: string;
  title: string;
  /** 為什麼這是問題——下游會怎麼錯。沒有這一行的檢查不值得存在。 */
  why: string;
  rows: string[];
}

const findings: Finding[] = [];

function report(
  severity: Severity, code: string, title: string, why: string, rows: string[],
) {
  if (rows.length === 0) return;
  findings.push({ severity, code, title, why, rows });
}

/** `SOL trade-123…（2026-09-08 03:19）` 這種一眼看得懂的一行。 */
function label(t: TradeRow, extra = ''): string {
  const when = t.closed_at ?? t.opened_at;
  const ts = when ? new Date(when).toISOString().slice(0, 16).replace('T', ' ') : '時間未知';
  const sym = t.symbol.replace('USDT', '').padEnd(9);
  return `${sym} ${t.id}（${ts}）${extra}`;
}

// ── 檢查群 ────────────────────────────────────────────────────────────

/**
 * 已結束卻沒有 result。
 *
 * 這是「兩個寫入者交接處掉東西」的簽名。下游全部靜默受害：勝率統計漏算、
 * `activeCooldowns` 的 `result === 'LOSS'` 判不到、`checkStratBPaused` 的
 * 連兩敗偵測漏算。
 */
function checkClosedWithoutResult(trades: TradeRow[]) {
  const bad = trades.filter(t => isClosed(t) && t.result == null);
  report('red', 'CLOSED_NO_RESULT', '已平倉但 result 是 NULL',
    '勝率統計、虧損冷卻（activeCooldowns 判 result===LOSS）、策略B 連兩敗暫停全部會漏算這些單',
    bad.map(t => label(t, `close_reason=${t.close_reason ?? '-'} pnl=${t.pnl_percent ?? '-'}%`)));
}

/**
 * 還開著、已標 TP1、但 result 還是 NULL —— 上面那個 bug 的「現在進行式」版本。
 *
 * 抓這個比抓 CLOSED_NO_RESULT 更有價值：那些已經錯了改不回來，這些還在飛，
 * 現在補寫 result 還來得及讓冷卻與統計正確。
 */
function checkOpenTp1WithoutResult(trades: TradeRow[]) {
  const bad = trades.filter(t =>
    !isClosed(t) && t.status === 'tp1_hit' && t.result == null);
  report('red', 'TP1_NO_RESULT', '標成 tp1_hit 但 result 還是 NULL（單還開著）',
    '這筆一旦由 route.ts 關單就會走 isFinalClosingTp1 分支、不補寫 result，直接變成 CLOSED_NO_RESULT',
    bad.map(t => label(t)));
}

/** 已結束（非取消）卻沒有出場價，等於這筆的損益無從驗證。 */
function checkClosedWithoutExitPrice(trades: TradeRow[]) {
  const bad = trades.filter(t => isClosed(t) && !isCancelled(t) && t.exit_price == null);
  report('red', 'CLOSED_NO_EXIT_PRICE', '已平倉（非取消）但沒有 exit_price',
    '損益無法從價格重算，對帳腳本會把它歸進「無法驗證」而不是錯誤，容易被忽略',
    bad.map(t => label(t)));
}

/**
 * 同一個使用者同一個 symbol 有兩筆以上未平倉。
 *
 * 幣安是單向持倉模式，交易所端只有一個部位。DB 有兩列代表其中一列是幽靈——
 * 而兩列會各自掛自己的保護單、各自判 TP1，互相踩。
 */
function checkDuplicateOpen(trades: TradeRow[]) {
  const byKey = new Map<string, TradeRow[]>();
  for (const t of trades) {
    if (isClosed(t)) continue;
    const k = `${t.user_id ?? '-'}|${t.symbol}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(t);
  }
  const bad: string[] = [];
  for (const [k, list] of Array.from(byKey.entries())) {
    if (list.length > 1) {
      bad.push(`${k.split('|')[1]} 有 ${list.length} 筆未平倉：${list.map((t: TradeRow) => t.id).join(', ')}`);
    }
  }
  report('red', 'DUP_OPEN', '同一 symbol 同時多筆未平倉',
    '幣安是單向持倉，交易所端只有一個部位；多出來的列會各自掛保護單、各自判 TP1，互相撤單',
    bad);
}

/**
 * 方向不變量：LONG 的止損必須低於進場、TP 必須高於，SHORT 相反。
 *
 * 破壞這條代表訊號產生端算錯了價位，而不是執行端出錯——那種單一進場就等於
 * 立刻觸發止損，或者「止盈」在虧損側。
 */
function checkDirectionInvariants(trades: TradeRow[]) {
  const bad: string[] = [];
  for (const t of trades) {
    if (t.entry == null || t.entry <= 0) continue;
    const long = t.direction === 'LONG';
    if (t.stop_loss != null) {
      if (long && t.stop_loss >= t.entry) bad.push(label(t, `LONG 但 SL ${t.stop_loss} ≥ 進場 ${t.entry}`));
      if (!long && t.stop_loss <= t.entry) bad.push(label(t, `SHORT 但 SL ${t.stop_loss} ≤ 進場 ${t.entry}`));
    }
    if (t.tp1 != null) {
      if (long && t.tp1 <= t.entry) bad.push(label(t, `LONG 但 TP1 ${t.tp1} ≤ 進場 ${t.entry}`));
      if (!long && t.tp1 >= t.entry) bad.push(label(t, `SHORT 但 TP1 ${t.tp1} ≥ 進場 ${t.entry}`));
    }
  }
  report('red', 'BAD_LEVELS', '止損／止盈在錯誤的一側',
    '一進場就會立刻觸發止損，或者「止盈」其實在虧損側——訊號產生端算錯價位',
    bad);
}

/**
 * 止損距離極小的單。
 *
 * 名目 = 風險金額 ÷ 止損距離，止損距離趨近 0 時名目會爆炸，而每一道 R 上限
 * 都不會有反應（那個部位「就是 1R 風險」）。`calcPositionPlan` 在 2026-09-07
 * 加了名目上限擋住這件事，所以這裡是 🟡 不是 🔴：現在的意義是「這些單的
 * riskUSDT 會低於設定值」，以及手續費占 R 的比例會很難看
 * （費率% ÷ 止損距離%，純算術）。
 */
function checkTinyStopDistance(trades: TradeRow[]) {
  const bad: string[] = [];
  for (const t of trades) {
    if (t.entry == null || t.stop_loss == null || t.entry <= 0) continue;
    const dist = Math.abs(t.entry - t.stop_loss) / t.entry;
    if (dist < 0.002) {
      const feeR = (0.08 / (dist * 100)); // 來回約 0.08% 手續費，換算成幾個 R
      bad.push(label(t, `止損距離 ${(dist * 100).toFixed(3)}%，來回手續費約 ${feeR.toFixed(2)}R`));
    }
  }
  report('yellow', 'TINY_STOP', '止損距離 < 0.2%',
    '名目上限會把倉位夾小（riskUSDT 低於設定值），且手續費占 R 的比例極高——是算術不是統計',
    bad);
}

/**
 * 掛了很久還沒成交、也沒被取消的進場單。
 *
 * 這是「靜默停擺」的典型形狀：live-runner 該撤沒撤，那張單帶著過期的價位
 * 繼續掛在交易所上，而 DB 這側看起來一切正常。
 */
function checkStaleWaiting(trades: TradeRow[]) {
  const now = Date.now();
  const bad = trades.filter(t =>
    !isClosed(t) && t.status === 'waiting' && t.opened_at != null
    && now - t.opened_at > 24 * H);
  report('red', 'STALE_WAITING', '掛單超過 24 小時未成交也未取消',
    'live-runner 的到期撤單沒生效，過期價位的單還掛在交易所上；DB 這側看起來完全正常',
    bad.map(t => label(t, `已掛 ${((now - (t.opened_at ?? now)) / H).toFixed(1)} 小時`)));
}

/**
 * 裸倉：真倉已成交、部位開著，交易所端卻沒有止損單的 id。
 *
 * 這是這個專案最貴的失效模式——2026-09-06 的 UNI 翻倉就是保護單在某一輪
 * 之後消失。注意這裡只看 DB 有沒有記下 algo id，真的有沒有掛在交易所上要
 * 跑 `npm run status`（那支會打幣安）。
 */
function checkNakedLivePosition(trades: TradeRow[]) {
  const bad = trades.filter(t =>
    !isClosed(t)
    && t.exchange_entry_order_id != null
    && (t.entry_qty ?? 0) > 0
    && t.exchange_stop_algo_id == null);
  report('red', 'NAKED_POSITION', '真倉部位開著但 DB 沒有止損單 id',
    '沒有保護單的部位吃全部下檔風險；交易所端實況要再跑 npm run status 確認',
    bad.map(t => label(t, `數量 ${t.entry_qty}`)));
}

/**
 * pnl_percent 跟 entry/exit_price 算出來的不一致。
 *
 * 容差刻意放寬到 0.3 個百分點，而且跳過 TP1 已觸發的單——那些的 pnl 是
 * `blendTp1PartialPnl` 的加權平均（TP1 出 50%、剩下走到最終出場價），本來
 * 就不等於「進場到出場」的單純價差，拿單純價差去比會全部誤報。
 */
function checkPnlConsistency(trades: TradeRow[]) {
  const bad: string[] = [];
  for (const t of trades) {
    if (!isClosed(t) || isCancelled(t)) continue;
    if (t.entry == null || t.exit_price == null || t.pnl_percent == null || t.entry <= 0) continue;
    if (t.status === 'tp1_hit' || t.result === 'WIN_TP1' || t.result === 'WIN_TP2') continue;
    const calc = t.direction === 'LONG'
      ? ((t.exit_price - t.entry) / t.entry) * 100
      : ((t.entry - t.exit_price) / t.entry) * 100;
    const diff = Math.abs(calc - t.pnl_percent);
    if (diff > 0.3) {
      bad.push(label(t, `DB ${t.pnl_percent}% vs 由價格重算 ${calc.toFixed(2)}%，差 ${diff.toFixed(2)} 個百分點`));
    }
  }
  report('red', 'PNL_MISMATCH', 'pnl_percent 跟進出場價算不出來',
    '損益欄位跟價格欄位其中一個是錯的；R 倍數全部由 pnl_percent ÷ 止損距離推導，錯這裡等於整份統計失真',
    bad);
}

/** 同一張交易所進場單被兩列 trade 認領——FIFO 對帳會把同一筆成交算兩次。 */
function checkDuplicateOrderIds(trades: TradeRow[]) {
  const seen = new Map<number, string[]>();
  for (const t of trades) {
    if (t.exchange_entry_order_id == null) continue;
    const k = t.exchange_entry_order_id;
    (seen.get(k) ?? seen.set(k, []).get(k)!).push(t.id);
  }
  const bad: string[] = [];
  for (const [oid, ids] of Array.from(seen.entries())) {
    if (ids.length > 1) bad.push(`entry order ${oid} 被 ${ids.length} 列認領：${ids.join(', ')}`);
  }
  report('red', 'DUP_ORDER_ID', '同一張交易所進場單被多列 trade 認領',
    '對帳的 FIFO 配對會把同一筆成交算兩次，損益統計與回撤都會被放大',
    bad);
}

/**
 * 已標記為髒資料（audit_verdict 說出場是捏造的）卻仍帶著看起來正常的損益。
 *
 * 不是要改它們——`apply-audit-marks.ts` 刻意不動 result/pnl_percent——而是
 * 提醒：任何直接對 trades 做統計的地方如果沒有排除這些列，數字就是髒的。
 */
function checkDirtyMarks(trades: TradeRow[]) {
  const dirty = trades.filter(t =>
    t.audit_verdict != null && t.audit_verdict !== 'OK' && t.audit_verdict !== '');
  report('yellow', 'DIRTY_MARKED', '已標記為對帳異常的單仍在統計範圍內',
    '任何直接統計 trades 的地方（戰績卡、回撤、影子基準）若沒排除 audit_verdict≠OK 的列，數字就是髒的',
    dirty.length > 0 ? [`共 ${dirty.length} 筆被標記：`
      + Array.from(new Set(dirty.map(t => t.audit_verdict))).join(' / ')] : []);
}

// ── 主流程 ────────────────────────────────────────────────────────────

async function main() {
  reportEnvLoad(loadEnvFile());
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  const days = parseInt(process.argv[2] ?? '120', 10);
  const since = Date.now() - days * 24 * H;

  // 一次撈完再在記憶體裡跑所有檢查：檢查之間會互相參照（例如重複認領要看
  // 全表），而且一個查詢比十個查詢省 Supabase 額度。
  const { data, error } = await db.from('trades')
    .select('id,user_id,symbol,direction,status,result,close_reason,entry,stop_loss,tp1,tp2,'
      + 'exit_price,pnl_percent,opened_at,closed_at,filled_at,entry_qty,'
      + 'exchange_entry_order_id,exchange_stop_algo_id,exchange_tp1_algo_id,audit_verdict')
    .gte('opened_at', since)
    .order('opened_at', { ascending: false })
    .limit(2000);
  if (error) throw new Error(`Supabase 查詢失敗：[${error.code}] ${error.message}`);
  const trades = (data ?? []) as unknown as TradeRow[];

  console.log(`\n稽核範圍：近 ${days} 天，${trades.length} 筆 trades`
    + `（未平倉 ${trades.filter(t => !isClosed(t)).length} 筆）`);

  checkClosedWithoutResult(trades);
  checkOpenTp1WithoutResult(trades);
  checkClosedWithoutExitPrice(trades);
  checkDuplicateOpen(trades);
  checkDirectionInvariants(trades);
  checkTinyStopDistance(trades);
  checkStaleWaiting(trades);
  checkNakedLivePosition(trades);
  checkPnlConsistency(trades);
  checkDuplicateOrderIds(trades);
  checkDirtyMarks(trades);

  const line = '='.repeat(76);
  const reds = findings.filter(f => f.severity === 'red');
  const yellows = findings.filter(f => f.severity === 'yellow');

  for (const f of [...reds, ...yellows]) {
    console.log(`\n${line}`);
    console.log(`${f.severity === 'red' ? '🔴' : '🟡'} [${f.code}] ${f.title} —— ${f.rows.length} 項`);
    console.log(`   影響：${f.why}`);
    console.log(line);
    for (const r of f.rows.slice(0, 20)) console.log(`   ${r}`);
    if (f.rows.length > 20) console.log(`   …另外 ${f.rows.length - 20} 筆`);
  }

  console.log(`\n${line}`);
  if (findings.length === 0) {
    console.log('✅ 所有不變量都成立。');
  } else {
    console.log(`🔴 ${reds.length} 類不變量被破壞 / 🟡 ${yellows.length} 類需人工判讀`);
  }
  console.log('這支腳本只讀不寫，沒有動任何倉位或 DB 資料。');
  process.exit(reds.length > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
