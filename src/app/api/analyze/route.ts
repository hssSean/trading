import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { fetchCandles, fetchTopCoinsByVolume, fetchFundingRate, fetchOpenInterestChange } from '@/api/binance';
import { calcAtrHistory, calcAtrPercentile, adx as calcAdx, ema as calcEma } from '@/analysis/indicators';
import { generateSignals, generateMeanReversionSignals, unifySignalDirection } from '@/analysis/signals';
import type { RejectedCandidate } from '@/analysis/signals';
import { Candle, Timeframe, TradingSignal, Regime } from '@/types';
import { sendWebPushToUser } from '@/lib/webpush';
import { calcPositionPlan, formatPlanLine, tierRiskMultiplier, MAX_TOTAL_RISK_PCT } from '@/lib/position';
import { clampAutoCloseAfterTp1, walkTpSl, deriveCloseReason, updateMfeMae, calcSimpleAtr, calcDrawdown, blendTp1PartialPnl, TP1_PARTIAL_FRACTION, applyStopSlippage, applyFundingRateCrowdingPenalty, type EquityPoint, type DrawdownState } from '@/lib/monitorMath';
import { fetchCandlesCached } from '@/lib/candleCache';
import { is4hBarUnchanged, getRegimeCache, setRegimeCache, type RegimeCacheEntry } from '@/lib/regimeCache';
import { isSignalCacheHit, getSignalCache, setSignalCache, cloneSignals, freshenCachedSignals } from '@/lib/signalCache';
import { startTimeStopShadow, advanceTimeStopShadow, type TimeStopShadow, type TimeStopTrigger } from '@/lib/timeStopShadow';
import { startCancelShadow, advanceCancelShadow, type CancelShadow } from '@/lib/cancelShadow';
import { shouldEnterAtMarket, shiftSignalToMarketEntry } from '@/lib/marketEntryException';

export const maxDuration = 60;

const HTF_MAP: Partial<Record<Timeframe, Timeframe>> = {
  '5m': '15m', '15m': '1h', '1h': '4h', '4h': '1d',
};

// ── Persistent lock via Upstash Redis ─────────────────────────
// Survives Vercel cold starts (unlike module-level Maps).
// Falls back to in-memory when env vars aren't set.
interface LockEntry {
  sentAt:       number;
  candleBucket: number;
  direction:    string;
  locked:       boolean; // true = active trade in journal
}
const LOCK_TTL_SEC     = 24 * 3600;        // 24h lock for intraday trades
// 2026-08-07：2h → 6h。掛單過期用的是 WAITING_EXPIRY_BARS=4 根K線，這批
// 資料主力時框是 1h，等於自然過期窗口就有 4h——2h 冷卻比自然過期還短，
// 結構上不可能真的擋住「過期解鎖後立刻再發同一個幣種」這件事，冷卻機制
// 形同虛設（另見 unlockSymbol 的 sentAt 歸零 bug，兩者疊加是 8/6 CSV 查出
// ADAUSDT/ZECUSDT 重複洗版的直接原因）。6h 給出比自然過期窗口更長的緩衝，
// 不是照這批樣本精算出的最佳值，是中庸值——樣本不足以決定精確門檻。
const COOLDOWN_MS      = 6 * 60 * 60 * 1000; // 6h cooldown between signals for the same symbol
const STRONG_THRESHOLD   = 65;               // Strategy A: v2 spec ≥65 to notify
const STRONG_THRESHOLD_B = 13;               // Strategy B: base 10 (BB+RSI cross) + ≥1 confirmation
const INTRADAY_CLOSE_HOURS = 24;             // auto-close active trades older than 24h
const WAITING_EXPIRY_HOURS = 8;              // candle-window fallback for waiting orders
const WAITING_EXPIRY_BARS  = 4;              // spec §3-A: 掛單有效期最多 4 根（該時框）K 線

// 2026-08-13（docs/策略修改.md 修改1）：TP1 前保本保護——8/12 CSV 複查
// 查出時間止損砍掉的 15 筆單合計回吐 10.09R（浮盈曾到 +1.47R，最後只拿
// +0.17R 這種），因為 TP1 之前止損從 2026-07-21（移除多階「利潤階梯」）
// 起就固定停在原始 SL，完全不動。這裡只加「單階」保護：浮盈首次達
// +0.8R 時止損上移到進場價（保本），不做多段階梯——7/21 移除的正是多階
// 版本，理由是「複雜度換不到對應的效益證明」，這次刻意只做一階。
// 0.8R 是照 15 筆回吐樣本挑的中庸值（9 筆 MFE≥0.62R，設 0.8 可攔到其中
// 6 筆且不會太貼近進場價被雜訊掃出）——不是最佳化結果，樣本不足以決定
// 精確門檻，之後不要憑感覺微調這個數字，要調就重新拉數據。
//
// 2026-08-17（docs/策略體檢-2026-08-16.md §0）：8/16 CSV 複查發現 0.8R
// 這個值實測 0/20 虧損單觸發過（最高 MFE 只有 0.65R）——門檻設太高，這
// 個機制上線以來等於沒生效。同一份資料顯示 5/20 虧損單 MFE≥0.5R，改成
// 0.5 才會真的開始攔到東西。這不是新一輪最佳化，是修正「原始估計值挑
// 太保守，導致機制實質死碼」的問題。
const PRE_TP1_BREAKEVEN_TRIGGER_R = 0.5;

function tfBarMinutes(tf: string | null | undefined): number {
  switch (tf) {
    case '5m':  return 5;
    case '15m': return 15;
    case '4h':  return 240;
    case '1d':  return 1440;
    default:    return 60;
  }
}


// Per-strategy threshold: Strategy B uses a 0-19 scoring scale; Strategy A uses 0-100.
// v2.1 §1.5: tiered Strategy-A signals (A=65+/B=55+) are pre-gated inside
// generateSignals — any signal carrying a tier already qualifies.
function isStrongEnough(s: TradingSignal): boolean {
  if (s.strategy === 'B') return s.score >= STRONG_THRESHOLD_B;
  if (s.tier) return true;
  return s.score >= STRONG_THRESHOLD;
}

let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (_redis) return _redis;
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    _redis = Redis.fromEnv();
    return _redis;
  }
  return null;
}

// In-memory fallback (lost on cold start, but works when Redis isn't wired)
const memLock = new Map<string, LockEntry>();

// ── Periodic-work throttle ─────────────────────────────────────
// The cron fires every minute, but not everything in a scan needs that cadence.
// Both shadow simulators advance positions against *1-hour* candles, so running
// them every minute instead of every 10 does identical work 10 times over — and
// each run costs up to 8 symbols × 96-168 candles of fetch + parse. Their own
// comments still read "next cron (5 min later)", from when the schedule was 5m.
//
// SET key 1 NX EX <period> is one command that both tests and claims the window:
// null means somebody already ran inside this window, so skip.
async function claimPeriodicSlot(key: string, periodSec: number): Promise<boolean> {
  const r = getRedis();
  if (!r) return true; // no Redis: nothing to throttle against, just run
  try {
    const got = await r.set(key, Date.now(), { nx: true, ex: periodSec });
    return got !== null;
  } catch {
    return true; // Redis hiccup must not silently stop the simulators forever
  }
}

const SHADOW_ADVANCE_PERIOD_SEC = 600; // 10 min

// ── Post-loss cooldown ─────────────────────────────────────────
// 2026-07-17 journal review: AKE stopped out, unlocked, and re-longed the same
// day for a second -12%. After a LOSS close, block the same symbol+direction
// for 24h — re-entering a setup that just proved wrong needs a fresh day.
const LOSS_COOLDOWN_SEC = 24 * 3600;
const memLossCd = new Map<string, number>(); // `${symbol}:${dir}` → expiry ms

async function setLossCooldown(symbol: string, direction: string, ttlSec: number = LOSS_COOLDOWN_SEC): Promise<void> {
  memLossCd.set(`${symbol}:${direction}`, Date.now() + ttlSec * 1000);
  const r = getRedis();
  if (r) {
    try { await r.set(`loss_cd:${symbol}:${direction}`, '1', { ex: ttlSec }); } catch { /* mem holds */ }
  }
}

async function isOnLossCooldown(symbol: string, direction: string): Promise<boolean> {
  const mem = memLossCd.get(`${symbol}:${direction}`);
  if (mem && mem > Date.now()) return true;
  const r = getRedis();
  if (r) {
    try { return !!(await r.get(`loss_cd:${symbol}:${direction}`)); } catch { /* fall through */ }
  }
  return false;
}

// ── v2.4 §1: Directional bias hold after an "opportunity-expired" cancel ──────
// When a limit order is cancelled because the entry never triggered (timeout /
// price ran away / TP1 hit without us) — the DIRECTION was still right, we just
// missed the entry. Spec red line: such a cancel must NEVER lead straight to a
// reverse order. We hold the bias for 12 bars: same-direction re-entry is fine,
// opposite-direction signals are downgraded to watch (skipped). A "thesis
// invalidated" cancel (structure broke) sets NO hold — reverse is allowed.
const BIAS_HOLD_BARS = 12;
const memBiasHold = new Map<string, { dir: string; until: number }>(); // symbol → held dir

async function setBiasHold(symbol: string, direction: string, ttlSec: number): Promise<void> {
  memBiasHold.set(symbol, { dir: direction, until: Date.now() + ttlSec * 1000 });
  const r = getRedis();
  if (r) {
    try { await r.set(`bias_hold:${symbol}`, direction, { ex: ttlSec }); } catch { /* mem holds */ }
  }
}

async function getBiasHold(symbol: string): Promise<string | null> {
  const r = getRedis();
  if (r) {
    try {
      const v = await r.get<string>(`bias_hold:${symbol}`);
      if (v) return v;
    } catch { /* fall through to memory */ }
  }
  const mem = memBiasHold.get(symbol);
  return mem && mem.until > Date.now() ? mem.dir : null;
}

async function getLock(symbol: string): Promise<LockEntry | null> {
  const r = getRedis();
  if (r) {
    try { return await r.get<LockEntry>(`tlock:${symbol}`); } catch { /* fall through */ }
  }
  return memLock.get(symbol) ?? null;
}

async function setLock(symbol: string, entry: LockEntry): Promise<void> {
  const r = getRedis();
  if (r) {
    try { await r.set(`tlock:${symbol}`, entry, { ex: LOCK_TTL_SEC }); return; } catch { /* fall through */ }
  }
  memLock.set(symbol, entry);
}

// 2026-08-07（docs/ANALYSIS-2026-08-06B 方法2）：這裡原本把 sentAt 歸零
// （`sentAt: 0`），意圖大概是「解鎖了就當作從沒發過訊號」。但下面 onCooldown
// 的判斷式是 `(now - last.sentAt) < COOLDOWN_MS`——sentAt 歸零讓這個算式
// 變成 `(now - 0) < COOLDOWN_MS`，對任何現實的 now 恆為 false，等於冷卻
// 機制在每次解鎖後直接失能。8/6 CSV 查出 ADAUSDT/ZECUSDT 在 40 筆訊號裡
// 各出現 10 次/7 次，時間間隔集中在解鎖後幾乎立刻重發。改成保留原本的
// sentAt，讓 COOLDOWN_MS 真正管得到「解鎖後多快可以再發」。
async function unlockSymbol(symbol: string): Promise<void> {
  const r = getRedis();
  if (r) {
    try {
      const entry = await r.get<LockEntry>(`tlock:${symbol}`);
      if (entry) await r.set(`tlock:${symbol}`, { ...entry, locked: false }, { ex: LOCK_TTL_SEC });
      return;
    } catch { /* fall through */ }
  }
  const entry = memLock.get(symbol);
  if (entry) memLock.set(symbol, { ...entry, locked: false });
}

// ── Pending signals for client auto-journal pickup ────────────
// Best-effort in-memory; client also picks up via client-side 30s detect.
const pendingSignals: TradingSignal[] = [];

// ── Dynamic coin list (1h cache) ──────────────────────────────
// 只在幣安 API 掛掉時才用到。因為是寫死的清單，會隨著幣種下架/改名而爛掉，
// 而且爛掉時**完全沒有徵兆**——fallback 平常不會執行，等到真的執行那天才
// 每輪對著不存在的 symbol 404。2026-08-22 對 exchangeInfo 逐一驗證時抓到
// MATICUSDT 已經不存在（Polygon 改名 POL，幣安下架該合約），換成 BCHUSDT
// （老幣、當時 24h 量 387M、被改名下架的機率遠低於中小幣）。
// 直接的後繼者 POLUSDT 雖然還在，但量只有 52M，不適合放進「大幣保底」清單。
const FALLBACK_COINS = [
  'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT',
  'DOGEUSDT','ADAUSDT','AVAXUSDT','DOTUSDT','LINKUSDT',
  'LTCUSDT','UNIUSDT','ATOMUSDT','NEARUSDT','BCHUSDT',
];
let cachedCoins: string[] = [];
let cachedAt              = 0;
const COINS_TTL           = 60 * 60 * 1000;

async function getDefaultCoins(): Promise<string[]> {
  if (Date.now() - cachedAt < COINS_TTL && cachedCoins.length > 0) return cachedCoins;
  try {
    // Spec §2.1 = top 20 by volume. Was cut to 15 for CPU, restored to 20 after
    // 2026-07-18 indicator optimizations. 2026-07-26: Vercel Fluid Active CPU
    // exceeded the Hobby free quota (4h38s/4h) — external cron frequency (every
    // 5min) isn't controllable from app code, so coin count is the lever. Cut
    // back to 15 (user's explicit choice over trimming timeframes/cron interval/
    // upgrading). Revisit if CPU headroom returns.
    cachedCoins = await fetchTopCoinsByVolume(15);
    cachedAt    = Date.now();
    return cachedCoins;
  } catch {
    return FALLBACK_COINS;
  }
}

function current4hBucket(): number {
  return Math.floor(Date.now() / (4 * 60 * 60 * 1000)) * (4 * 60 * 60 * 1000);
}

function fmtPrice(p: number): string {
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1)    return p.toFixed(4);
  return p.toFixed(6);
}

function checkAuth(req: NextRequest): boolean {
  const envSecret  = process.env.WEBHOOK_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  const cronAuth   = req.headers.get('authorization');
  // Vercel cron — must have CRON_SECRET set
  const isVercelCron = !!(cronSecret && cronAuth === `Bearer ${cronSecret}`);
  if (isVercelCron) return true;
  // No WEBHOOK_SECRET configured: fail-open only outside production (local dev/preview
  // convenience). On production this must fail-closed — an unset secret must never mean
  // "anyone may call this," since this route writes trades/notifications (待修改事項.md P2-1).
  if (!envSecret) return process.env.VERCEL_ENV !== 'production';
  // Accept secret from header (preferred) or legacy query param
  const provided = req.headers.get('x-webhook-secret') ?? req.nextUrl.searchParams.get('secret');
  return provided === envSecret;
}

// 2026-08-11：DELETE（清 tlock/風控狀態）原本只認 checkAuth 的 webhook
// secret——正式站從沒設定過 WEBHOOK_SECRET，production 下 fail-closed，
// 這支端點變成完全打不到，連使用者自己想清一個卡住的鎖都沒有路徑可走。
// 跟 /api/reject-funnel、/api/score-attribution 同一套模式：帶已登入
// 使用者的 Supabase JWT 也放行，不用另外管理一組 secret。只給 DELETE
// 用（清鎖是低風險的清理操作，跟 GET/POST 那些會真的下單/insert trade
// 的路徑不同，不動 checkAuth 本體，避免影響 cron 呼叫）。
async function checkUserSession(req: NextRequest): Promise<boolean> {
  const authHeader = req.headers.get('authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return false;
  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!anonUrl || !anonKey) return false;
  const { createClient } = await import('@supabase/supabase-js');
  const userClient = createClient(anonUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: { user }, error } = await userClient.auth.getUser();
  return !error && !!user;
}

// ── Server-side monitor: fill detection + TP/SL via K-line scan ──
// Uses 1h candlestick high/low so events between cron runs are never missed.
async function monitorActiveTrades(profileId: string, muteCancelPush: boolean) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL  || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return { monitored: 0, closed: 0, filled: 0, cancelled: 0 };

  // Distributed mutex: prevents overlapping runs when cron fires concurrently.
  // TTL=55s expires safely before the next 1-minute cron tick; explicit del
  // at the end releases it early so a fast run doesn't block the next cycle.
  const rLock = getRedis();
  if (rLock) {
    try {
      const acquired = await rLock.set('monitor-run-lock', 1, { nx: true, ex: 55 });
      if (!acquired) return { monitored: 0, closed: 0, filled: 0, cancelled: 0 };
    } catch { /* Redis unavailable — proceed without lock */ }
  }

  const { createClient } = await import('@supabase/supabase-js');
  const admin = createClient(url, key);

  // 2026-08-09：live-runner 出現後，DB 模擬監控（這支）跟真倉自動化
  // （live-runner 的 decideTradeAction）現在有兩條獨立路徑會寫同一批
  // trades——實測 MMTUSDT 撞到：這支的 K 線模擬一直把它判定「持倉中」，
  // live-runner 接手後在交易所端撞到 -4141（symbol 關閉），把它標記
  // CANCELLED，蓋掉了這支還在維護的模擬狀態，使用者端看到「突然消失、
  // 顯示推薦單失效」。
  //
  // 排除已經開啟 live_trading_enabled 的使用者的所有 trades，不讓這支
  // 再碰它們——一旦交給 live-runner，這支就讓路。
  //
  // 2026-08-10：但 live_trading_enabled=true 只代表「使用者選了 live-runner
  // 模式」，不保證 process 真的還活著——使用者可能把 live-runner 關掉卻
  // 忘記把這個欄位改回 false，這樣兩邊都不會處理這個使用者的 trades，
  // 比他根本沒開自動交易還危險（完全沒有任何東西在監控）。用心跳判斷：
  // live-runner 每輪（15秒）寫一次 Redis key（TTL 90秒，約 6 輪緩衝，
  // 避免單輪延遲被誤判成停止），開關開著但心跳過期就當作 process 已經
  // 停了，這支重新接手這個使用者的 trades。
  const { data: liveUsers, error: liveUsersErr } = await admin.from('profiles').select('id').eq('live_trading_enabled', true);
  if (liveUsersErr) {
    // 42703＝欄位還沒 ALTER TABLE。liveUserIds 留空陣列＝繼續原本全表掃描
    // 的行為，不會讓整個 monitor 掛掉，但這代表排除機制沒生效——loudly log，
    // 不要默默失效讓人以為修好了。
    console.error(`[monitor] 查 live_trading_enabled 失敗（可能欄位還沒 ALTER TABLE）: [${liveUsersErr.code}] ${liveUsersErr.message}`);
  }
  const liveTradingUserIds = (liveUsers ?? []).map((p: { id: string }) => p.id);

  const heartbeatRedis = getRedis();
  const liveUserIds: string[] = [];
  if (liveTradingUserIds.length > 0) {
    if (heartbeatRedis) {
      try {
        const heartbeats = await Promise.all(
          liveTradingUserIds.map((id: string) => heartbeatRedis.get(`live-runner:heartbeat:${id}`)),
        );
        liveTradingUserIds.forEach((id: string, i: number) => {
          if (heartbeats[i] !== null) {
            liveUserIds.push(id);
          } else {
            console.log(`[monitor] userId=${id.slice(0, 8)} live_trading_enabled=true 但心跳已過期，這支重新接手監控`);
          }
        });
      } catch (e) {
        // Redis 查詢失敗：保守起見當作全部「還活著」（維持排除），不要因為
        // Redis 暫時連不上就讓兩邊搶著處理同一批 trades——那樣的風險比
        // 「這一輪繼續信任 live-runner 還在跑」更高。
        console.error(`[monitor] 查心跳失敗，這輪維持排除已知的 live_trading_enabled 使用者: ${String(e).slice(0, 150)}`);
        liveUserIds.push(...liveTradingUserIds);
      }
    } else {
      // Redis 沒設定，沒辦法判斷心跳，同上邏輯：保守維持排除。
      liveUserIds.push(...liveTradingUserIds);
    }
  }

  // ── Fetch waiting and active trades separately ────────────────
  // No user_id filter beyond the live-trading exclusion above: admin (service
  // role) has full table access and should process all open trades EXCEPT
  // those handed off to live-runner. notifyOk (below, per loop) guards against
  // pushing about a stray/legacy row whose user_id doesn't match the resolved
  // profileId.
  // Postgrest-js 的 query builder 沒有共通的「.select 後」型別可以宣告成
  // helper 的參數型別而不整包鴨子定型，直接用 generic 讓 excludeLiveUsers
  // 對 baseQ()／tp1WatchRaw 兩種不同起手式的 query 都能用。
  const excludeLiveUsers = <T extends { not: (col: string, op: string, val: string) => T }>(q: T): T =>
    liveUserIds.length > 0 ? q.not('user_id', 'in', `(${liveUserIds.join(',')})`) : q;

  const baseQ = () => excludeLiveUsers(admin.from('trades').select('*').is('result', null));

  // 2026-07-26: NULL status used to be swept into the ACTIVE net ("status column
  // didn't exist yet" legacy assumption). But a NEW trade can also land with status
  // NULL when the insert's column-fallback strips it (confirmed live on ZEC/HYPE:
  // insert succeeded via the deepest fallback tier, which never writes status at
  // all — the trade's fill was never actually confirmed by anyone). Treating that
  // as "active" let Phase 2 run TP/SL/time-stop against an entry that may never
  // have filled — the wrong failure mode is silent fabricated PnL, not silence.
  // NULL is safer bucketed as WAITING: Phase 1's candle-touch check (below) then
  // either confirms the fill properly (setting filled_at for the first time, which
  // also self-heals genuine legacy rows) or leaves it waiting — it never invents
  // a result out of an unconfirmed entry.
  const [
    { data: waitingRaw, error: waitErr },
    { data: activeRaw,  error: activeErr },
    // tp1_hit trades that already have result='WIN_TP1' but closed_at is still null
    // (closed_at null = "still watching for TP2"; set to now when trade is finally done)
    { data: tp1WatchRaw },
  ] = await Promise.all([
    baseQ().or('status.eq.waiting,status.is.null'),
    baseQ().or('status.eq.active,status.eq.tp1_hit'),
    excludeLiveUsers(admin.from('trades').select('*')
      .eq('status', 'tp1_hit').eq('result', 'WIN_TP1').is('closed_at', null)),
  ]);

  if (waitErr)  console.error('[monitor] waiting query error:', waitErr.message);
  if (activeErr) console.error('[monitor] active query error:',  activeErr.message);

  const waiting = (waitingRaw ?? []) as any[];
  // Merge active + tp1-watching; deduplicate by id (a newly-set tp1_hit might appear in both)
  const seenIds = new Set<string>();
  const active: any[] = [];
  for (const t of [...(activeRaw ?? []), ...(tp1WatchRaw ?? [])]) {
    if (!seenIds.has(t.id as string)) { seenIds.add(t.id as string); active.push(t); }
  }

  if (waiting.length === 0 && active.length === 0) {
    return { monitored: 0, closed: 0, filled: 0, cancelled: 0 };
  }

  const now = Date.now();
  let filled = 0, cancelled = 0, closed = 0;
  // 時間止損影子模擬新開的追蹤（docs/TODO.md P1 #1）——Phase 2 關單時累積，
  // 函式結尾一次 flush 進 Redis。
  const timeStopShadowStarts: TimeStopShadow[] = [];
  // 推薦單失效影子模擬新開的追蹤（docs/TODO.md 2026-08-01 策略檢討）——
  // Phase 1 掛單被取消時累積，函式結尾一次 flush 進 Redis。
  const cancelShadowStarts: CancelShadow[] = [];

  // ── Duplicate cleanup: a symbol should have at most ONE open trade ──────────
  // A stale WAITING limit order alongside a filled ACTIVE/TP1 trade for the same
  // symbol is a duplicate (a race let two inserts through). It causes the exact
  // symptoms reported: the extra copy shows "持倉中" prematurely, and the monitor
  // fires a fill notification for one copy and a stop/breakeven for the other
  // back-to-back. Delete the stale waiting duplicate so only the real trade runs.
  {
    const activeSymbols = new Set(active.map(t => t.symbol as string));
    const staleWaiting = waiting.filter(t => activeSymbols.has(t.symbol as string));
    if (staleWaiting.length > 0) {
      const ids = staleWaiting.map(t => t.id as string);
      try { await admin.from('trades').delete().in('id', ids); } catch { /* best effort */ }
      for (const t of staleWaiting) {
        console.log(`[monitor] deleted stale waiting duplicate ${t.id} (${t.symbol} already has an active trade)`);
      }
      // Remove them from this run's waiting set so they aren't processed/notified.
      const staleIds = new Set(ids);
      for (let i = waiting.length - 1; i >= 0; i--) {
        if (staleIds.has(waiting[i].id as string)) waiting.splice(i, 1);
      }
    }
    if (waiting.length === 0 && active.length === 0) {
      if (rLock) { try { await rLock.del('monitor-run-lock'); } catch { /* best-effort */ } }
      return { monitored: 0, closed: 0, filled: 0, cancelled: 0 };
    }
  }

  // Update last_monitored_at after each check so the next run only fetches new candles.
  // 42703 = column not yet migrated → skip silently (non-critical optimisation).
  async function touchMonitoredAt(id: string) {
    const r = await admin.from('trades').update({ last_monitored_at: now }).eq('id', id);
    if (r.error && r.error.code !== '42703') { /* non-critical */ }
  }

  // ── Phase 1: fill detection for waiting (limit) orders ───────
  for (const trade of waiting) {
    // baseQ() intentionally has no user_id filter (service role scans every open trade
    // regardless of owner — see comment above). A row whose user_id is a stray/legacy
    // value that doesn't match the resolved profileId must still be MONITORED (fill/
    // cancel logic below always runs), but must not push a notification about someone
    // else's — or an orphaned — trade to this profileId. LINE is unaffected: there's
    // only one linked LINE account regardless of which row triggered the message.
    const notifyOk = !trade.user_id || trade.user_id === profileId;

    // Retreat one candle-width (1h) so the candle that was already open at order-placement time
    // is always included — the Binance startTime filter uses openTime, which can be earlier than
    // the exact placement timestamp.
    const rawStart1 = (trade.last_monitored_at ?? trade.opened_at ?? (now - WAITING_EXPIRY_HOURS * 3_600_000)) as number;
    const startMs   = rawStart1 - 3_600_000;

    let candles: Candle[] = [];
    try {
      // limit=168 covers up to 7 days of 1h bars (safety net for first run before last_monitored_at is set)
      candles = await fetchCandles(trade.symbol as string, '1h', 168, 3, startMs);
    } catch {
      await delay(200);
      continue;
    }
    await delay(200); // stagger per-trade fetches to avoid Binance 429

    const isLong = trade.direction === 'LONG';
    const sp     = (trade.signal_price ?? 0) as number;
    const entry  = trade.entry as number;
    const slPx   = trade.stop_loss as number;
    const risk   = Math.abs(entry - slPx);

    // ── 時間錨（修正「掛單沒成交就說已達 +0.5R」）──────────────────
    // 抓 K 線時往前退了 1 小時（覆蓋掛單當下那根），但成交/失效判定絕不能
    // 用「掛單之前」的歷史價格 —— 否則掛單前價格剛好碰到進場價會被誤判成交，
    // 接著那段歷史又漲過 +0.5R，整個生命週期在使用者反應前就跑完。
    // 只採計「開盤時間 ≥ 掛單時間」的 K 線（完全發生在掛單之後）。
    const placedAt   = (trade.opened_at ?? 0) as number;
    const evalCandles = candles.filter(c => c.openTime >= placedAt);

    // ── 時序掃描：成交（影線觸及）vs 掛單失效（收盤確認），先到先贏 ──
    // spec §3-A：掛單期間若進場前提失效須立即取消，不是傻等逾期。
    // 失效三型（皆用收盤價確認，符合規格「收盤確認」精神）：
    //   1. 結構突破：收盤越過止損位 —— 進場理由（FVG/支撐/阻力）已被有效突破
    //   2. 行情走遠：未回測就朝目標方向走了 ≥1R —— 回到進場位的機率大減，不追
    //   3. TP1 直達：連 TP1 都到了還沒成交（外圈保險，通常第 2 條先觸發）
    let fillCandle: Candle | null = null;
    let cancelReason: string | null = null; // 完整訊息（LINE / 詳細）
    let cancelBody: string | null = null;   // 短訊息（push body）
    // v2.4 §1.1: 取消原因分兩類，反向權限完全不同
    //   opportunity_expired（機會過期）：方向仍成立，只是沒等到進場 → 保留 bias、禁反向
    //   thesis_invalidated（論點失效）：進場理由被推翻 → 不保留 bias、反向照冷卻規則
    let cancelClass: 'opportunity_expired' | 'thesis_invalidated' | null = null;
    // Finer-grained than cancelClass — feeds the exported report's close_reason column
    // so "行情走遠" and "逾期未成交" (both opportunity_expired) can be told apart.
    let cancelReasonKey: 'cancel_thesis_invalidated' | 'cancel_ran_away' | 'cancel_tp1_direct' | 'cancel_expired' | null = null;
    for (const c of evalCandles) {
      const touched = isLong
        ? c.low  <= entry * 1.001 && (sp === 0 || sp > entry * 1.002)
        : c.high >= entry * 0.999 && (sp === 0 || sp < entry * 0.998);
      if (touched) { fillCandle = c; break; }

      if (isLong ? c.close <= slPx : c.close >= slPx) {
        cancelReason = `價格收盤${isLong ? '跌破' : '突破'}止損位 $${fmtPrice(slPx)}，進場前提已失效，掛單取消`;
        cancelBody   = '結構已突破，setup 失效';
        cancelClass  = 'thesis_invalidated'; // 論點失效 → 反向可依冷卻規則
        cancelReasonKey = 'cancel_thesis_invalidated';
        break;
      }
      // 行情走遠：自掛單當下（signal_price）朝獲利方向走了 ≥1R —— 回不到進場位。
      // 必須錨定 sp（下單當下價），不能用 entry±risk：回調/反彈單的 entry±risk
      // 剛好落在下單價附近，會讓掛單一放上去就被誤判走遠而秒取消。
      if (sp > 0 && risk > 0 && (isLong ? c.close >= sp + risk : c.close <= sp - risk)) {
        cancelReason = `價格自掛單當下 $${fmtPrice(sp)} 已朝${isLong ? '上' : '下'}走了 1R 以上，未回測進場位 $${fmtPrice(entry)}，回測機率大減 —— 放棄追進`;
        cancelBody   = '行情已走遠，不追單';
        cancelClass  = 'opportunity_expired'; // 方向對、只是沒進到 → 保留 bias、禁反向
        cancelReasonKey = 'cancel_ran_away';
        break;
      }
      if (isLong ? c.high >= (trade.tp1 as number) : c.low <= (trade.tp1 as number)) {
        cancelReason = `價格未回測至進場位 $${fmtPrice(entry)}，直接到達 TP1 $${fmtPrice(trade.tp1 as number)}，掛單已自動取消`;
        cancelBody   = 'TP1 直接到達，跳過進場';
        cancelClass  = 'opportunity_expired'; // 方向對到都到 TP1 了 → 保留 bias、禁反向
        cancelReasonKey = 'cancel_tp1_direct';
        break;
      }
    }
    const isFilled = !!fillCandle;

    // spec §3-A：掛單有效期最多 4 根（該時框）K 線
    const expiryMs  = WAITING_EXPIRY_BARS * tfBarMinutes(trade.timeframe as string | null) * 60_000;
    const isExpired = (now - ((trade.opened_at ?? 0) as number)) > expiryMs;
    if (!isFilled && !cancelReason && isExpired) {
      cancelReason = `掛單超過 ${WAITING_EXPIRY_BARS} 根 ${trade.timeframe ?? '1h'} K 線未成交，已自動取消（規格 §3-A）`;
      cancelBody   = `逾期 ${WAITING_EXPIRY_BARS} 根 K 線未成交`;
      cancelClass  = 'opportunity_expired'; // C1 超時 → 保留 bias、禁反向（v2.4 §1.1 紅線）
      cancelReasonKey = 'cancel_expired';
    }
    const isCancelled = !isFilled && cancelReason !== null;

    if (isFilled) {
      const filledAt = fillCandle!.closeTime ?? now;
      // Atomic fill: matches status='waiting' OR NULL (NULL rows are routed into this
      // same waiting pool above) so only the cron that transitions actually sends the
      // notification; concurrent cron — or a second pass over an already-transitioned
      // row — gets 0 rows back. A plain .eq('status','waiting') would never match a
      // NULL row (Postgres NULL never equals anything), leaving it stuck re-detecting
      // "filled" forever without the write ever landing.
      const fillRes  = await admin.from('trades')
        .update({ status: 'active', filled_at: filledAt, last_monitored_at: now })
        .eq('id', trade.id).or('status.eq.waiting,status.is.null').select('id');

      let fillWriteOk = !fillRes.error && (fillRes.data?.length ?? 0) > 0;
      if (fillRes.error) {
        if (fillRes.error.code === '42703') {
          // Legacy schema missing filled_at/last_monitored_at columns — write status only.
          // Previously this also wrote opened_at:filledAt to smuggle a fill timestamp into
          // a legacy row, but opened_at is the time-anchor every age-based decision (24h/
          // 72h/168h auto-close, time-stop, Phase 1's evalCandles filter) is computed from —
          // silently moving it forward corrupted every one of those for this trade's whole
          // remaining lifetime. Losing the precise fill timestamp on this legacy-only path
          // is the acceptable trade-off (Phase 2 already falls back to opened_at when
          // filled_at is absent, same as before).
          const fb = await admin.from('trades').update({ status: 'active' })
            .eq('id', trade.id).or('status.eq.waiting,status.is.null').select('id');
          if (fb.error) {
            console.error(`[monitor] fill write failed ${trade.id}: [${fb.error.code}] ${fb.error.message}`);
            await touchMonitoredAt(trade.id as string);
          } else {
            fillWriteOk = (fb.data?.length ?? 0) > 0;
          }
        } else {
          console.error(`[monitor] fill write failed ${trade.id}: [${fillRes.error.code}] ${fillRes.error.message}`);
          await touchMonitoredAt(trade.id as string);
        }
      }

      // Notify only after DB confirms status='active' — prevents repeat on next cron if write failed
      if (fillWriteOk) {
        filled++;
        const dir = isLong ? '▲ 做多' : '▼ 做空';
        const sym = (trade.symbol as string).replace('USDT', '/USDT');
        if (profileId && notifyOk) {
          await sendWebPushToUser(profileId, {
            title: `✅ 掛單成交 ${sym}`,
            body: `${dir} 成交價 $${fmtPrice(fillCandle!.close)} ｜ TP1 $${fmtPrice(trade.tp1 as number)} ｜ SL $${fmtPrice(trade.stop_loss as number)}`,
            tag: `fill-${trade.id}`,
          });
        }
      }
    } else if (isCancelled) {
      // Soft-cancel: keep the row (status='cancelled', result='CANCELLED', closed_at=now)
      // instead of DELETE. A hard delete left zero trace of "this recommendation never
      // got filled" — the reject funnel only records signals that never became a trade,
      // a different population from a limit order that WAS placed and then expired
      // (待修改事項.md P1 #0b). result='CANCELLED' reuses the exact client finalize
      // pipeline a real close already goes through (resolveServerOutcome/applyServerOutcome
      // in tradeSync.ts/StoreHydration.tsx) — no new client sync path needed. Setting
      // closed_at also drops the row out of checkSameDirectionRisk's `closed_at IS NULL`
      // count, same as DELETE used to.
      //
      // Atomic guard matches the fill-write above: only the cron that actually
      // transitions the row gets rows back from .select('id').
      let cancelRes = await admin.from('trades')
        .update({ status: 'cancelled', result: 'CANCELLED', closed_at: now, close_reason: cancelReasonKey })
        .eq('id', trade.id).or('status.eq.waiting,status.is.null').select('id');

      if (cancelRes.error?.code === '42703') {
        // close_reason not migrated yet — retry without it before falling all the way
        // back to DELETE. Logged loudly: this means the ALTER TABLE hasn't been run.
        console.error(`[monitor] close_reason column missing for ${trade.id} — cancelling without it. Run: ALTER TABLE trades ADD COLUMN IF NOT EXISTS close_reason TEXT;`);
        cancelRes = await admin.from('trades')
          .update({ status: 'cancelled', result: 'CANCELLED', closed_at: now })
          .eq('id', trade.id).or('status.eq.waiting,status.is.null').select('id');
      }

      if (cancelRes.error) {
        // Unknown schema constraint rejected the new 'CANCELLED' value (e.g. a CHECK
        // on `result` that's never seen a 5th literal) — fall back to the old hard
        // DELETE so this never regresses into a stuck row, but log loudly since this
        // path being hit means the soft-cancel isn't actually landing in the DB.
        console.error(`[monitor] soft-cancel failed ${trade.id}, falling back to delete: [${cancelRes.error.code}] ${cancelRes.error.message}`);
        cancelRes = await admin.from('trades').delete().eq('id', trade.id).select('id');
      }

      const { data: delData, error: delErr } = cancelRes;
      if (delErr) {
        // Write failed — don't notify; next cron will retry
        console.error(`[monitor] cancel write failed ${trade.id}: [${delErr.code}] ${delErr.message}`);
        await touchMonitoredAt(trade.id as string);
      } else if (!delData || delData.length === 0) {
        // Row already transitioned by a concurrent cron — skip notification
        console.log(`[monitor] cancel skipped ${trade.id} — row already gone`);
      } else {
        await unlockSymbol(trade.symbol as string);
        cancelled++;
        // v2.4 §1.2: opportunity-expired cancels hold the direction bias for 12
        // bars so a reverse order can't fire straight after (the red line). A
        // thesis-invalidated cancel (structure broke) sets no hold.
        if (cancelClass === 'opportunity_expired') {
          const holdSec = BIAS_HOLD_BARS * tfBarMinutes(trade.timeframe as string | null) * 60;
          await setBiasHold(trade.symbol as string, trade.direction as string, holdSec);
        }
        // 推薦單失效影子模擬（docs/TODO.md 2026-08-01）：模擬「當下用訊號價
        // sp 市價進場」會怎樣，回答「等回調的設計是不是白白錯過這類單」。
        // 沒有 sp（舊資料缺 signal_price 欄位）就跳過——沒有假設進場價可模擬。
        if (sp > 0 && cancelReasonKey) {
          cancelShadowStarts.push(startCancelShadow({
            id:                trade.id as string,
            symbol:            trade.symbol as string,
            direction:         trade.direction as 'LONG' | 'SHORT',
            timeframe:         trade.timeframe as string,
            hypotheticalEntry: sp,
            stopLoss:          slPx,
            tp1:               trade.tp1 as number,
            tp2:               trade.tp2 as number,
            trigger:           cancelReasonKey,
            cancelledAt:       now,
          }));
        }
        // Notify only after the write is confirmed to have landed — prevents repeat if it had failed.
        // cancelReason/cancelBody were set during the chronological scan above.
        // muteCancelPush (settings toggle) only suppresses the notification — funnel
        // counter (cancelled++) and bias-hold above still run either way (待修改事項.md P0-2).
        if (!muteCancelPush) {
          const dir = isLong ? '▲ 做多' : '▼ 做空';
          const sym = (trade.symbol as string).replace('USDT', '/USDT');
          // v2.4 §1.3: wording made explicit that this is the system's own paper order
          // expiring, not a real position — the original "⚠️ 掛單取消" phrasing read as
          // an alarm about something the user did, when it's actually routine cleanup
          // of a recommendation that never got filled (待修改事項.md P0-2 選項 A).
          if (profileId && notifyOk) {
            await sendWebPushToUser(profileId, {
              title: `推薦單失效 ${sym}`,
              body: `${dir} ${cancelBody ?? '未進場，掛單已取消'}（非持倉）`,
              tag: `cancel-${trade.id}`,
            });
          }
        }
      }
    } else {
      // No state change — record we've checked up to now so next run fetches only new candles
      await touchMonitoredAt(trade.id as string);
    }
  }

  // ── Phase 2: TP/SL monitoring + timeframe-aware auto-close ───
  for (const trade of active) {
    // See Phase 1's notifyOk comment — same guard, this loop has its own `trade`.
    const notifyOk = !trade.user_id || trade.user_id === profileId;

    // Retreat one 1h candle-width so the candle open at fill/creation time is always covered.
    const rawStart2 = (trade.last_monitored_at ?? trade.filled_at ?? trade.opened_at ?? (now - 168 * 3_600_000)) as number;
    const startMs   = rawStart2 - 3_600_000;

    let candles: Candle[] = [];
    try {
      candles = await fetchCandles(trade.symbol as string, '1h', 168, 3, startMs);
    } catch {
      await delay(200);
      continue;
    }
    await delay(200);

    const isLong        = trade.direction === 'LONG';
    const isTp1Hit      = trade.status === 'tp1_hit';
    const tradeStrategy = (trade.strategy as string | null) ?? '';

    // ── Protective stop state (v2.4 §2: unified ladder + trailing) ───────────
    // current_stop persists ONE protective stop across scans:
    //   pre-TP1  → profit ladder (+0.5R→breakeven, +1.0R→+0.3R)
    //   post-TP1 → 2×ATR trailing
    // Loaded regardless of the active flag so the pre-TP1 ladder also persists.
    // A non-zero protective stop is the irreversible "reached +0.5R" mark that
    // permanently disables the time stop for this trade.
    const savedTrailingStop = (trade.current_stop as number | null) ?? 0;
    let trailingStop        = savedTrailingStop > 0 ? savedTrailingStop : 0;
    let trailingStopUpdated = false;
    let hitTrailingStop     = false;  // post-TP1 trailing exit (WIN_TP1)
    let hitPreTp1Breakeven  = false;  // 2026-08-13: pre-TP1 breakeven stop exit (see PRE_TP1_BREAKEVEN_TRIGGER_R)
    let autoClosedAfterTp1  = false;  // 24h/72h/168h timeout fired after TP1 (floor-clamped)
    const riskDist          = Math.abs((trade.entry as number) - (trade.stop_loss as number));

    // Simple 14-period ATR from 1H candles — used to set/ratchet trailing stop.
    // Only computed for Strategy A trades; Strategy B uses fixed TP=BB middle (no trailing).
    //
    // 2026-08-04 P0 fix（docs/ANALYSIS-2026-08-04-移動止損失效與策略數據檢討.md）：
    // MUST come from a separately-fetched, full-length window — NOT from `candles`
    // above. `candles` is fetched incrementally (only bars since last_monitored_at,
    // this loop runs every 5 min so it's usually 1-2 bars), so the old
    // `candles.length >= 15` guard was silently false on every single scan and
    // atr1h was permanently 0. Trailing stop was therefore NEVER initialized —
    // TP1-hit trades rode all the way back down to the original stop loss instead
    // (confirmed live: zero "🛡 移動止損上移" pushes ever sent, current_stop always
    // NULL). fetchCandlesCached keeps its own full window and only re-fetches the
    // tail each call, so this doesn't cost a full 20-bar transfer every scan.
    let atr1h = 0;
    if (tradeStrategy === 'A') {
      try {
        const atrCandles = await fetchCandlesCached(trade.symbol as string, '1h', 20);
        atr1h = calcSimpleAtr(atrCandles, 14);
        if (atr1h === 0) {
          console.error(`[monitor] atr1h still 0 for ${trade.id} (${trade.symbol}) after fetching ${atrCandles.length} 1h candles — trailing stop cannot initialize this scan`);
        }
      } catch (e) {
        console.error(`[monitor] atr1h fetch failed ${trade.id} (${trade.symbol}):`, String(e).slice(0, 150));
      }
    }

    // Pre-loop: initialize trailing stop for existing tp1_hit trades that pre-date the columns.
    // When isTp1Hit=true but no current_stop is stored (columns newly migrated or first run),
    // seed from TP1 price (floored at breakeven) so the ratchet loop has a valid anchor.
    if (isTp1Hit && tradeStrategy === 'A' && atr1h > 0 && trailingStop === 0) {
      trailingStop = isLong
        ? Math.max((trade.tp1 as number) - 2 * atr1h, (trade.entry as number))
        : Math.min((trade.tp1 as number) + 2 * atr1h, (trade.entry as number));
      trailingStopUpdated = true;
    }

    let closeResult: string | null = null;
    let closePrice  = 0;
    let justHitTp1  = false;
    // localTp1Hit tracks TP1 across this scan (DB state + any new hit found in candles)
    let localTp1Hit = isTp1Hit;

    // 時間錨（同 Phase 1 修正）：TP/SL/利潤階梯只採計「成交之後開盤」的 K 線。
    // 否則成交前的歷史價格會被算進最大有利波幅（maxR），讓一筆剛成交的單
    // 立刻被誤判「曾達 +0.5R」而觸發保本/移動止損通知。ATR 用全部 K 線無妨。
    const fillAnchor  = (trade.filled_at ?? trade.opened_at ?? 0) as number;
    const evalCandles = candles.filter(c => c.openTime >= fillAnchor);

    // MFE/MAE (2026-07-30 strategy review): the trade log only ever recorded the
    // exit price, so a trade that ran to +1.8R before reversing to a +0.2R time
    // stop was indistinguishable from one that only ever reached +0.3R — opposite
    // problems (TP1 too far away vs. the entry/thesis genuinely not working)
    // needing opposite fixes. Independent of the close-detection logic below on
    // purpose: this is monotonic (only ever extends, never retreats) and passive
    // measurement, not a trading decision, so it doesn't need to share the close
    // paths' atomic write guards. Runs off the same evalCandles already fetched
    // for the TP/SL walk — no extra candle fetch.
    if (evalCandles.length > 0) {
      try {
        const priorMfe = (trade.mfe_price as number | null) ?? null;
        const priorMae = (trade.mae_price as number | null) ?? null;
        const mm = updateMfeMae(evalCandles, isLong, priorMfe, priorMae);
        if (mm.changed) {
          await admin.from('trades')
            .update({ mfe_price: mm.mfePrice, mae_price: mm.maePrice })
            .eq('id', trade.id);
        }
      } catch (e) {
        // 42703 (column not migrated) or any other error — MFE/MAE is pure
        // analytics, must never block the real TP/SL monitoring below.
        console.error(`[monitor] mfe/mae update failed ${trade.id}:`, String(e).slice(0, 150));
      }
    }

    // Scan candles in chronological order.
    // Check order within each candle: TP1 first, then TP2, then trailing stop, then SL.
    // Same-candle TP1+SL → TP1 wins (price hit TP1 before reversing to SL).
    // Same-candle TP1+trailing stop → trailing stop fires (TP2 not reached, trailing is lower bound).
    for (const c of evalCandles) {
      let justInitializedTrailing = false; // per-iteration flag: skip ratchet on init candle

      if (isLong) {
        if (!localTp1Hit && c.high >= (trade.tp1 as number)) {
          localTp1Hit = true; justHitTp1 = true;
          // Initialize trailing stop 2×ATR below TP1 level (Strategy A only).
          // 2026-08-13: dropped the old `trailingStop === 0` guard here — now that
          // pre-TP1 breakeven (below) can leave trailingStop sitting at entry before
          // TP1 fires, this must unconditionally recompute to the proper post-TP1
          // floor. Math.max(...) already floors at entry either way, so recomputing
          // is always safe (never moves the stop backward).
          if (tradeStrategy === 'A' && atr1h > 0) {
            // Floor at breakeven (entry): after TP1 the exit is never worse than 0R.
            // (2026-07-24: was clamped to the original SL, which let a TP1-tagged trade
            // give back all the way to −1R when 2×ATR exceeded the entry→TP1 distance.)
            trailingStop = Math.max((trade.tp1 as number) - 2 * atr1h, (trade.entry as number));
            trailingStopUpdated = true;
            justInitializedTrailing = true;
          }
        }
        // 2026-08-13（策略修改.md 修改1）：pre-TP1 breakeven arm — reuses the same
        // trailingStop/current_stop slot the post-TP1 mechanism already persists
        // across scans (see the "v2.4 §2" comment above), just for the phase before
        // TP1. Single-stage only (not the multi-level ladder removed 2026-07-21):
        // once armed it never re-arms or moves again until TP1 hands it off to the
        // ratchet above. Gated on !localTp1Hit so it can never fire on the same
        // candle TP1 already hit (that branch already set trailingStop itself).
        if (!localTp1Hit && trailingStop === 0 && tradeStrategy === 'A' && riskDist > 0
            && c.high >= (trade.entry as number) + PRE_TP1_BREAKEVEN_TRIGGER_R * riskDist) {
          trailingStop = trade.entry as number;
          trailingStopUpdated = true;
        }
        if (c.high >= (trade.tp2 as number)) {
          closeResult = 'WIN_TP2'; closePrice = trade.tp2 as number; break;
        }
        // Trailing stop fires before original SL — ONLY active after TP1 (2026-07-21:
        // the pre-TP1 profit ladder was removed; the stop stays at the original SL
        // until TP1 is reached, unless the pre-TP1 breakeven arm above has fired).
        if (localTp1Hit && trailingStop > 0 && c.low <= trailingStop) {
          closeResult = 'WIN_TP1'; closePrice = applyStopSlippage(trailingStop, true); hitTrailingStop = true; break;
        }
        if (!localTp1Hit && trailingStop > 0) {
          // Pre-TP1 breakeven armed — this is now the effective stop, original SL
          // is superseded (price would have to cross back through breakeven first).
          if (c.low <= trailingStop) {
            closeResult = 'MANUAL_CLOSE';
            closePrice  = applyStopSlippage(trailingStop, true);
            hitPreTp1Breakeven = true;
            break;
          }
        } else if (c.low <= (trade.stop_loss as number)) {
          closeResult = localTp1Hit ? 'WIN_TP1' : 'LOSS';
          closePrice  = applyStopSlippage(trade.stop_loss as number, true);
          break;
        }
        // Post-TP1: ratchet trailing stop upward via 2×ATR (not on the init candle)
        if (localTp1Hit && !justInitializedTrailing && tradeStrategy === 'A' && atr1h > 0) {
          const candidate = c.close - 2 * atr1h;
          if (candidate > trailingStop) { trailingStop = candidate; trailingStopUpdated = true; }
        }
      } else {
        if (!localTp1Hit && c.low <= (trade.tp1 as number)) {
          localTp1Hit = true; justHitTp1 = true;
          if (tradeStrategy === 'A' && atr1h > 0) {
            // Floor at breakeven (entry) — SHORT mirror; never worse than 0R after TP1.
            trailingStop = Math.min((trade.tp1 as number) + 2 * atr1h, (trade.entry as number));
            trailingStopUpdated = true;
            justInitializedTrailing = true;
          }
        }
        // Pre-TP1 breakeven arm — SHORT mirror (favorable move is price falling).
        if (!localTp1Hit && trailingStop === 0 && tradeStrategy === 'A' && riskDist > 0
            && c.low <= (trade.entry as number) - PRE_TP1_BREAKEVEN_TRIGGER_R * riskDist) {
          trailingStop = trade.entry as number;
          trailingStopUpdated = true;
        }
        if (c.low <= (trade.tp2 as number)) {
          closeResult = 'WIN_TP2'; closePrice = trade.tp2 as number; break;
        }
        // Trailing stop (SHORT: stop is ABOVE, hit when high >= stop) — ONLY after TP1.
        if (localTp1Hit && trailingStop > 0 && c.high >= trailingStop) {
          closeResult = 'WIN_TP1'; closePrice = applyStopSlippage(trailingStop, false); hitTrailingStop = true; break;
        }
        if (!localTp1Hit && trailingStop > 0) {
          if (c.high >= trailingStop) {
            closeResult = 'MANUAL_CLOSE';
            closePrice  = applyStopSlippage(trailingStop, false);
            hitPreTp1Breakeven = true;
            break;
          }
        } else if (c.high >= (trade.stop_loss as number)) {
          closeResult = localTp1Hit ? 'WIN_TP1' : 'LOSS';
          closePrice  = applyStopSlippage(trade.stop_loss as number, false);
          break;
        }
        // Post-TP1: ratchet trailing stop downward via 2×ATR (SHORT)
        if (localTp1Hit && !justInitializedTrailing && tradeStrategy === 'A' && atr1h > 0) {
          const candidate = c.close + 2 * atr1h;
          if (trailingStop === 0 || candidate < trailingStop) { trailingStop = candidate; trailingStopUpdated = true; }
        }
      }
    }

    // Notify when the post-TP1 trailing stop is newly raised (locks in more profit).
    // Only fires on a meaningful upward move (≥0.15R) to avoid per-scan spam; the
    // live stop level is also shown on the position card via /api/trade-status.
    if (!closeResult && !justHitTp1 && localTp1Hit && trailingStopUpdated && trailingStop > 0 && riskDist > 0) {
      const rOf = (stop: number) => (isLong ? stop - (trade.entry as number) : (trade.entry as number) - stop) / riskDist;
      const prevProtR = savedTrailingStop > 0 ? rOf(savedTrailingStop) : -Infinity;
      const newProtR  = rOf(trailingStop);
      if (newProtR > prevProtR + 0.15 && profileId && notifyOk) {
        const dir = isLong ? '▲ 做多' : '▼ 做空';
        const sym = (trade.symbol as string).replace('USDT', '/USDT');
        await sendWebPushToUser(profileId, {
          title: `🛡 ${sym} 移動止損上移`,
          body: `${dir} TP1 已達標，止損上移至 $${fmtPrice(trailingStop)}（鎖 +${newProtR.toFixed(1)}R），續抱等 TP2`,
          tag: `trail-${trade.id}`, // one tag → latest move replaces the previous push
        });
      }
    }

    // Persist trailing stop updates that occurred during the scan but didn't trigger a close.
    // Skipped when justHitTp1=true because the TP1 update block below merges it in.
    // 42703-safe: catching write failures is sufficient (columns missing → touchMonitoredAt).
    if (!closeResult && !justHitTp1 && trailingStopUpdated && trailingStop > 0) {
      try {
        await admin.from('trades')
          .update({ trailing_stop_active: true, current_stop: trailingStop, last_monitored_at: now })
          .eq('id', trade.id);
      } catch {
        // 42703 if trailing_stop_active/current_stop columns not yet migrated — non-critical
        await touchMonitoredAt(trade.id as string);
      }
    }

    // TP1 newly reached in this scan, no close yet → record result immediately and notify
    if (justHitTp1 && !closeResult) {
      const tp1Price = trade.tp1 as number;
      const tp1Pnl   = isLong
        ? ((tp1Price - (trade.entry as number)) / (trade.entry as number)) * 100
        : (((trade.entry as number) - tp1Price) / (trade.entry as number)) * 100;

      // Write result='WIN_TP1' + exit_price + pnl immediately so the trade appears
      // in the journal right away. closed_at is intentionally NOT set here — null
      // closed_at means "TP1 secured, still watching for TP2".
      // The next monitoring cycle fetches status='tp1_hit' AND result='WIN_TP1' AND closed_at IS NULL.
      // Phase 5: merge trailing stop initialization into this update to avoid a separate round-trip.
      const tp1UpdatePayload: Record<string, unknown> = {
        status:            'tp1_hit',
        last_monitored_at: now,
        result:            'WIN_TP1',
        exit_price:        tp1Price,
        pnl_percent:       parseFloat(tp1Pnl.toFixed(2)),
        // closed_at intentionally omitted — null signals "still watching for TP2"
      };
      if (trailingStopUpdated && trailingStop > 0) {
        tp1UpdatePayload.trailing_stop_active = true;
        tp1UpdatePayload.current_stop         = trailingStop;
      }
      const tp1Res = await admin.from('trades')
        .update(tp1UpdatePayload)
        .eq('id', trade.id).or('status.eq.active,status.is.null').select('id');

      let tp1WriteOk = !tp1Res.error && (tp1Res.data?.length ?? 0) > 0;
      if (tp1Res.error) {
        if (tp1Res.error.code === '42703') {
          // Columns (exit_price, pnl_percent) may not exist yet — retry with base fields only
          const fb = await admin.from('trades')
            .update({ status: 'tp1_hit', result: 'WIN_TP1' })
            .eq('id', trade.id).or('status.eq.active,status.is.null').select('id');
          if (fb.error) {
            console.error(`[monitor] tp1_hit write failed ${trade.id}: [${fb.error.code}] ${fb.error.message}`);
          } else {
            tp1WriteOk = (fb.data?.length ?? 0) > 0;
          }
        } else {
          console.error(`[monitor] tp1_hit write failed ${trade.id}: [${tp1Res.error.code}] ${tp1Res.error.message}`);
        }
      }

      // Notify only after status='tp1_hit' is persisted — next cron sees isTp1Hit=true,
      // skips the justHitTp1 branch, preventing repeat notification.
      // If write failed, no push is sent; next cron retries the write.
      if (tp1WriteOk) {
        const dir = isLong ? '▲ 做多' : '▼ 做空';
        const sym = (trade.symbol as string).replace('USDT', '/USDT');
        if (profileId && notifyOk) {
          // 2026-08-04：這裡原本寫死 `trade.entry`，但實際保護價是 trailingStop
          // （= max(tp1 − 2×ATR, entry)，SHORT 鏡像）。7/30 前 atr1h 恆為 0，
          // trailingStop 也恆為 0，寫死 entry 剛好跟事實一致所以沒被發現；
          // 8/4 修好 ATR 之後 trailingStop 常常明顯優於 entry，這則推播就會
          // 低報實際鎖住的利潤。改成顯示真正會被執行的那個價位。
          const protectedStop = trailingStop > 0 ? trailingStop : (trade.entry as number);
          const lockedR = riskDist > 0
            ? (isLong ? protectedStop - (trade.entry as number) : (trade.entry as number) - protectedStop) / riskDist
            : 0;
          // 2026-08-06：帳面（blendTp1PartialPnl）已經把 TP1 當成「平掉
          // TP1_PARTIAL_FRACTION（50%）」在算最終 R，但系統從沒實際下單，
          // 也從沒告訴使用者要手動平那一半——本地/紀錄頁算出來的 R 因此
          // 比使用者真正持有的部位樂觀。這裡明確提示，帳目跟實際操作才對得上。
          const partialPct = Math.round(TP1_PARTIAL_FRACTION * 100);
          await sendWebPushToUser(profileId, {
            title: `🎯 TP1 達標 ${sym}`,
            body: `${dir} $${fmtPrice(trade.tp1 as number)} ｜ 請手動平掉 ${partialPct}% 部位 ｜ 剩餘止損移至 $${fmtPrice(protectedStop)}（鎖 ${lockedR >= 0 ? '+' : ''}${lockedR.toFixed(1)}R）`,
            tag: `tp1-${trade.id}`,
          });
        }
      }
      continue;
    }

    // Timeframe-aware auto-close: use last candle close as exit price (no spot fetch needed)
    const autoCloseHours = trade.timeframe === '4h' ? 72 : trade.timeframe === '1d' ? 168 : INTRADAY_CLOSE_HOURS;
    const ageHours       = (now - ((trade.filled_at ?? trade.opened_at ?? 0) as number)) / 3_600_000;
    const lastClose      = candles.length > 0 ? candles[candles.length - 1].close : null;

    // 時間止損：只清理「未達 TP1 的停滯單」，永不平已達 TP1（獲利管理中）的單。
    //   8 根 K 線後仍在 −0.3R ~ +0.3R 之間震盪 → 建議市價出場（釋放倉位）
    //   已接近止損（< −0.3R）→ 不動，讓原止損決定（不提前認賠）
    //   +0.3R 以上（正在推進）→ 不動，給它走到 TP1 的機會
    let timeStopFired = false;
    if (!closeResult && !localTp1Hit && lastClose !== null && riskDist > 0) {
      const barMinutes = trade.timeframe === '5m' ? 5
        : trade.timeframe === '15m' ? 15
        : trade.timeframe === '4h' ? 240
        : trade.timeframe === '1d' ? 1440
        : 60;
      const ageBars = (now - ((trade.filled_at ?? trade.opened_at ?? 0) as number)) / (barMinutes * 60_000);
      if (ageBars >= 8) {
        const progressR = (isLong
          ? lastClose - (trade.entry as number)
          : (trade.entry as number) - lastClose) / riskDist;
        if (progressR >= -0.3 && progressR <= 0.3) {
          closeResult   = 'MANUAL_CLOSE';
          closePrice    = lastClose;
          timeStopFired = true;
        }
      }
    }

    if (!closeResult && ageHours >= autoCloseHours && lastClose !== null) {
      closeResult = localTp1Hit ? 'WIN_TP1' : 'MANUAL_CLOSE';
      if (localTp1Hit) {
        closePrice = clampAutoCloseAfterTp1(lastClose, trailingStop, trade.entry as number, isLong);
        autoClosedAfterTp1 = true;
      } else {
        closePrice = lastClose;
      }
    }

    if (!closeResult) {
      await touchMonitoredAt(trade.id as string);
      continue;
    }

    const entry = trade.entry as number;
    // 2026-08-05（docs/ANALYSIS-2026-08-05-提升盈虧率的可動項目.md #1）：
    // TP1 部分停利。localTp1Hit（不是 isTp1Hit/isFinalClosingTp1，那個只反映
    // DB 在「這輪掃描開始時」的狀態，用來做並發安全的原子寫入守衛，跟這裡
    // 的「這筆單是否曾經碰到 TP1」是兩件事——TP1/TP2 在同一根K線都被打穿
    // 的情況下 isFinalClosingTp1 會是 false，但 localTp1Hit 依然正確為
    // true）為真時，把最終 R 當成「一半在 TP1 鎖定、一半照最終出場價」
    // 的加權平均，而不是全部用最終出場價算。
    const pnl = localTp1Hit
      ? blendTp1PartialPnl(entry, trade.tp1 as number, closePrice, isLong)
      : (isLong
          ? ((closePrice - entry) / entry) * 100
          : ((entry - closePrice) / entry) * 100);

    // Why this trade ended, distinct from the win/loss result itself — written to a
    // new `close_reason` column so exported reports can group by exit mechanism
    // instead of just tallying wins/losses (docs/TODO.md 報表 work).
    const closeReason = deriveCloseReason({ closeResult: closeResult as string, timeStopFired, autoClosedAfterTp1, hitPreTp1Breakeven });

    // Atomic close guard differs by trade state:
    // - Normal (result null): use .is('result', null) — standard first-write guard.
    // - tp1_hit watching (result='WIN_TP1', closed_at null): use that pair as guard.
    //   For TP2, upgrade result to WIN_TP2. For SL/auto, keep result (stays WIN_TP1),
    //   just set closed_at + final exit_price/pnl to finalize the record.
    const isFinalClosingTp1 = isTp1Hit; // tp1_hit trade reaching its final outcome
    const closeUpdate = isFinalClosingTp1
      ? {
          // Only change result if upgrading to TP2; otherwise leave WIN_TP1 as-is
          ...(closeResult === 'WIN_TP2' ? { result: 'WIN_TP2' } : {}),
          exit_price:   closePrice,
          closed_at:    now,
          pnl_percent:  parseFloat(pnl.toFixed(2)),
          close_reason: closeReason,
        }
      : {
          result:       closeResult,
          exit_price:   closePrice,
          closed_at:    now,
          pnl_percent:  parseFloat(pnl.toFixed(2)),
          close_reason: closeReason,
        };

    const closeFilter = isFinalClosingTp1
      ? admin.from('trades').update(closeUpdate)
          .eq('id', trade.id).eq('status', 'tp1_hit').is('closed_at', null)
      : admin.from('trades').update(closeUpdate)
          .eq('id', trade.id).is('result', null);

    const closeRes = await closeFilter.select('id');

    let closeWriteOk = !closeRes.error && (closeRes.data?.length ?? 0) > 0;

    if (closeRes.error) {
      if (closeRes.error.code === '42703') {
        // Column(s) missing. Two known tiers, tried in order:
        //   1. close_reason not migrated yet (new column) — retry with everything else intact.
        //   2. exit_price/pnl_percent also missing (older schema) — minimal write.
        // 待修改事項.md pattern: log loudly so a silently-degraded write surfaces immediately.
        const midUpdate = isFinalClosingTp1
          ? { ...(closeResult === 'WIN_TP2' ? { result: 'WIN_TP2' } : {}), exit_price: closePrice, closed_at: now, pnl_percent: parseFloat(pnl.toFixed(2)) }
          : { result: closeResult, exit_price: closePrice, closed_at: now, pnl_percent: parseFloat(pnl.toFixed(2)) };
        const midFilter = isFinalClosingTp1
          ? admin.from('trades').update(midUpdate).eq('id', trade.id).eq('status', 'tp1_hit').is('closed_at', null)
          : admin.from('trades').update(midUpdate).eq('id', trade.id).is('result', null);
        const mid = await midFilter.select('id');

        if (!mid.error) {
          console.error(`[monitor] close_reason column missing for ${trade.id} — wrote without it. Run: ALTER TABLE trades ADD COLUMN IF NOT EXISTS close_reason TEXT;`);
          closeWriteOk = (mid.data?.length ?? 0) > 0;
        } else if (mid.error.code === '42703') {
          // exit_price / pnl_percent also missing — write minimal fields
          const fbUpdate = isFinalClosingTp1
            ? { ...(closeResult === 'WIN_TP2' ? { result: 'WIN_TP2' } : {}), closed_at: now }
            : { result: closeResult, closed_at: now };
          const fbFilter = isFinalClosingTp1
            ? admin.from('trades').update(fbUpdate).eq('id', trade.id).eq('status', 'tp1_hit').is('closed_at', null)
            : admin.from('trades').update(fbUpdate).eq('id', trade.id).is('result', null);
          const fallback = await fbFilter.select('id');
          if (!fallback.error) {
            closeWriteOk = (fallback.data?.length ?? 0) > 0;
          } else {
            console.error(`[monitor] close fallback failed ${trade.id}: ${fallback.error.message}`);
            await touchMonitoredAt(trade.id as string);
            continue;
          }
        } else {
          console.error(`[monitor] close mid-tier failed ${trade.id}: ${mid.error.message}`);
          await touchMonitoredAt(trade.id as string);
          continue;
        }
      } else {
        console.error(`[monitor] close failed ${trade.id}: ${closeRes.error.message}`);
        await touchMonitoredAt(trade.id as string);
        continue;
      }
    }

    if (!closeWriteOk) {
      console.log(`[monitor] close skipped ${trade.id} — result already set by concurrent cron`);
      continue;
    }

    await unlockSymbol(trade.symbol as string);

    // 時間止損影子模擬：只追蹤「還沒到 TP1 就被時間強制關掉」的兩種情況
    // （8根K線停滯、24h/72h/168h到期），不追蹤 TP1 後才到期的單——那些已經
    // 鎖利，不是「可能砍在半路」的問題（docs/TODO.md P1 #1）。
    // 2026-08-13：pre-TP1 保本止損也會產生 closeResult='MANUAL_CLOSE'，但
    // 它是止損家族的事件（保護性停損被觸發），不是時間止損——排除掉，
    // 否則會把保本出場錯記成時間止損的樣本，汙染這個影子模擬本來要驗證
    // 「時間止損砍得對不對」的量測。
    if (closeResult === 'MANUAL_CLOSE' && !hitPreTp1Breakeven) {
      const trigger: TimeStopTrigger = timeStopFired ? 'stall' : 'expiry';
      timeStopShadowStarts.push(startTimeStopShadow({
        id:            trade.id as string,
        symbol:        trade.symbol as string,
        direction:     trade.direction as 'LONG' | 'SHORT',
        timeframe:     trade.timeframe as string,
        entry:         trade.entry as number,
        stopLoss:      trade.stop_loss as number,
        tp1:           trade.tp1 as number,
        tp2:           trade.tp2 as number,
        trigger,
        realExitPrice: closePrice,
        realClosedAt:  now,
      }));
    }

    // Post-loss cooldown: same symbol+direction blocked for 24h (see helper docs)
    if (closeResult === 'LOSS') {
      await setLossCooldown(trade.symbol as string, trade.direction as string);
    } else if (timeStopFired) {
      // 時間止損＝盤面停滯而非證偽；短冷卻 4h 防止立刻重進同一個停滯 setup
      // 空轉手續費，倉位仍讓給其他幣種。
      //
      // 2026-08-05：原本只鎖「同方向」，但時間止損的判定依據是「8 根 K 線
      // 都卡在 −0.3R ~ +0.3R」——這是對「這個標的現在在盤整」的診斷，不是
      // 對「做多錯了」的診斷。只鎖同向的話，剛把停滯的多單砍掉，下一輪
      // (5 分鐘後) 反向的空單訊號完全暢通，等於在同一個盤整區來回付手續費，
      // 正是上面註解想避免的事。使用者實際踩到：持倉被時間止損關掉後，
      // 立刻又收到同一個標的的新掛單推薦。改成兩個方向都鎖 4h。
      //
      // 註：LOSS 維持只鎖同向不變——止損是對「這個方向錯了」的診斷，
      // 反向反而可能是對的，兩者語意不同，不能一起改。
      await setLossCooldown(trade.symbol as string, 'LONG',  4 * 3600);
      await setLossCooldown(trade.symbol as string, 'SHORT', 4 * 3600);
    }

    {
      const dir = isLong ? '▲ 做多' : '▼ 做空';
      const sym = (trade.symbol as string).replace('USDT', '/USDT');
      const pnlStr = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`;
      let pushTitle: string;
      // 2026-08-13：hitPreTp1Breakeven 必須在 timeStopFired 之前檢查——
      // 兩者都用 closeResult==='MANUAL_CLOSE'，順序反了會把保本出場誤標
      // 成「到期平倉」（跟 live-runner 那邊 8/13 修的通知分派 bug 同一種
      // 「新事件複用舊 closeResult，忘了同步標題判斷」模式）。
      if (closeResult === 'MANUAL_CLOSE' && hitPreTp1Breakeven) {
        pushTitle  = `🛡 保本出場 ${sym}`;
      } else if (closeResult === 'MANUAL_CLOSE' && timeStopFired) {
        pushTitle  = `⏱ 時間止損 ${sym}`;
      } else if (closeResult === 'MANUAL_CLOSE') {
        pushTitle  = `⏱ 到期平倉 ${sym}`;
      } else {
        const label = closeResult === 'WIN_TP2' ? '✅ TP2 全部達標'
                    : closeResult === 'WIN_TP1' ? (hitTrailingStop ? '🔒 移動止損出場（TP1 已達標）' : autoClosedAfterTp1 ? '⏱ 到期平倉（TP1 已達標，保本以上）' : localTp1Hit ? '🔒 SL 出場（TP1 已達標）' : '✅ TP1 達標')
                    : '❌ 止損出場';
        pushTitle = `${label} ${sym}`;
      }
      if (profileId && notifyOk) {
        await sendWebPushToUser(profileId, {
          title: pushTitle,
          body: `${dir} 出場 $${fmtPrice(closePrice)} ｜ ${pnlStr}`,
          tag: `close-${trade.id}`,
        });
      }
    }
    closed++;
  }

  await processTimeStopShadows(timeStopShadowStarts);
  await processCancelShadows(cancelShadowStarts);

  if (rLock) { try { await rLock.del('monitor-run-lock'); } catch { /* best-effort */ } }
  return { monitored: active.length + waiting.length, closed, filled, cancelled };
}

// 時間止損影子模擬的 Redis 讀寫（docs/TODO.md P1 #1）。跟 processShadowTrades
// 同一種模式（合併新單、每輪限量抓K線推進、修剪過舊的已結束項目），但這裡
// 追蹤的是真實已關閉的交易，不是被拒訊號——1:1 對應 trade id，不需去重合併。
async function processTimeStopShadows(newStarts: TimeStopShadow[]): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    const raw = (await r.hgetall<Record<string, unknown>>('time_stop_shadows')) ?? {};
    const shadows = new Map<string, TimeStopShadow>();
    for (const [id, v] of Object.entries(raw)) {
      try {
        const s = (typeof v === 'string' ? JSON.parse(v) : v) as TimeStopShadow;
        if (s && s.symbol && s.status) shadows.set(id, s);
      } catch { /* drop malformed entry */ }
    }

    const writes: Record<string, string> = {};
    for (const s of newStarts) {
      if (shadows.has(s.id)) continue; // already tracked (shouldn't happen, guard anyway)
      shadows.set(s.id, s);
      writes[s.id] = JSON.stringify(s);
    }

    const now = Date.now();

    // Merging new starts (above) runs every scan — they'd be lost otherwise.
    // Advancing them is throttled: it simulates against 1h candles, so a
    // 10-minute cadence produces the same numbers as a 1-minute one.
    if (await claimPeriodicSlot('time-stop-shadow-advance', SHADOW_ADVANCE_PERIOD_SEC)) {
      const live = Array.from(shadows.values()).filter(s => s.status === 'live');
      const bySymbol = new Map<string, TimeStopShadow[]>();
      live.forEach(s => {
        const arr = bySymbol.get(s.symbol) ?? [];
        arr.push(s);
        bySymbol.set(s.symbol, arr);
      });

      let fetches = 0;
      for (const [symbol, group] of Array.from(bySymbol.entries())) {
        if (fetches >= 8) break; // rest advance next slot
        fetches++;
        let candles: Candle[] = [];
        try { candles = await fetchCandles(symbol, '1h', 168, 3); } catch { continue; }
        for (const s of group) {
          const advanced = advanceTimeStopShadow(s, candles, now);
          shadows.set(s.id, advanced);
          writes[s.id] = JSON.stringify(advanced);
        }
      }
    }

    // Prune done shadows older than 30 days — long enough to review a week or
    // two of data (docs/TODO.md #8/#9 cadence) without growing the hash forever.
    const toDelete: string[] = [];
    for (const [id, s] of Array.from(shadows.entries())) {
      if (s.status === 'done' && now - (s.closedAt ?? s.realClosedAt) > 30 * 24 * 3600 * 1000) toDelete.push(id);
    }

    if (Object.keys(writes).length > 0) await r.hset('time_stop_shadows', writes);
    if (toDelete.length > 0) await r.hdel('time_stop_shadows', ...toDelete);
    await r.expire('time_stop_shadows', 30 * 24 * 3600);
  } catch (e) {
    console.error('[time-stop-shadow] simulation failed:', String(e).slice(0, 200));
  }
}

// 推薦單失效影子模擬的 Redis 讀寫（docs/TODO.md 2026-08-01）。跟
// processTimeStopShadows 同一種模式（合併新單、每輪限量抓K線推進、修剪過舊
// 的已結束項目），獨立的 Redis key 跟節流 slot，不跟時間止損互搶額度。
async function processCancelShadows(newStarts: CancelShadow[]): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    const raw = (await r.hgetall<Record<string, unknown>>('cancel_shadows')) ?? {};
    const shadows = new Map<string, CancelShadow>();
    for (const [id, v] of Object.entries(raw)) {
      try {
        const s = (typeof v === 'string' ? JSON.parse(v) : v) as CancelShadow;
        if (s && s.symbol && s.status) shadows.set(id, s);
      } catch { /* drop malformed entry */ }
    }

    const writes: Record<string, string> = {};
    for (const s of newStarts) {
      if (shadows.has(s.id)) continue; // already tracked (shouldn't happen, guard anyway)
      shadows.set(s.id, s);
      writes[s.id] = JSON.stringify(s);
    }

    const now = Date.now();

    if (await claimPeriodicSlot('cancel-shadow-advance', SHADOW_ADVANCE_PERIOD_SEC)) {
      const live = Array.from(shadows.values()).filter(s => s.status === 'live');
      const bySymbol = new Map<string, CancelShadow[]>();
      live.forEach(s => {
        const arr = bySymbol.get(s.symbol) ?? [];
        arr.push(s);
        bySymbol.set(s.symbol, arr);
      });

      let fetches = 0;
      for (const [symbol, group] of Array.from(bySymbol.entries())) {
        if (fetches >= 8) break; // rest advance next slot
        fetches++;
        let candles: Candle[] = [];
        try { candles = await fetchCandles(symbol, '1h', 168, 3); } catch { continue; }
        for (const s of group) {
          const advanced = advanceCancelShadow(s, candles, now);
          shadows.set(s.id, advanced);
          writes[s.id] = JSON.stringify(advanced);
        }
      }
    }

    // Prune done shadows older than 30 days — same retention as time-stop shadows.
    const toDelete: string[] = [];
    for (const [id, s] of Array.from(shadows.entries())) {
      if (s.status === 'done' && now - (s.closedAt ?? s.cancelledAt) > 30 * 24 * 3600 * 1000) toDelete.push(id);
    }

    if (Object.keys(writes).length > 0) await r.hset('cancel_shadows', writes);
    if (toDelete.length > 0) await r.hdel('cancel_shadows', ...toDelete);
    await r.expire('cancel_shadows', 30 * 24 * 3600);
  } catch (e) {
    console.error('[cancel-shadow] simulation failed:', String(e).slice(0, 200));
  }
}

// ── Confidence score (0-100, Phase 4) ────────────────────────
// Parallel to existing `score`; does NOT affect the STRONG_THRESHOLD gate yet.
// Formula: base 50 + ADX strength + confluence + volume + funding rate crowding.
// Crowded direction (>+0.1% for LONG, <-0.05% for SHORT) deducts 20 pts.
function computeConfidence(
  signal: TradingSignal,
  adx4h: number,
  fundingRate: number,
  agreeTFs: number,
): number {
  let c = 50;

  // ADX strength (only meaningful in trending regime)
  if (!isNaN(adx4h)) {
    if      (adx4h > 40) c += 15;
    else if (adx4h > 30) c += 10;
    else if (adx4h > 25) c +=  5;
  }

  // Confluence: Strategy B is its own dual-factor confirmation
  if      (signal.strategy === 'B') c += 10;
  else if (agreeTFs >= 2)           c += 15;

  // Volume (derived from reasons string to avoid passing extra params)
  if (signal.reasons.some(r => r.includes('量能') || r.includes('放量'))) c += 5;

  // Funding rate crowding — same direction as crowded market → -20
  if (signal.direction === 'LONG'  && fundingRate >  0.001)  c -= 20;
  if (signal.direction === 'SHORT' && fundingRate < -0.0005) c -= 20;

  return Math.max(0, Math.min(100, Math.round(c)));
}

// ── Strategy B: consecutive-loss pause check ─────────────────
// Returns true if this symbol's Strategy B should be paused (2 consecutive
// LOSS results within the last 24h). Safe-fails to false on any DB error
// (including 42703 if the `strategy` column hasn't been migrated yet).
async function checkStratBPaused(symbol: string): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL  || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return false;

  // Redis fast-path: key is set when we first confirm the pause condition
  const r = getRedis();
  if (r) {
    try {
      const paused = await r.get<boolean>(`stratB_pause:${symbol}`);
      if (paused) return true;
    } catch { /* fall through to DB */ }
  }

  try {
    const { createClient: mkChk } = await import('@supabase/supabase-js');
    const adm = mkChk(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data } = await adm.from('trades')
      .select('result, closed_at')
      .eq('symbol', symbol)
      .eq('strategy', 'B')          // 42703 → catch block → return false
      .not('result', 'is', null)
      .order('closed_at', { ascending: false })
      .limit(2);

    if (!data || data.length < 2) return false;
    const [recent, prev] = data as { result: string; closed_at: number }[];
    if (recent.result !== 'LOSS' || prev.result !== 'LOSS') return false;

    const elapsed = Date.now() - recent.closed_at;
    if (elapsed > 24 * 3_600_000) return false;

    // Cache remaining pause duration in Redis so next cron reads fast
    if (r) {
      const remainingSec = Math.ceil((24 * 3_600_000 - elapsed) / 1000);
      try { await r.set(`stratB_pause:${symbol}`, true, { ex: remainingSec }); } catch { /* best-effort */ }
    }
    return true;
  } catch {
    // Includes 42703 (column not migrated yet) — don't pause
    return false;
  }
}

// ── Phase 5: total open risk check ───────────────────────────
// Sums suggested_risk_pct of all open trades for a user. suggested_risk_pct is
// the system's ATR-volatility-based sizing suggestion (0.5/1.0/1.5, informational,
// user applies manually — src/types/index.ts), completely independent of the
// user's own acctRiskPct setting. So this cap is really "how many concurrent
// positions, weighted by volatility class" — NOT a real dollar/account % figure,
// regardless of what risk% the user has chosen. 2026-07-31: relabeled the
// displayed text (skip reason + BtcStatusBar/ScanStatusPanel) to stop implying
// it's real account risk after the 10% risk option made the gap between this
// proxy number and actual dollar exposure obvious — the number/threshold itself
// is unchanged, only what it's called.
// Falls back to (open-trade-count × 1%) if the column doesn't exist yet.
// Returns 0 on any fatal error so the gate never falsely blocks signals.
async function checkTotalOpenRisk(profileId: string): Promise<number> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL  || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key || !profileId) return 0;
  const { createClient: mk } = await import('@supabase/supabase-js');
  const adm = mk(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  try {
    const { data } = await adm.from('trades')
      .select('suggested_risk_pct')
      .eq('user_id', profileId)
      .is('closed_at', null);  // closed_at=null means still open (incl. tp1_hit watching TP2)
    if (!data) return 0;
    return data.reduce((s: number, t: { suggested_risk_pct?: number | null }) =>
      s + (t.suggested_risk_pct ?? 1), 0);
  } catch {
    // Column not migrated (42703) or other DB error — estimate via open-trade count × 1%
    try {
      const { count } = await adm.from('trades')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', profileId)
        .is('closed_at', null);
      return (count ?? 0) * 1;
    } catch {
      return 0;
    }
  }
}

// ── Phase 6: Event filter ─────────────────────────────────────
// Blocks all new signals within ±30 min of a scheduled market event.
// Event list sources (first non-empty wins):
//   1. Redis key  'event_filter_events'  → JSON array of ISO-8601 strings
//   2. Env var    EVENT_FILTER_EVENTS    → comma-separated ISO-8601 strings OR JSON array
// To add an event via Upstash console:
//   SET event_filter_events '["2025-01-15T14:30:00Z","2025-01-15T20:00:00Z"]'
const EVENT_WINDOW_MS = 30 * 60 * 1000; // ±30 min window

async function checkEventFilter(): Promise<{ active: boolean; reason?: string }> {
  try {
    let events: string[] = [];

    // Priority 1: Redis (survives redeploy, allows runtime updates)
    const r = getRedis();
    if (r) {
      try {
        const raw = await r.get<unknown>('event_filter_events');
        if (raw) {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (Array.isArray(parsed)) events = parsed as string[];
        }
      } catch { /* fall through */ }
    }

    // Priority 2: Env var (deploy-time config)
    if (events.length === 0) {
      const envRaw = (process.env.EVENT_FILTER_EVENTS ?? '').trim();
      if (envRaw) {
        try {
          const parsed = JSON.parse(envRaw);
          if (Array.isArray(parsed)) events = parsed as string[];
        } catch {
          // Plain comma-separated list
          events = envRaw.split(',').map(s => s.trim()).filter(Boolean);
        }
      }
    }

    if (events.length === 0) return { active: false };

    const now = Date.now();
    for (const ev of events) {
      const evMs = new Date(ev).getTime();
      if (!isNaN(evMs) && Math.abs(now - evMs) <= EVENT_WINDOW_MS) {
        const diffMin = Math.round((evMs - now) / 60_000);
        const label   = diffMin > 0 ? `${diffMin}分鐘後` : diffMin < 0 ? `${-diffMin}分鐘前` : '進行中';
        return { active: true, reason: `事件過濾 — 重大事件 ${label}（${new Date(evMs).toUTCString()}）` };
      }
    }
    return { active: false };
  } catch {
    return { active: false }; // never block signals on error
  }
}

// ── §4.3 Same-direction open-risk cap（風險加權）──────────────
// Spec 原文是「同向合計風險 ≤ 2%」，舊實作卻數「筆數 ≤ 2」——B 級輕倉
// 只佔 0.5% 風險，按筆數算會把容量砍半（2026-07-19 漏斗數據：同向上限
// 佔全部拒絕 11-23%，是第二大容量瓶頸）。改為：
//   同向合計風險 + 新單風險 ≤ acctRiskPct×2；山寨桶（非BTC/ETH）同向 ≤ acctRiskPct×1
//（2026-07-31 起改跟 acctRiskPct 等比例縮放，理由見下方同一函式內的補充註解）。
// A 級 = 1 倍、B 級 = 0.5 倍（tier 欄位缺失的舊資料保守當 1 倍）。
//
// 2026-07-26：山寨桶原本是 1 個名額全有全無（A 級單開一筆就佔滿 1.0%），
// 桶內零分散——單一幣種特有風險（插針/下架）100% 曝露在那一筆上，且名額
// 用先到先得（掃描按成交量排名跑，非按分數排），不是擇優。改成 slot 制：
// 山寨桶內每筆風險貢獻上限 ALT_SLOT_RISK，讓 1.0% 桶容納 ~3 筆分散部位，
// 而不是 1 筆全倉。風險貢獻用 `tierRiskMultiplier`（src/lib/position.ts）—
// 與推播/前端算真實下單風險的同一份函式，記帳跟實際 USDT 曝險保證一致，
// 不會像 commit 9862264 那版只改記帳、下單額度仍照 tier 全額算。
//
// 2026-07-26（第二次修正）：`tierRiskMultiplier` 回傳的是「倍率」（A=1.0、
// B=0.5、山寨封頂0.33），本函式卻一直把它當「絕對帳戶百分比」直接跟 2.0%／
// 1.0% 比——兩者只有在使用者 riskPctPerTrade 剛好=1% 時才會一致。實測帳戶
// riskPctPerTrade=3%：真實下單風險 = 3% × 倍率，同向三張山寨滿倉真實曝險
// 達 3%（0.99%×3），本函式卻以為只用了 0.99%，全部上限被低估達使用者
// riskPctPerTrade 倍（此帳戶是 3 倍）。修正：倍率 × acctRiskPct 才是真實
// 帳戶%，2.0%／1.0% 這兩層帽子改跟這個真實值比。
// 已知近似：既有持倉是用「現在」的 acctRiskPct 反推，若使用者中途改過風險
//設定，舊倉位開倉當下的真實風險可能跟現在算出來的不同——比照全站其餘倉位
// 試算（也都是用「現在」acctRiskPct）的既有假設，不是這次修正引入的新問題。
//
// 2026-07-31：上面兩個帽子 2.0%／1.0% 當時是寫死的絕對值，隱含假設
// acctRiskPct 大約落在 1%（riskPctPerTrade 選項只到 3% 時還撐得住，3%
// 山寨滿倉 0.99%×3≈2.97% 已經逼近上限）。新增 10% 選項後，單一主流幣新單
// 風險貢獻本身就是 acctRiskPct×1.0=10%，尚未疊加任何既有倉位就已經超過
// 固定 2% 上限——導致同向上限攔截「已佔用 0.00%」的單，等於完全擋死。
// 改成兩個帽子都跟 acctRiskPct 等比例縮放（2 倍／1 倍），語意維持「同向最多
// 疊多少筆」而不是「帳戶風險絕對值上限」，acctRiskPct=1 時數字與舊版完全
// 相同，數值不會因為使用者選了更高風險% 而變相被腰斬。
async function checkSameDirectionRisk(
  profileId: string, direction: string, symbol: string, newTier: string | null | undefined,
  acctRiskPct: number,
): Promise<{ block: boolean; reason?: string }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL  || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key || !profileId) return { block: false };
  try {
    const { createClient: mk } = await import('@supabase/supabase-js');
    const adm = mk(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

    const { data } = await adm.from('trades')
      .select('symbol, tier')
      .eq('user_id', profileId).eq('direction', direction).is('closed_at', null);
    const rows = (data ?? []) as { symbol: string; tier?: string | null }[];

    const isAlt  = (sym: string) => !sym.startsWith('BTC') && !sym.startsWith('ETH');
    const riskContribution = (sym: string, tier: string | null | undefined) =>
      acctRiskPct * tierRiskMultiplier(sym, tier);

    let totalRisk = 0;
    let altRisk = 0;
    for (const row of rows) {
      const r = riskContribution(row.symbol, row.tier);
      totalRisk += r;
      if (isAlt(row.symbol)) altRisk += r;
    }

    const isAltcoin = isAlt(symbol);
    const newRisk = riskContribution(symbol, newTier);
    const totalCap = acctRiskPct * 2.0;
    const altCap   = acctRiskPct * 1.0;

    if (totalRisk + newRisk > totalCap) {
      return {
        block: true,
        reason: `同向風險上限：${direction} 已占用 ${totalRisk.toFixed(2)}%，新單 ${newRisk.toFixed(2)}% 會超過 ${totalCap.toFixed(2)}%`,
      };
    }

    if (isAltcoin && altRisk + newRisk > altCap) {
      return {
        block: true,
        reason: `山寨同向風險上限：${direction} 山寨桶已占用 ${altRisk.toFixed(2)}%，新單 ${newRisk.toFixed(2)}% 會超過 ${altCap.toFixed(2)}%`,
      };
    }
    return { block: false };
  } catch { return { block: false }; }
}

// ── §4.4 Circuit breaker ──────────────────────────────────────
// Triggered when today's closed trades hit ≥3 consecutive losses OR cumulative
// ACCOUNT loss ≤ -3%. 2026-07-18 fix: measure account impact (R × tier risk),
// NOT raw pnl_percent. A single ATR-based -12% stop is only -1R = -1% account;
// summing raw % tripped the breaker on one bad candle and froze signals all day.
// Cache key is v2 so any stuck v1 (`circuit_breaker:`) key is abandoned on deploy.
async function checkCircuitBreaker(profileId: string, acctRiskPct: number): Promise<{ triggered: boolean; reason?: string }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL  || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key || !profileId) return { triggered: false };

  const r = getRedis();
  if (r) {
    try {
      const cached = await r.get<string>(`circuit_breaker_v2:${profileId}`);
      if (cached) return { triggered: true, reason: cached };
    } catch { /* fall through */ }
  }

  try {
    const { createClient: mk } = await import('@supabase/supabase-js');
    const adm = mk(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

    const todayUTC = new Date();
    todayUTC.setUTCHours(0, 0, 0, 0);

    const { data } = await adm.from('trades')
      .select('result, pnl_percent, entry, stop_loss, tier, closed_at')
      .eq('user_id', profileId).not('result', 'is', null)
      .gte('closed_at', todayUTC.getTime())
      .order('closed_at', { ascending: false });

    if (!data || data.length === 0) return { triggered: false };

    // Check 1: cumulative tier-weighted R ≤ -3R（門檻故意不乘 acctRiskPct——
    // 2026-07-31：門檻若隨風險%走，10% 設定下單筆 -1R 就等於 -10%，會直接
    // 單筆熔斷整天，喪失「連續虧損才熔斷」的本意；R 空間下門檻恆定，出單
    // 節奏不會因為使用者選了更高風險% 而被打斷。只有下面顯示用的真實帳戶%
    // 才乘 acctRiskPct，不影響觸發邏輯）。
    const rows = data as { result: string; pnl_percent?: number | null; entry?: number | null; stop_loss?: number | null; tier?: string | null }[];
    const dailyR = rows.reduce((s, t) => {
      if (t.pnl_percent == null || !t.entry || !t.stop_loss) return s;
      const stopPct = Math.abs(t.entry - t.stop_loss) / t.entry * 100;
      if (stopPct <= 0) return s;
      const rMultiple = t.pnl_percent / stopPct;          // e.g. -12% / 12% = -1R
      return s + rMultiple * (t.tier === 'B' ? 0.5 : 1.0); // tier-weighted R
    }, 0);
    if (dailyR <= -3) {
      const realAcctPct = dailyR * acctRiskPct;
      const reason = `熔斷：當日帳戶虧損 ${realAcctPct.toFixed(2)}%（風險加權 ${dailyR.toFixed(2)}R ≤ -3R）`;
      await cacheBreaker(r, profileId, reason, todayUTC);
      return { triggered: true, reason };
    }

    // Check 2: 3 consecutive losses in today's trades
    let streak = 0;
    for (const t of rows) {
      if (t.result === 'LOSS') streak++;
      else break;
    }
    if (streak >= 3) {
      const reason = `熔斷：連續 ${streak} 筆止損`;
      await cacheBreaker(r, profileId, reason, todayUTC);
      return { triggered: true, reason };
    }
    return { triggered: false };
  } catch { return { triggered: false }; }
}

async function cacheBreaker(r: import('@upstash/redis').Redis | null, profileId: string, reason: string, todayUTC: Date) {
  if (!r) return;
  const secLeft = Math.ceil((todayUTC.getTime() + 86_400_000 - Date.now()) / 1000);
  try { await r.set(`circuit_breaker_v2:${profileId}`, reason, { ex: Math.max(secLeft, 60) }); } catch { /* best-effort */ }
}

// ── 跨日權益回撤上限（2026-08-04，自動化前的安全網）─────────────
// checkCircuitBreaker 只看當日、每天 UTC 0 點重置，擋不住「每天小輸、累積大輸」。
// 這裡看整條已平倉權益曲線的高點回撤（詳細動機見 monitorMath.ts 的 calcDrawdown）。
//
// 門檻原為 8R：當時實測歷史 55 筆已平倉單最大回撤 2.01R，8R 約是 4 倍，判斷
// 正常運作碰不到。可用 MAX_DRAWDOWN_R 環境變數調整；設為 0 或負數等於停用。
//
// 用「帳戶R」而非原始R：B 級輕倉只承擔一半風險，回撤要按實際帳戶衝擊算，
// 跟熔斷、CSV 匯出的「帳戶R」欄位同一套口徑。
//
// **2026-08-19：8R → 12R，暫時性放寬，之後要收回去。**
// 實際觸發時是 8.01R（高點 26.44R → 18.43R），只超標 0.01R，但近三天 1500 個
// 候選 100% 被擋、系統完全停擺。關鍵在於**這 8R 回撤是用有 bug 的系統跑出來的**
// （同日查出並修掉：未收盤K棒讓五組計分裡兩組共20分變成垃圾；真倉的 TP1 前保本
// 與 TP1 後移動止損因為 place-before-cancel 撞幣安 closePosition 限制，從上線
// 到當天為止一次都沒生效過）。也就是說，這條權益曲線反映的是「保護機制沒運作
// 的策略」，拿它算出來的回撤去判定「策略失效」並不公平。
//
// 12R 的取法：目前觀察到的 8.01R × 1.5，留出累積修復後乾淨資料的空間，同時
// 仍然是一道真的會擋的上限（不是形同虛設）。**這是暫時值，不是重新校準的
// 結果**——等 2026-09 上旬累積 2-3 週修復後的資料，重跑一次歷史最大回撤，
// 再決定該回到 8R 還是有依據地訂一個新值。
const DEFAULT_MAX_DRAWDOWN_R = 12;

// 2026-08-19：確認（acknowledge）之後，權益曲線只從確認那一刻之後的已平倉
// 交易重新算起。這是解開下面那個死結的鑰匙——見 checkDrawdownHalt 註解。
// 刻意不 export：Next.js App Router 的 route 檔只允許 export GET/POST/DELETE
// 這類特定名稱，多匯出一個常數會讓 build 期的 .next/types 檢查失敗
// （`tsc --noEmit` 抓不到這個，只有 next build 會）。同檔案內使用不需要 export。
const DRAWDOWN_ACK_KEY = (profileId: string) => `drawdown_ack:${profileId}`;

async function checkDrawdownHalt(profileId: string): Promise<{ halted: boolean; reason?: string; state?: DrawdownState }> {
  const limit = parseFloat(process.env.MAX_DRAWDOWN_R ?? String(DEFAULT_MAX_DRAWDOWN_R));
  if (!isFinite(limit) || limit <= 0) return { halted: false }; // 停用
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL  || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key || !profileId) return { halted: false };

  // 2026-08-19 實測撞到**死結**：回撤是從「已平倉交易」算的，而這道關卡擋掉
  // 所有新開倉——沒有新單就沒有新的平倉，權益曲線永遠不動，回撤就永遠卡在
  // 觸發值。原本沒有任何重置/TTL/恢復路徑，唯一出口是改 MAX_DRAWDOWN_R 環境
  // 變數。實際發生：8.01R vs 上限 8R（只超過 0.01R），近三天 1500 個候選
  // 100% 被擋，其中不乏 SOL 91分、ZEC 83分這種高分訊號，系統等同永久停擺。
  //
  // 修法：加一個「確認」機制。這道關卡的用意是「策略可能失效，停下來讓人工
  // 檢查」——所以正確的解除方式是人看過之後明確確認，不是自動放行（自動放行
  // 等於這道關卡不存在）。確認後把量測基準推到確認當下：只看之後平倉的單，
  // 等於「我看過了，從現在開始重新算」。這樣風險上限完全沒有放寬，但系統
  // 不會再永久卡死。確認方式見 DELETE handler 的 ?scope=drawdown。
  let ackAt = 0;
  {
    const r = getRedis();
    if (r) {
      try {
        const v = await r.get(DRAWDOWN_ACK_KEY(profileId));
        if (v !== null && v !== undefined) ackAt = Number(v) || 0;
      } catch { /* 讀不到就當沒確認過，維持原本行為 */ }
    }
  }

  try {
    const { createClient: mk } = await import('@supabase/supabase-js');
    const adm = mk(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
    let q = adm.from('trades')
      .select('closed_at, pnl_percent, entry, stop_loss, tier')
      .eq('user_id', profileId).not('closed_at', 'is', null).not('result', 'is', null);
    if (ackAt > 0) q = q.gt('closed_at', ackAt);
    const { data } = await q.order('closed_at', { ascending: true });
    if (!data || data.length === 0) return { halted: false };

    const rows = data as { closed_at: number; pnl_percent?: number | null; entry?: number | null; stop_loss?: number | null; tier?: string | null }[];
    const points: EquityPoint[] = [];
    for (const t of rows) {
      if (t.pnl_percent == null || !t.entry || !t.stop_loss) continue;
      const stopPct = Math.abs(t.entry - t.stop_loss) / t.entry * 100;
      if (stopPct <= 0) continue;
      // 同 checkCircuitBreaker 的口徑：R 倍數 × tier 權重 = 帳戶衝擊
      points.push({ closedAt: t.closed_at, accountR: (t.pnl_percent / stopPct) * (t.tier === 'B' ? 0.5 : 1.0) });
    }
    if (points.length === 0) return { halted: false };

    const state = calcDrawdown(points);
    if (state.drawdown >= limit) {
      return {
        halted: true,
        reason: `權益回撤 ${state.drawdown.toFixed(2)}R（高點 ${state.peak.toFixed(2)}R → 目前 ${state.current.toFixed(2)}R），已達上限 ${limit}R — 暫停開新倉，請人工檢查策略是否失效；檢查完可用 DELETE /api/analyze?scope=drawdown 確認並從當下重新計算`,
        state,
      };
    }
    return { halted: false, state };
  } catch {
    // 查詢失敗不擋單——跟其餘關卡一致，絕不因為基礎設施故障就凍結整個系統
    return { halted: false };
  }
}

// ── Shadow simulation of rejected signals ──────────────────────
// Spec §4.5: a rule may only be loosened when funnel data proves the signals
// it kills are net-positive. Every gate-rejected candidate that had concrete
// entry/SL/TP levels becomes a "shadow trade" simulated against real candles;
// /api/reject-funnel reports per-gate would-have-won/lost + net R.
interface ShadowTrade {
  id: string;
  at: number;               // rejection time
  symbol: string;
  direction: string;
  timeframe: string;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  score: number;
  tier: string | null;
  strategy: string;
  rejectedAt: string;       // gate id from the funnel
  signalPrice: number;
  status: 'waiting' | 'active' | 'done';
  filledAt?: number;
  tp1Hit?: boolean;
  result?: string;          // WIN_TP1 | WIN_TP2 | LOSS | EXPIRED | TIMEOUT
  exitPrice?: number;
  closedAt?: number;
  lastCheckedAt: number;
  // 2026-08-22 悲觀軌跡（同根K線同時觸及 TP/SL 時判賠）。全部 optional——
  // 這個欄位加上去之前累積的 shadow_trades 沒有這些值，漏斗端必須能分辨
  // 「這筆沒有悲觀資料」與「悲觀結果是 0」，不然舊資料會被當成 0R 拉低平均。
  pessTp1Hit?: boolean;
  pessDone?: boolean;
  pessResult?: string;
  pessExitPrice?: number;
}

// Gates where a full signal existed — worth simulating.
// locked/same_candle/cooldown duplicate live trades and would double-count.
//
// 2026-08-18（docs/TODO.md P2 #7）：score_gate 加進來了。原本被排除的理由是
// 「score_gate has no levels」——sub-threshold 候選沒有價位可模擬。查證後發現
// 這個前提不成立：價位算式的每個輸入都在 tier 關卡之前就算好了，只是恰好
// 寫在關卡裡面。抽成 buildSignalLevels 後被擋的候選也能算出同一組價位
// （見 signals.ts 該函數與 RejectedCandidate 註解）。這是漏斗裡最大的一道
// 關卡（擋掉約 55%）也是唯一的量測盲區，補上它才知道擋得對不對。
const SHADOW_GATES = new Set([
  'confluence', 'no_entry_tf', 'btc_direction', 'btc_chaos', 'btc_pause', 'loss_cooldown',
  'same_dir_cap', 'total_risk_cap', 'circuit_breaker', 'event_filter', 'insert_failed',
  'score_gate',
]);
const SHADOW_MAX = 300; // hash size guard

function simulateShadow(st: ShadowTrade, candles: Candle[], now: number): void {
  const isLong = st.direction === 'LONG';
  const waitMs   = WAITING_EXPIRY_HOURS * 3600 * 1000;
  const activeMs = INTRADAY_CLOSE_HOURS * 3600 * 1000;

  if (st.status === 'waiting') {
    for (const c of candles) {
      if (c.closeTime <= st.at || c.openTime > st.at + waitMs) continue;
      const touched = isLong ? c.low <= st.entry : c.high >= st.entry;
      if (touched) { st.status = 'active'; st.filledAt = Math.max(c.openTime, st.at); break; }
    }
    if (st.status === 'waiting') {
      if (now - st.at > waitMs) { st.status = 'done'; st.result = 'EXPIRED'; st.closedAt = now; }
      return;
    }
  }
  if (st.status !== 'active' || !st.filledAt) return;

  const levels = { entry: st.entry, stopLoss: st.stopLoss, tp1: st.tp1, tp2: st.tp2, isLong };

  // 2026-08-22：同一根K線同時觸及 TP 和 SL 時，K線看不出誰先到。這裡平行
  // 跑一條悲觀假設（碰到 SL 就認賠）的軌跡，讓 /api/reject-funnel 把淨R
  // 顯示成「悲觀 ~ 樂觀」區間。理由見 monitorMath.ts 的 TieBreak 說明：
  // 真倉靠即時報價、看得到真實順序所以是準的，只有影子要猜，於是偏誤單向
  // 偏向「這道關卡擋錯了、應該放寬」——而放寬與否正是靠這個數字決定的。
  //
  // 主軌跡仍用 optimistic：既有 shadow_trades 都是那個假設累積的，換掉會讓
  // 新舊資料混在同一個統計裡而看不出來。悲觀軌跡另存欄位、可選，舊資料
  // 沒有這些欄位時漏斗端會標示「樣本不足」而不是拿 0 當數字。
  if (!st.pessDone) {
    const pess = walkTpSl(candles, st.filledAt, levels, !!st.pessTp1Hit, 'pessimistic');
    st.pessTp1Hit = pess.tp1Hit;
    if (pess.done) {
      st.pessDone = true;
      st.pessResult = pess.result;
      st.pessExitPrice = pess.exitPrice;
    }
  }

  const outcome = walkTpSl(candles, st.filledAt, levels, !!st.tp1Hit);
  st.tp1Hit = outcome.tp1Hit;
  if (outcome.done) {
    st.status = 'done';
    st.result = outcome.result;
    st.exitPrice = outcome.exitPrice;
    st.closedAt = outcome.closedAt;
    // 樂觀軌跡先結束、悲觀還開著（例如一路沒碰過 SL 就直接 TP2）——那代表
    // 兩邊其實同結果，收斂過去，不要留一個永遠不結案的空欄位。
    if (!st.pessDone) {
      st.pessDone = true;
      st.pessResult = outcome.result;
      st.pessExitPrice = outcome.exitPrice;
    }
    return;
  }
  if (now - st.filledAt > activeMs) {
    const lastC  = candles[candles.length - 1];
    st.status    = 'done';
    st.result    = st.tp1Hit ? 'WIN_TP1' : 'TIMEOUT';
    st.exitPrice = st.tp1Hit ? st.tp1 : lastC?.close;
    st.closedAt  = now;
    if (!st.pessDone) {
      st.pessDone = true;
      st.pessResult = st.pessTp1Hit ? 'WIN_TP1' : 'TIMEOUT';
      st.pessExitPrice = st.pessTp1Hit ? st.tp1 : lastC?.close;
    }
  }
}

async function processShadowTrades(newCandidates: ShadowTrade[]): Promise<void> {
  const r = getRedis();
  if (!r) return; // simulation needs persistence
  try {
    const raw = (await r.hgetall<Record<string, unknown>>('shadow_trades')) ?? {};
    const shadows = new Map<string, ShadowTrade>();
    for (const [id, v] of Object.entries(raw)) {
      try {
        const st = (typeof v === 'string' ? JSON.parse(v) : v) as ShadowTrade;
        if (st && st.symbol && st.status) shadows.set(id, st);
      } catch { /* drop malformed entry */ }
    }

    const writes: Record<string, string> = {};

    // Merge new candidates — one live shadow per symbol+direction (a persistent
    // reject would otherwise add a duplicate every 5-minute scan)
    const liveKeys = new Set(
      Array.from(shadows.values()).filter(s => s.status !== 'done').map(s => `${s.symbol}:${s.direction}`),
    );
    for (const c of newCandidates) {
      if (shadows.size >= SHADOW_MAX) break;
      const key = `${c.symbol}:${c.direction}`;
      if (liveKeys.has(key)) continue;
      liveKeys.add(key);
      shadows.set(c.id, c);
      writes[c.id] = JSON.stringify(c);
    }

    // Advance live shadows — one candle fetch per symbol, capped per run.
    // Merging new candidates (above) stays every scan; only the advance is
    // throttled, since it resolves against 1h candles (see claimPeriodicSlot).
    const now  = Date.now();
    if (await claimPeriodicSlot('shadow-advance', SHADOW_ADVANCE_PERIOD_SEC)) {
      const live = Array.from(shadows.values()).filter(s => s.status !== 'done');
      const bySymbol = new Map<string, ShadowTrade[]>();
      live.forEach(s => {
        const arr = bySymbol.get(s.symbol) ?? [];
        arr.push(s);
        bySymbol.set(s.symbol, arr);
      });

      let fetches = 0;
      for (const [symbol, group] of Array.from(bySymbol.entries())) {
        if (fetches >= 8) break; // rest advance next slot
        fetches++;
        let candles: Candle[] = [];
        try { candles = await fetchCandles(symbol, '1h', 96); } catch { continue; }
        for (const st of group) {
          simulateShadow(st, candles, now);
          st.lastCheckedAt = now;
          writes[st.id] = JSON.stringify(st);
        }
      }
    }

    // Prune done shadows past the 14-day analysis window
    const toDelete: string[] = [];
    for (const [id, st] of Array.from(shadows.entries())) {
      if (st.status === 'done' && now - (st.closedAt ?? st.at) > 14 * 24 * 3600 * 1000) toDelete.push(id);
    }

    if (Object.keys(writes).length > 0) await r.hset('shadow_trades', writes);
    if (toDelete.length > 0) await r.hdel('shadow_trades', ...toDelete);
    await r.expire('shadow_trades', 14 * 24 * 3600);
  } catch (e) {
    console.error('[shadow] simulation failed:', String(e).slice(0, 200));
  }
}

// ── §2.3 BTC regime (fetched once per cron run) ───────────────
interface BtcRegimeState {
  regime: 'bullish' | 'bearish' | 'chaotic';
  longPaused:  boolean; // BTC 1H abnormal drop → pause altcoin LONG signals 2h
  shortPaused: boolean; // BTC 1H abnormal pump → pause altcoin SHORT signals 2h
  movePct?: number;     // BTC 1H 4-candle cumulative move (diagnostics)
  moveThresholdPct?: number; // trigger threshold = 2.5 × ATR(14,1H) as % (diagnostics)
}
// In-memory pause fallback when Redis is absent (lost on cold start — acceptable)
const memBtcPause = { long: 0, short: 0 };
const BTC_PAUSE_MS = 2 * 3600 * 1000; // v2.1 §1.1: pause 2h (was 4h)

async function fetchBtcRegime(): Promise<BtcRegimeState> {
  const state: BtcRegimeState = { regime: 'chaotic', longPaused: false, shortPaused: false };
  try {
    const [btc4h, btc1h] = await Promise.all([
      // Cached for the same reason as the per-symbol 4H series — 250 bars that
      // only change every 4 hours, re-parsed every minute otherwise.
      fetchCandlesCached('BTCUSDT', '4h', 250),
      fetchCandles('BTCUSDT', '1h', 20), // 20 bars → enough for ATR(14)
    ]);
    // Only EMA50/EMA200 needed for regime — skip full indicator compute
    const btcClose  = btc4h[btc4h.length - 1].close;
    const btcCloses = btc4h.map(c => c.close);
    const e50Arr    = calcEma(btcCloses, 50);
    const e200Arr   = calcEma(btcCloses, 200);
    const ema50  = e50Arr[e50Arr.length - 1]   ?? NaN;
    const ema200 = e200Arr[e200Arr.length - 1] ?? NaN;
    if (!isNaN(ema50) && !isNaN(ema200)) {
      if (ema50 > ema200 && btcClose > ema50)      state.regime = 'bullish';
      else if (ema50 < ema200 && btcClose < ema50) state.regime = 'bearish';
    }

    // v2.1 §1.1: fixed ±1.5% trigger → 2.5×ATR(14,1H) relative threshold.
    // Fixed 1.5% fired constantly in crypto vol; ATR-relative only flags ABNORMAL moves.
    const last4 = btc1h.slice(-4);
    const btcChange = (last4[last4.length - 1].close - last4[0].close) / last4[0].close;
    let atr1h = 0;
    for (let i = Math.max(1, btc1h.length - 14); i < btc1h.length; i++) {
      const h = btc1h[i].high, l = btc1h[i].low, pc = btc1h[i - 1].close;
      atr1h += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }
    atr1h /= Math.min(14, btc1h.length - 1);
    const lastPx    = btc1h[btc1h.length - 1].close;
    const threshold = lastPx > 0 ? (2.5 * atr1h) / lastPx : 0.0375; // fallback ≈ legacy behaviour
    state.movePct          = parseFloat((btcChange * 100).toFixed(2));
    state.moveThresholdPct = parseFloat((threshold * 100).toFixed(2));

    const r = getRedis();
    const now = Date.now();
    if (btcChange < -threshold) {
      state.longPaused = true;
      memBtcPause.long = now;
      if (r) { try { await r.set('btc_pause:LONG', `${state.movePct}%`, { ex: BTC_PAUSE_MS / 1000 }); } catch { /* mem fallback holds */ } }
    }
    if (btcChange > threshold) {
      state.shortPaused = true;
      memBtcPause.short = now;
      if (r) { try { await r.set('btc_pause:SHORT', `${state.movePct}%`, { ex: BTC_PAUSE_MS / 1000 }); } catch { /* mem fallback holds */ } }
    }
    // Pause persists 2h from the trigger even after the move rolls out of the window
    if (!state.longPaused || !state.shortPaused) {
      if (r) {
        try {
          const [pl, ps] = await Promise.all([r.get('btc_pause:LONG'), r.get('btc_pause:SHORT')]);
          if (pl) state.longPaused  = true;
          if (ps) state.shortPaused = true;
        } catch { /* fall through to memory */ }
      }
      if (now - memBtcPause.long  < BTC_PAUSE_MS) state.longPaused  = true;
      if (now - memBtcPause.short < BTC_PAUSE_MS) state.shortPaused = true;
    }
  } catch { /* use defaults */ }
  return state;
}

// ── GET — run analysis + send LINE ────────────────────────────
export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // ── Scan run-lock: serialize the whole scan+insert so a double-fired cron
  // (retry / misconfigured schedule) can't run two concurrent scans that each
  // insert the same symbol — the root cause of duplicate open trades. NX+70s
  // (> maxDuration 60s) auto-expires even if the function is killed; the normal
  // 5-min cadence is unaffected. Skipped when Redis isn't wired (single-runner).
  {
    const rScan = getRedis();
    if (rScan) {
      try {
        const got = await rScan.set('scan-run-lock', Date.now(), { nx: true, ex: 70 });
        if (!got) {
          return NextResponse.json({ ok: true, skipped: 'scan already running (lock held)' });
        }
      } catch { /* Redis error — proceed without the lock rather than block scans */ }
    }
  }

  const coinsParam = req.nextUrl.searchParams.get('coins') ?? process.env.WATCH_COINS ?? '';
  const tfParam    = process.env.ANALYSIS_TIMEFRAMES ?? '5m,15m,1h';
  const minScore   = parseInt(process.env.MIN_SCORE ?? '5', 10);

  // Resolved Supabase profile UUID — used for trade insert + Web Push subscription lookup.
  // SUPABASE_PROFILE_ID env var is a direct override (single-user system, no per-request
  // auth on this endpoint to derive it from).
  let profileId = '';
  // Account settings synced from the app (profiles.settings JSONB) — drives the
  // position/margin/leverage line in notifications. Defaults match the store.
  let acctSize    = 1000;
  let acctRiskPct = 1;
  let muteCancelPush = false;
  // 2026-08-17：這個使用者有沒有開 live-runner——插入新推薦單時要用，見下面
  // insertData 的 status 欄位註解。跟 monitor 階段排除 live 使用者是同一個
  // profiles.live_trading_enabled 欄位，這裡不查心跳（跟監控排除不同，這裡
  // 只是決定初始 status 該不該樂觀當作已成交，不是決定誰該處理這筆單）。
  let isLiveTradingUser = false;
  {
    const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL  || '';
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (sbUrl && sbKey && process.env.SUPABASE_PROFILE_ID) {
      profileId = process.env.SUPABASE_PROFILE_ID;
      try {
        const { createClient: mkProfileAdmin } = await import('@supabase/supabase-js');
        const profileAdmin = mkProfileAdmin(sbUrl, sbKey, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        const { data: sp } = await profileAdmin
          .from('profiles').select('settings,live_trading_enabled').eq('id', profileId).maybeSingle();
        const st = sp?.settings as { accountSize?: number; riskPctPerTrade?: number; muteCancelPush?: boolean } | null;
        if (st?.accountSize && st.accountSize > 0)         acctSize    = st.accountSize;
        if (st?.muteCancelPush)                            muteCancelPush = true;
        if (st?.riskPctPerTrade && st.riskPctPerTrade > 0) acctRiskPct = st.riskPctPerTrade;
        isLiveTradingUser = sp?.live_trading_enabled === true;
      } catch (e) {
        console.error('[analyze] profile settings lookup threw:', String(e));
      }
    }
    if (!profileId) {
      console.warn('[analyze] profileId is empty — trades will NOT be inserted. ' +
        'Set SUPABASE_PROFILE_ID env var in Vercel.');
    }
  }

  const coins: string[] = coinsParam
    ? coinsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    : await getDefaultCoins();

  const timeframes = tfParam.split(',').map(s => s.trim()) as Timeframe[];
  // Entry timeframe: multi-TF analysis confirms direction; only this TF produces the entry/TP/SL.
  // Override via ENTRY_TIMEFRAME env var; default 1h (the faster TF in a 4h+1h setup).
  const entryTf    = (process.env.ENTRY_TIMEFRAME ?? '1h').trim() as Timeframe;
  const usingRedis = !!getRedis();

  interface ScanResult {
    symbol: string;
    signalCount: number;
    topScore: number;
    rawTopScore?: number;
    topSignal: { direction: string; strength: string; score: number; entry: number; confidence?: number; fundingRate?: number } | null;
    locked: boolean;
    confluenceMet?: boolean;
    agreeTFs?: number;
    tfsAnalyzed?: string[];
    regime?: string;
    btcRegime?: string;
    adx4h?: number | null;
    atrPercentile?: number;
    suggestedRiskPct?: number;
    fundingRate?: number;
    event_filter_active?: boolean;
    note?: string;
    error?: string;
  }

  // docs/TODO.md P2 #5 — everything the deferred same_dir_cap/insert/funnel/
  // results logic needs, snapshotted per-symbol before deferring to pass 2.
  interface PendingCandidate {
    symbol: string;
    entrySignal: TradingSignal;
    isScalp: boolean;
    strong: TradingSignal[];
    topScore: number;
    rawTopScore: number;
    locked: boolean;
    confluenceMet: boolean;
    agreeTFs: number;
    tfsAnalyzed: string[];
    symbolRegime: Regime;
    symbolAdx: number;
    symbolAtrPct: number;
    suggestedRiskPct: number;
    symbolFundingRate: number;
    stratBPaused: boolean;
    entryTfBias: 'LONG' | 'SHORT' | null;
  }

  const results: ScanResult[] = [];
  const notified: string[] = [];
  // v2.1 §0: reject funnel — one record per candidate signal, sent or not
  const funnelEntries: Array<Record<string, unknown>> = [];
  // Rejected candidates with concrete levels → simulated as shadow trades
  const shadowCandidates: ShadowTrade[] = [];
  // docs/TODO.md P2 #5: candidates that cleared every per-symbol gate (locked/
  // cooldown/confluence/no_entry_tf/btc_direction/btc_chaos/btc_pause/
  // loss_cooldown/bias_hold) and are genuine contenders for the shared same-direction risk
  // budget. Scan order is by trading volume rank — first-come-first-served on
  // a scarce resource is the worst allocation rule. Deferred here so ALL of
  // this cycle's candidates are known before same_dir_cap decides who gets the
  // slot; resolved in score-descending order after the main loop (below).
  const pendingCandidates: PendingCandidate[] = [];

  // §2.3 BTC regime — fetch once, apply to all altcoin signals
  const btcState = await fetchBtcRegime();

  // v2.1 §1.2: ADX hysteresis state — one hash for all symbols (1 read/scan).
  // Cross above 23 → trending until below 18; below 18 → ranging until above 23.
  // 18-23 without prior state (fresh symbol) = transitional (no signals).
  let adxStates: Record<string, string> = {};
  {
    const rAdx = getRedis();
    if (rAdx) {
      try { adxStates = (await rAdx.hgetall<Record<string, string>>('adx_states')) ?? {}; } catch { /* empty */ }
    }
  }
  const adxStateChanges: Record<string, string> = {};

  // §4.4 Circuit breaker — check once per cron run
  const breaker = profileId ? await checkCircuitBreaker(profileId, acctRiskPct) : { triggered: false };

  // 跨日權益回撤上限 — 熔斷只看當日，這個看整條權益曲線的高點回撤（2026-08-04）
  const drawdown = profileId ? await checkDrawdownHalt(profileId) : { halted: false };

  // Phase 5: total open risk — check once per cron run; blocks all new signals when cap is hit
  const totalOpenRisk = profileId ? await checkTotalOpenRisk(profileId) : 0;

  // Phase 6: event filter — blocks new signals ±30 min around scheduled events
  const eventFilter = await checkEventFilter();

  for (const symbol of coins) {
    const allSignals: TradingSignal[] = [];
    let topScore  = 0;
    let rawTopScore = 0; // best pre-gate score — shows near-misses in scan status
    let entryTfBias: 'LONG' | 'SHORT' | null = null; // entry TF's 4H EMA200 direction
    // 2026-08-18（docs/TODO.md P2 #7）：進場時框那個「只差分數」的候選＋價位，
    // 給 score_gate 影子模擬用。沒有被分數擋就維持 undefined。
    let scoreGateRejected: RejectedCandidate | undefined;

    try {
      // (Removed: a fetchTicker24h(symbol) whose result was discarded. Present
      // since the initial commit, it cost one round trip per symbol per scan —
      // 15 wasted requests every minute — and fed nothing.)

      // Candle cache so HTF candles are fetched only once even if reused across TFs
      const candleCache = new Map<string, Candle[]>();

      // ── Regime determination from 4H ADX (once per symbol) ─────
      // NOTE: the 540-bar 4H series comes from fetchCandlesCached — it re-fetches
      // only the last few bars and splices them onto the previous run's array.
      // That cut the fetch/parse cost, but calcAdx/calcAtrHistory are Wilder
      // recursions that still re-ran over the full 540-bar window every single
      // scan regardless of where the array came from — the cache never touched
      // that cost, which turned out to be the actual dominant one (2026-07-30:
      // measured no real reduction in Vercel Fluid Active CPU from candle
      // caching alone). A 4H bar only changes every 4 hours; this scan runs
      // every minute. `regimeCache` memoizes the computed adx/atrPct against the
      // newest bar's openTime, so the expensive part below only actually runs
      // once per 4h window instead of ~240 times — see regimeCache.ts for why
      // this is memoization of the full computation rather than a truly
      // incremental recursion (same CPU win, none of the drift risk).
      // v2.1 §1.2 hysteresis: ADX ≥23 → trending (until ≤18); ≤18 → ranging
      // (until ≥23); 18-23 holds the previous state — transitional only when
      // a symbol has no prior state (initialization).
      // When 4H fetch fails, regimeDetermined stays false → fallback to Strategy A.
      let symbolRegime: Regime = 'ranging';
      let symbolAdx    = NaN;
      let regimeDetermined = false;
      let symbolAtrPct = 50; // default: mid-volatility
      let fourHC: Candle[] | undefined;
      let cacheHit: RegimeCacheEntry | undefined;
      try {
        // 540 bars = 90 days of 4H candles — enough for ADX regime + 90-day ATR percentile
        if (!candleCache.has('4h')) candleCache.set('4h', await fetchCandlesCached(symbol, '4h', 540));
        fourHC = candleCache.get('4h')!;
        const cached = getRegimeCache(symbol);
        if (is4hBarUnchanged(cached, fourHC)) cacheHit = cached;

        // Only ADX is needed here — computing full indicators (EMA200/MACD/BB/…)
        // over 540 bars every scan was already trimmed in an earlier pass;
        // cacheHit trims the ADX calc itself down to once per 4H bar.
        symbolAdx = cacheHit ? cacheHit.adx : (calcAdx(fourHC, 14).adx ?? NaN);
        if (!isNaN(symbolAdx)) {
          regimeDetermined = true;
          if (symbolAdx >= 23)      symbolRegime = 'trending';
          else if (symbolAdx <= 18) symbolRegime = 'ranging';
          else {
            const prev = adxStates[symbol];
            symbolRegime = prev === 'trending' || prev === 'ranging' ? (prev as Regime) : 'transitional';
          }
          // Record state transitions (batched into one hset after the loop)
          if ((symbolRegime === 'trending' || symbolRegime === 'ranging') && adxStates[symbol] !== symbolRegime) {
            adxStateChanges[symbol] = symbolRegime;
            adxStates[symbol]       = symbolRegime;
          }
        }
      } catch { /* keep 'ranging' / regimeDetermined=false — Strategy A fallback */ }

      // ── Phase 5: 90-day ATR percentile → suggested position sizing ──
      // Uses the 540-bar 4H cache already populated above. Separate try/catch
      // from the ADX block on purpose (unchanged from before this cache): a
      // failure here must not lose an already-determined regime, and vice versa.
      try {
        if (cacheHit) {
          symbolAtrPct = cacheHit.atrPct;
        } else if (fourHC && fourHC.length >= 30) {
          const atrHistory = calcAtrHistory(fourHC);
          if (atrHistory.length >= 2) {
            const currentAtr4h = atrHistory[atrHistory.length - 1];
            symbolAtrPct = calcAtrPercentile(currentAtr4h, atrHistory.slice(0, -1));
          }
        }
      } catch { /* keep default 50 */ }

      // Memoize once both values are known from a fresh computation. Skipped
      // entirely on a cache hit (nothing changed, no point rewriting the same
      // entry) and when ADX came back NaN (not enough bars yet — let the next
      // scan retry the full computation rather than caching a non-value).
      if (!cacheHit && fourHC && fourHC.length > 0 && !isNaN(symbolAdx)) {
        setRegimeCache(symbol, { lastBarOpenTime: fourHC[fourHC.length - 1].openTime, adx: symbolAdx, atrPct: symbolAtrPct });
      }

      // >80th pct = high volatility → smaller risk; <30th = low vol → larger risk
      const suggestedRiskPct = symbolAtrPct > 80 ? 0.5 : symbolAtrPct < 30 ? 1.5 : 1.0;

      // ── Strategy B consecutive-loss pause check ──────────────
      let stratBPaused = false;
      if (symbolRegime === 'ranging' && regimeDetermined) {
        stratBPaused = await checkStratBPaused(symbol);
      }

      // ── Regime-based signal generation dispatch ───────────────
      // transitional → nothing | ranging+determined → Strategy B | else → Strategy A
      if (symbolRegime === 'transitional') {
        // ADX 20-25: no new signals; regime/adx4h will surface this in results
      } else if (symbolRegime === 'ranging' && regimeDetermined && !stratBPaused) {
        // Strategy B: mean reversion on entry TF only (BB + RSI crossover)
        try {
          if (!candleCache.has(entryTf)) candleCache.set(entryTf, await fetchCandles(symbol, entryTf, 200));
          const candles = candleCache.get(entryTf)!;
          const sigs    = generateMeanReversionSignals(symbol, entryTf, candles);
          allSignals.push(...sigs);
          sigs.forEach(s => { if (s.score > topScore) topScore = s.score; });
        } catch { /* skip */ }
      } else {
        // Strategy A: multi-TF loop (trending, or paused-B, or regime-fetch-failed → safe fallback)
        for (const tf of timeframes) {
          try {
            if (!candleCache.has(tf)) candleCache.set(tf, await fetchCandles(symbol, tf, 200));
            const candles = candleCache.get(tf)!;

            // HTF bias: fetch higher TF once (cached), compute EMA200 direction
            let htfBias: 'LONG' | 'SHORT' | null = null;
            const htfTf = HTF_MAP[tf as Timeframe];
            if (htfTf) {
              try {
                if (!candleCache.has(htfTf)) candleCache.set(htfTf, await fetchCandles(symbol, htfTf, 250));
                const htfC   = candleCache.get(htfTf)!;
                const htfPx  = htfC[htfC.length - 1].close;
                // Only EMA200 is needed for HTF bias — skip the full indicator set
                const htfCloses = htfC.map(c => c.close);
                const e200Arr   = calcEma(htfCloses, 200);
                const e200      = e200Arr[e200Arr.length - 1];
                if (!isNaN(e200) && e200 > 0) {
                  const near = Math.abs(htfPx - e200) / e200 < 0.015;
                  if (!near) htfBias = htfPx > e200 ? 'LONG' : 'SHORT';
                }
              } catch { /* no bias if HTF unavailable */ }
            }
            // Remember the entry TF's higher-timeframe bias — it acts as the
            // second confluence confirmation (§3-A: 4H judges direction, 1H enters).
            if (tf === entryTf) entryTfBias = htfBias;

            // 2026-08-04（docs/ANALYSIS-2026-08-04B §3.1）：訊號只有在這個 tf
            // 真的收出新K線時才會變，但掃描每 5 分鐘跑一次——15m 每輪重算 3
            // 次、1h 每輪重算 12 次，全是白工。跟 regimeCache 同一套memoize
            // 哲學：快取「完整計算結果」，輸入（K線收盤時間/htfBias/regime）
            // 一有變動就整個重算，不做增量遞推。htfBias/regime 都納入命中
            // 判斷是必要的，不只是保險——一般情況下標準時框邊界是巢狀的
            // （4H收線必然也是1H/15m/5m收線），tf 自己的K線沒變就代表
            // htfBias/regime 的來源時框也不可能變；唯一打破這個保證的是
            // regime 抓取失敗時的預設值（跟K線邊界無關的獨立事件），所以
            // 兩者都要明確比對，不能只靠邊界巢狀這個假設。
            const cachedSig = getSignalCache(symbol, tf);
            let sigs: TradingSignal[];
            let dbgLong = 0, dbgShort = 0;
            let dbgRejected: RejectedCandidate | undefined;
            if (isSignalCacheHit(cachedSig, candles, htfBias, symbolRegime)) {
              sigs = freshenCachedSignals(cachedSig!.signals);
              dbgLong = cachedSig!.dbgLong;
              dbgShort = cachedSig!.dbgShort;
              dbgRejected = cachedSig!.rejected;
            } else {
              const dbg: { long?: number; short?: number; rejected?: RejectedCandidate } = {};
              sigs = generateSignals(symbol, tf, candles, htfBias, symbolRegime, dbg);
              dbgLong = dbg.long ?? 0;
              dbgShort = dbg.short ?? 0;
              dbgRejected = dbg.rejected;
              if (candles.length > 0) {
                setSignalCache(symbol, tf, {
                  lastBarOpenTime: candles[candles.length - 1].openTime,
                  htfBias, regime: symbolRegime,
                  signals: cloneSignals(sigs), dbgLong, dbgShort, rejected: dbgRejected,
                });
              }
            }
            rawTopScore = Math.max(rawTopScore, dbgLong, dbgShort);
            // 2026-08-18（docs/TODO.md P2 #7）：只留進場時框那一個被擋候選。
            // 其他時框的價位不是真的會拿來下單的那組（進場價/止損都是照
            // entryTf 算的，見 §3-A「4H 判方向、1H 進場」），拿它們去模擬會
            // 量到一個系統從來不會執行的策略。
            if (tf === entryTf && dbgRejected) scoreGateRejected = dbgRejected;
            allSignals.push(...sigs);
            sigs.forEach(s => { if (s.score > topScore) topScore = s.score; });
          } catch { /* skip failed timeframe */ }
        }
      }

      // ── Phase 4: Fetch funding rate (cached 10min) ───────────
      const symbolFundingRate = await fetchFundingRate(symbol).catch(() => 0);

      // Direction unification: highest TF's direction is master, drop conflicting signals
      const unified    = unifySignalDirection(allSignals);
      // 2026-08-10：funding rate 擁擠扣分要在這裡（STRONG_THRESHOLD 篩選之前）
      // 套用，扣完的分數才是真正決定放不放行的依據——跟 computeConfidence
      // 那個純顯示用的欄位是兩回事，見 applyFundingRateCrowdingPenalty 說明。
      unified.forEach(s => { s.score = applyFundingRateCrowdingPenalty(s.score, s.direction, symbolFundingRate); });
      const strong     = unified.filter(s => s.score >= minScore).sort((a, b) => b.score - a.score);
      const topStrong  = strong.find(isStrongEnough);
      // Entry signal: only from the designated entry TF. Multi-TF confluence confirms direction;
      // this signal's entry/TP/SL are what get pushed to LINE and inserted into DB.
      let entrySignal = strong.find(s => isStrongEnough(s) && s.timeframe === entryTf);

      // Multi-TF confluence gate ─────────────────────────────────
      // Confirmed by either: (a) ≥2 TFs independently producing same-direction
      // signals, or (b) entry-TF signal aligned with its 4H EMA200 bias —
      // §3-A's design is exactly "4H judges direction, 1H finds entry", so a
      // full independent 4H signal is NOT required for confluence.
      const longTFSet  = new Set(allSignals.filter(s => s.direction === 'LONG').map(s => s.timeframe));
      const shortTFSet = new Set(allSignals.filter(s => s.direction === 'SHORT').map(s => s.timeframe));
      const masterDir  = topStrong?.direction ?? null;
      const agreeTFs   = masterDir === 'LONG' ? longTFSet.size
                       : masterDir === 'SHORT' ? shortTFSet.size : 0;
      const biasConfirmed  = !!masterDir && entryTfBias === masterDir;
      // Strategy B is single-TF by design (BB+RSI confirmation is its own confluence)
      const isStratBSignal = allSignals.some(s => s.strategy === 'B');
      // 2026-08-10：reject-funnel 影子模擬顯示這關淨R +10.39（42筆候選，6勝
      // 6負30到期1追蹤中）——擋掉的候選人如果放行，淨值是正的，代表擋太嚴。
      // 抽樣看實際擋單明細：卡住的幾乎都是 agreeTFs=1（entry TF 自己撐著，
      // 沒有其他時框佐證）且 entryTfBias 是「中性」（4H 沒有明確方向意見，
      // biasConfirmed 這條路完全走不通）——這種情況下唯一活路只剩
      // agreeTFs>=2，門檻比 §3-A 原意「4H 判方向、1H 找進場點」還嚴，因為
      // 4H 中性代表大盤沒表態，不是「反對」。
      //
      // 只放寬這個具體缺口：4H 中性 + entry TF 自己撐著方向，就算過關。
      // 4H 有明確方向但跟 entry 訊號衝突（逆勢單）維持原樣擋下——那是不同
      // 風險等級，這次沒有數據佐證放寬它，CLAUDE.md 調參紀律：一次只動
      // 一個缺口，不夠確定就先不動。
      const confluenceMet  = agreeTFs >= 2 || biasConfirmed || isStratBSignal
                            || (entryTfBias === null && agreeTFs >= 1);

      // ⚡短線 channel: a 15m signal at normal tier thresholds whose direction
      // matches the 4H bias becomes a scalp order when the entry TF (1h) has
      // no qualifying signal. 15m already passes the intraday hard gates
      // (candle-pattern confirmation + structure alignment); tight 15m stops
      // give larger notional at the same risk — the "small account compounding"
      // mechanic without raising risk per trade.
      let isScalp = false;
      if (!entrySignal && biasConfirmed) {
        const scalpSig = strong.find(s =>
          s.timeframe === '15m' &&
          isStrongEnough(s) &&
          s.direction === entryTfBias &&
          s.strategy !== 'B');
        if (scalpSig) {
          entrySignal = scalpSig;
          isScalp = true;
          scalpSig.reasons.push('⚡ 短線單：15m 訊號 + 4H 順向確認，適合快進快出');
        }
      }

      // Entry-TF fallback: an exceptional intraday signal (≥ threshold+10) whose
      // direction matches the 4H bias may substitute when the entry TF itself
      // has no qualifying signal — strong trends often move too fast for 1H
      // to score before the entry window closes.
      if (!entrySignal && biasConfirmed) {
        entrySignal = strong.find(s =>
          isStrongEnough(s) &&
          s.score >= STRONG_THRESHOLD + 10 &&
          s.direction === entryTfBias &&
          s.strategy !== 'B');
      }

      // 2026-08-11：拒絕漏斗診斷後續 #1——cancel_tp1_direct/cancel_ran_away
      // 影子模擬顯示死等 EMA20 回調常常等不到、錯過整段行情。詳細說明見
      // src/lib/marketEntryException.ts 頂部註解。門檻沿用上面
      // Entry-TF fallback 已經在用的同一個 margin，不是另外發明的數字。
      if (entrySignal && shouldEnterAtMarket(entrySignal, STRONG_THRESHOLD + 10, biasConfirmed)) {
        const shifted = shiftSignalToMarketEntry(entrySignal);
        entrySignal.entry = shifted.entry;
        entrySignal.stopLoss = shifted.stopLoss;
        entrySignal.takeProfits = shifted.takeProfits;
        entrySignal.reasons.push(
          `⚡ 訊號夠強+4H確認，直接以市價 $${fmtPrice(shifted.entry)} 進場，不等回調（原設計進場 $${fmtPrice(shifted.originalEntry)}）`,
        );
      }

      // ── Phase 4+5: Annotate unified signals with fundingRate, confidence, position sizing ──
      // confidence and suggestedRiskPct/Leverage are informational; gate stays score-based.
      unified.forEach(s => {
        s.fundingRate = symbolFundingRate;
        s.confidence  = computeConfidence(s, symbolAdx, symbolFundingRate, agreeTFs);
        // v2.1 §2: tier B = half risk (0.5%) and leverage ≤5x regardless of ATR percentile
        const tierRisk = s.tier === 'B' ? 0.5 : suggestedRiskPct;
        s.suggestedRiskPct = tierRisk;
        const slDist = s.entry > 0 ? Math.abs(s.entry - s.stopLoss) / s.entry : 0;
        const lev = slDist > 0
          ? Math.min(Math.round((tierRisk / 100 / slDist) * 10) / 10, 10)
          : 1;
        s.suggestedLeverage = s.tier === 'B' ? Math.min(lev, 5) : lev;
      });

      // 2026-08-10：CPU 精省——OI（未平倉合約）查詢原本對 unified 裡每個
      // 候選訊號都查一次（每個 symbol 每個時框都可能各自產生候選），但大
      // 部分候選最後會被後面的濾網（locked/cooldown/confluence/risk cap
      // 等）擋掉，使用者根本看不到，查了也是白查。Vercel Hobby 免費方案
      // 的 CPU 額度被打爆（Fluid Active CPU 4h13m/4h，導致 Phase 1/2 監控
      // 迴圈的推播來不及執行——使用者反映「掛單成交/TP1/移動止損/最終
      // 出場通知全部收不到，只有新訊號通知還在」，查證是這個），這裡改成
      // 只在確定 entrySignal 存在（真的可能要 insert/推播）才查一次，只
      // 加進這一個訊號的 reasons，不是每個候選都查。這個 symbol 之後仍可
      // 能被其他 gate 擋掉不真的 insert，還不是最緊的做法，但已經把查詢
      // 量從「每個候選」降到「每個 symbol 最多一次」，先觀察 CPU 用量再
      // 決定要不要收得更緊。
      if (entrySignal) {
        const oiChangePct = await fetchOpenInterestChange(symbol).catch(() => null);
        if (oiChangePct !== null) {
          const drift = oiChangePct > 5 ? '，疑似新資金進場' : oiChangePct < -5 ? '，疑似減倉/回補' : '';
          entrySignal.reasons.push(`OI(未平倉合約) 4h變化 ${oiChangePct >= 0 ? '+' : ''}${oiChangePct.toFixed(1)}%${drift}`);
        }
      }

      // Read lock from Redis (persistent across cold starts)
      const last      = await getLock(symbol);
      const nowBucket = current4hBucket();
      const now       = Date.now();

      const locked     = !!last && last.locked;
      const sameCandle = !!last && !locked && last.candleBucket === nowBucket && last.direction === topStrong?.direction;
      const onCooldown = !!last && !locked && (now - last.sentAt) < COOLDOWN_MS;

      let skipReason: string | undefined;
      let skipKey:    string | undefined; // v2.1 §0: machine-readable gate id for the reject funnel
      // docs/TODO.md P2 #5: true once this candidate is parked for pass-2 same_dir_cap
      // resolution — its funnel/results entries and insert are built in pass 2 instead.
      let deferredToPass2 = false;

      // Phase 6: event filter (global; checked before per-symbol risk gates)
      if (eventFilter.active)
        { skipKey = 'event_filter';   skipReason = eventFilter.reason ?? '事件過濾中，暫停新訊號'; }
      // §4.4 Circuit breaker (global; set once before loop, checked per signal)
      else if (breaker.triggered)
        { skipKey = 'circuit_breaker'; skipReason = `熔斷 — ${breaker.reason}`; }
      // 跨日權益回撤上限（2026-08-04）——排在熔斷之後：熔斷是當日急性事件、
      // 回撤是跨日慢性失血，兩者互補。刻意排在 total_risk_cap 之前，因為
      // 「策略可能已經失效」比「倉位滿了」更該優先讓使用者看到。
      else if (drawdown.halted)
        { skipKey = 'drawdown_halt'; skipReason = `回撤停機 — ${drawdown.reason}`; }
      else if (totalOpenRisk >= MAX_TOTAL_RISK_PCT)
        { skipKey = 'total_risk_cap'; skipReason = `跳過 — 持倉風險評分 ${totalOpenRisk.toFixed(1)} 已達上限 ${MAX_TOTAL_RISK_PCT}（與實際帳戶風險%無關，僅為持倉數量代理值）`; }
      else if (locked)
        { skipKey = 'locked';         skipReason = `跳過 — 持倉中 (${last?.direction})`; }
      else if (sameCandle)
        { skipKey = 'same_candle';    skipReason = `跳過 — 同 4h 蠟燭 (${topStrong?.direction})`; }
      else if (onCooldown && last)
        { skipKey = 'cooldown';       skipReason = `跳過 — 冷卻中 (${Math.round((COOLDOWN_MS - (now - last.sentAt)) / 60000)}min)`; }
      else if (topStrong && !confluenceMet)
        { skipKey = 'confluence';     skipReason = `跳過 — 多框架未確認 (${agreeTFs}/2 TF 同向，4H bias: ${entryTfBias ?? '中性'})`; }
      else if (topStrong && !entrySignal)
        { skipKey = 'no_entry_tf';    skipReason = `跳過 — 進場時區 (${entryTf}) 無合格信號（最高 ${topStrong.score}分@${topStrong.timeframe}，4H bias: ${entryTfBias ?? '中性'}）`; }
      else if (entrySignal) {
        const isLargeCap = symbol === 'BTCUSDT' || symbol === 'ETHUSDT';

        // §2.3 BTC regime filter (altcoins only)
        if (!isLargeCap) {
          // Directional hard-block applies to BOTH strategies — A (trend) and B
          // (mean-reversion). 2026-07-24: strategy B previously bypassed this, so
          // mean-reversion shorts fired into BTC-bullish runs and got instantly
          // stopped out (SOL/PEPE). Fighting the market leader's CLEAR direction is
          // the #1 loss source (shadow data: 逆 BTC 方向 net −1R = correctly blocked).
          if (btcState.regime === 'bullish' && entrySignal.direction === 'SHORT')
            { skipKey = 'btc_direction'; skipReason = `BTC 大盤偏多 — 跳過山寨做空 (${symbol})`; }
          else if (btcState.regime === 'bearish' && entrySignal.direction === 'LONG')
            { skipKey = 'btc_direction'; skipReason = `BTC 大盤偏空 — 跳過山寨做多 (${symbol})`; }
          else if (btcState.regime === 'chaotic' && entrySignal.strategy === 'A')
            // 2026-08-04（docs/ANALYSIS-2026-08-04C-自動化前的策略體檢.md）：
            // v2.1 §1.3 原本混沌區降級（tier B、風險0.5%、槓桿≤5x）而非直接擋。
            // 但降級只改倉位大小，不改 R 倍數——118 筆樣本裡混沌期單扣成本後
            // 平均 −0.007R（信賴區間跨0），非混沌單扣成本後 +0.422R（信賴區間
            // 不跨0，bootstrap 96.8% 勝過成本）。差距不是「倉位下太大」，是
            // 「混沌期進場的訊號本身沒有優勢」——輕倉只是把沒優勢的賭注下小，
            // 不會讓它變有優勢。改成直接跳過，比照 btc_direction 硬擋；納入
            // SHADOW_GATES 讓漏斗持續追蹤，未來樣本若翻案要看得出來。
            { skipKey = 'btc_chaos'; skipReason = `BTC 混沌區 — 跳過山寨 ${symbol}（v2.1策略A訊號無統計優勢，2026-08-04數據）`; }
        }
        if (!skipReason && !isLargeCap) {
          if (entrySignal.direction === 'LONG'  && btcState.longPaused)
            { skipKey = 'btc_pause'; skipReason = `BTC 1H 異常急跌（${btcState.movePct ?? '?'}%，門檻 ±${btcState.moveThresholdPct ?? '?'}%）— ${symbol} 做多暫停 2h`; }
          else if (entrySignal.direction === 'SHORT' && btcState.shortPaused)
            { skipKey = 'btc_pause'; skipReason = `BTC 1H 異常急漲（${btcState.movePct ?? '?'}%，門檻 ±${btcState.moveThresholdPct ?? '?'}%）— ${symbol} 做空暫停 2h`; }
        }

        // 這個 symbol+direction 剛止損（24h，只鎖同向）或剛被時間止損
        // （4h，兩個方向都鎖，見 monitorActiveTrades 的說明）。這裡只看得到
        // 「有沒有冷卻」看不到來源，所以文案不寫死時數與原因。
        if (!skipReason && await isOnLossCooldown(symbol, entrySignal.direction)) {
          skipKey = 'loss_cooldown';
          skipReason = `跳過 — ${symbol} ${entrySignal.direction === 'LONG' ? '做多' : '做空'} 冷卻中（近期止損 24h／時間止損 4h）`;
        }

        // v2.4 §1.2: directional bias hold — after an opportunity-expired cancel,
        // an OPPOSITE-direction signal is downgraded to watch (skipped) until the
        // 12-bar hold lapses. Same-direction signals pass through untouched.
        if (!skipReason) {
          const heldDir = await getBiasHold(symbol);
          if (heldDir && heldDir !== entrySignal.direction) {
            skipKey = 'bias_hold';
            skipReason = `觀察單 — ${symbol} ${heldDir === 'LONG' ? '多頭' : '空頭'} bias 保留中（掛單超時取消，方向未失效），反向訊號不進場`;
          }
        }

        // §4.3 same_dir_cap / hard-stop duplicate check / insert / notify / funnel /
        // results are ALL deferred to pass 2 (docs/TODO.md P2 #5, 名額分配先到先得問題):
        // this candidate has cleared every per-symbol-only gate (btc_direction/pause,
        // loss_cooldown, bias_hold), making it a genuine contender for the shared
        // same-direction risk budget. Resolving that contention here would award the
        // budget by scan order (volume rank) instead of by score — the exact
        // first-come-first-served problem the redesign fixes. Pass 2 (after the main
        // loop) sorts all of this cycle's candidates by score and resolves them in
        // that order instead.
        if (!skipReason) {
          deferredToPass2 = true;
          pendingCandidates.push({
            symbol, entrySignal, isScalp, strong, topScore, rawTopScore, locked, confluenceMet,
            agreeTFs, tfsAnalyzed: timeframes.filter(tf => candleCache.has(tf)),
            symbolRegime, symbolAdx, symbolAtrPct, suggestedRiskPct, symbolFundingRate,
            stratBPaused, entryTfBias,
          });
        }
      }

      // ── Signal gate ── moved to pass 2 (docs/TODO.md P2 #5): a candidate only
      // reaches here with entrySignal set and skipReason still falsy via the
      // deferredToPass2 branch above, so this gate is resolved for every such
      // candidate in score order, not scan order — see the pass-2 loop below.
      // (gateNote — insert-failure note — no longer applies to a pass-1-resolved
      // candidate; pass 2 has its own gateNote for the entries it resolves.)

      // ── v2.1 §0: reject funnel — log every candidate regardless of outcome ──
      // Candidate = any qualifying signal existed OR raw score reached tier-B floor.
      // 55 is deliberately kept BELOW the tier-B floor (raised to 60 on 2026-07-30):
      // 55-59 no longer produces a signal at all, but still gets logged here as
      // score_gate — that count is the only way to measure what the raise costs.
      // Do not "fix" this to match MIN_SCORE_TIER_B or the measurement disappears.
      // !deferredToPass2: a parked candidate's funnel/results entry is built in
      // pass 2 once its same_dir_cap outcome is actually known — building it here
      // would wrongly log it as accepted (notified is still empty at this point
      // for every candidate, deferred or not).
      if (!deferredToPass2 && (topStrong || rawTopScore >= 55)) {
        const signalSent = notified.includes(symbol);
        const rejectedAt = signalSent ? null
          : skipKey            ? skipKey
          : !topStrong         ? 'score_gate'
          : !profileId         ? 'no_profile'
          : 'insert_failed';
        funnelEntries.push({
          at: Date.now(),
          symbol,
          strategy:  topStrong?.strategy ?? 'A',
          direction: topStrong?.direction ?? null,
          rawScore:  Math.max(rawTopScore, topStrong?.score ?? 0),
          tier:      entrySignal?.tier ?? topStrong?.tier ?? null,
          rejectedAt,
          rejectDetail: skipReason
            ?? (rejectedAt === 'score_gate'    ? `原始分 ${rawTopScore} 未達門檻或組數不足`
              : rejectedAt === 'no_profile'    ? 'profileId 未解析，無法寫入 DB'
              : rejectedAt === 'insert_failed' ? 'DB 寫入失敗（見 Vercel logs）'
              : null),
          filters: {
            adx4h:          isNaN(symbolAdx) ? null : parseFloat(symbolAdx.toFixed(1)),
            regime:         symbolRegime,
            btcRegime:      btcState.regime,
            btcMovePct:     btcState.movePct ?? null,
            btcPausedLong:  btcState.longPaused,
            btcPausedShort: btcState.shortPaused,
            agreeTFs,
            entryTfBias,
            totalOpenRisk,
          },
        });

        // Shadow candidate: gate-rejected with concrete levels → simulate outcome
        //
        // 兩種來源，先正規化成同一組欄位再往下走：
        //  1. 有產生完整訊號、但被後面某道關卡擋掉（entrySignal / topStrong）
        //  2. 2026-08-18 新增：連訊號都沒產生，因為分數沒過關（score_gate）——
        //     這種情況 entrySignal/topStrong 都是 null，價位改由 signals.ts 的
        //     debugOut.rejected 帶出來（見 SHADOW_GATES 註解）。tier 一定是
        //     null（定義上就是沒達到任何一級），strategy 固定 'A'（策略B 走
        //     generateMeanReversionSignals，沒有這條路徑），timeframe 用
        //     entryTf（價位就是照它算的）。
        const shadowSrc = entrySignal ?? topStrong;
        const shadowInput = shadowSrc
          ? {
              direction: shadowSrc.direction,
              timeframe: shadowSrc.timeframe as string,
              entry: shadowSrc.entry,
              stopLoss: shadowSrc.stopLoss,
              tp1: shadowSrc.takeProfits[0],
              tp2: shadowSrc.takeProfits[1] ?? shadowSrc.takeProfits[0],
              score: shadowSrc.score,
              tier: shadowSrc.tier ?? null,
              strategy: shadowSrc.strategy ?? 'A',
              signalPrice: shadowSrc.signalPrice ?? 0,
            }
          : rejectedAt === 'score_gate' && scoreGateRejected
            ? {
                direction: scoreGateRejected.direction,
                timeframe: entryTf as string,
                entry: scoreGateRejected.entry,
                stopLoss: scoreGateRejected.stopLoss,
                tp1: scoreGateRejected.tp1,
                tp2: scoreGateRejected.tp2,
                score: scoreGateRejected.score,
                tier: null,
                strategy: 'A',
                signalPrice: scoreGateRejected.signalPrice,
              }
            : null;

        if (rejectedAt && SHADOW_GATES.has(rejectedAt) && shadowInput) {
          const ssp = shadowInput.signalPrice;
          const isLimit = ssp > 0 && Math.abs(shadowInput.entry - ssp) / ssp > 0.003;
          shadowCandidates.push({
            id: `shdw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            at: Date.now(),
            symbol,
            direction: shadowInput.direction,
            timeframe: shadowInput.timeframe,
            entry: shadowInput.entry,
            stopLoss: shadowInput.stopLoss,
            tp1: shadowInput.tp1,
            tp2: shadowInput.tp2,
            score: shadowInput.score,
            tier: shadowInput.tier,
            strategy: shadowInput.strategy,
            rejectedAt,
            signalPrice: ssp,
            status: isLimit ? 'waiting' : 'active',
            ...(isLimit ? {} : { filledAt: Date.now() }),
            lastCheckedAt: Date.now(),
          });
        }
      }

      if (!deferredToPass2) {
        results.push({
          symbol,
          signalCount: strong.length,
          topScore,
          rawTopScore,
          topSignal: strong[0]
            ? { direction: strong[0].direction, strength: strong[0].strength, score: strong[0].score, entry: strong[0].entry, confidence: strong[0].confidence, fundingRate: strong[0].fundingRate }
            : null,
          locked,
          confluenceMet,
          agreeTFs,
          tfsAnalyzed: timeframes.filter(tf => candleCache.has(tf)),
          regime: symbolRegime,
          btcRegime: btcState.regime,
          adx4h: isNaN(symbolAdx) ? null : parseFloat(symbolAdx.toFixed(2)),
          atrPercentile: symbolAtrPct,
          suggestedRiskPct,
          fundingRate: symbolFundingRate,
          event_filter_active: eventFilter.active,
          ...(skipReason   ? { note: skipReason }
            : stratBPaused ? { note: '策略B連虧2筆暫停24h' }
            : {}),
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ symbol, signalCount: 0, topScore, topSignal: null, locked: false, error: msg });
    }

    await delay(300);
  }

  // ── Pass 2: resolve deferred candidates in score order (docs/TODO.md P2 #5) ──
  // Everything from here through the funnel/results entry is the same gate that
  // used to run inline per-symbol in pass 1 (same_dir_cap → hard-stop duplicate
  // check → DB insert → lock/pending-signal → Web Push notify), just resolved
  // for the highest-scoring candidate first instead of whichever symbol the scan
  // happened to reach first by trading-volume rank. checkSameDirectionRisk reads
  // fresh DB state on every call, so a candidate that wins the budget here is
  // correctly "seen" by the next (lower-scoring) candidate's check — same
  // cross-candidate accounting as before, just reordered.
  const sortedCandidates = [...pendingCandidates].sort((a, b) => b.entrySignal.score - a.entrySignal.score);

  for (const cand of sortedCandidates) {
    const { symbol, entrySignal, isScalp } = cand;
    try {
      let skipKey: string | undefined;
      let skipReason: string | undefined;

      // §4.3 Same-direction risk cap（風險加權：A=1%、B=0.5%）
      if (profileId) {
        const sdCheck = await checkSameDirectionRisk(profileId, entrySignal.direction, symbol, entrySignal.tier, acctRiskPct);
        if (sdCheck.block) { skipKey = 'same_dir_cap'; skipReason = `跳過 — ${sdCheck.reason}`; }
      }

      // Hard-stop duplicate check
      if (!skipReason && profileId) {
        const _su = process.env.NEXT_PUBLIC_SUPABASE_URL  || '';
        const _sk = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
        if (_su && _sk) {
          try {
            const { createClient: mkChk } = await import('@supabase/supabase-js');
            const chk = mkChk(_su, _sk, { auth: { autoRefreshToken: false, persistSession: false } });
            // Symbol-global (no user_id filter): single-user system, and legacy
            // rows with NULL user_id must still block — 7/17 saw two overlapping
            // AKE longs slip past the user-scoped version of this check.
            const { count: c } = await chk.from('trades')
              .select('id', { count: 'exact', head: true })
              .eq('symbol', entrySignal.symbol).is('closed_at', null);
            if (c !== null && c > 0)
              { skipKey = 'has_open_position'; skipReason = `跳過 — 同幣種已有持倉 (${symbol})`; }
          } catch (e) {
            skipKey = 'dup_check_error';
            skipReason = `跳過 — 重複檢查失敗 (${String(e).slice(0, 80)})`;
            console.error(`[analyze] hard-stop check threw for ${symbol}:`, String(e));
          }
        }
      }

      // ── Signal gate: DB record and notifications are fully decoupled from each other ──
      // profileId (Supabase user UUID) is the only identity requirement; LINE success is not.
      let gateNote: string | undefined; // surfaces insert failures in scan-status panel
      if (!!profileId && !skipReason) {
        const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL  || '';
        const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
        const sp           = entrySignal.signalPrice ?? 0;
        const isLimitOrder = sp > 0 && Math.abs(entrySignal.entry - sp) / sp > 0.003;
        let insertOk = false;

        // ── Step 1: DB insert — gated only on DB creds + profileId ──────────────
        // LINE success is NOT required. Failure here is logged; lock is not set so next cron retries.
        if (sbUrl && sbKey) {
          try {
            const { createClient: mkAdmin } = await import('@supabase/supabase-js');
            const admin = mkAdmin(sbUrl, sbKey, { auth: { autoRefreshToken: false, persistSession: false } });

            // Final duplicate guard (Redis lock may be lost after Vercel cold start).
            // Symbol-global on purpose — see hard-stop duplicate check above.
            const { count } = await admin.from('trades')
              .select('id', { count: 'exact', head: true })
              .eq('symbol', entrySignal.symbol)
              .is('closed_at', null);

            if (count === 0) {
              const tradeId    = `trade-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
              const insertData = {
                id:           tradeId,
                user_id:      profileId,          // already-resolved UUID — no second profile lookup
                signal_id:    entrySignal.id,
                symbol:       entrySignal.symbol,
                direction:    entrySignal.direction,
                timeframe:    entrySignal.timeframe,
                strength:     entrySignal.strength,
                score:        entrySignal.score,
                entry:        entrySignal.entry,
                stop_loss:    entrySignal.stopLoss,
                tp1:          entrySignal.takeProfits[0],
                tp2:          entrySignal.takeProfits[1] ?? entrySignal.takeProfits[0],
                reasons:      entrySignal.reasons,
                entry_notes:  '',
                opened_at:    Date.now(),
                // 2026-08-17 實測撞到：市價進場例外（isLimitOrder=false）原本
                // 不分使用者一律直接寫 'active'——這個假設對 DB 模擬使用者成立
                // （這支自己的K線模擬在同一次請求裡就會確認成交），對 live-runner
                // 使用者不成立：真的下單是 live-runner 自己下一輪輪詢才會做，
                // 而且可能失敗（實測撞到 ETHUSDT 保證金不足，訂單從未送出）。
                // 提早寫 'active' 讓 App 顯示「持倉中」+完整進場/止損資訊，但
                // 交易所端根本沒有這個部位——幽靈倉位。live 使用者一律先寫
                // 'waiting'，只信 live-runner 自己輪詢確認 positionQty>0 後的
                // 自我修復（scripts/live-runner.ts 「自我修復：真的有部位」那段）
                // 才轉 'active'，不再樂觀假設。
                status:       (isLimitOrder || isLiveTradingUser) ? 'waiting' : 'active',
                signal_price: sp,
                strategy:            entrySignal.strategy ?? 'A',
                regime:              entrySignal.regime ?? null,
                confidence:          entrySignal.confidence ?? null,
                funding_rate:        entrySignal.fundingRate ?? null,
                suggested_risk_pct:  entrySignal.suggestedRiskPct ?? null,
                suggested_leverage:  entrySignal.suggestedLeverage ?? null,
                // 2026-08-12：原本 `?? 'A'` 會把策略B（均值回歸，從不設 tier——
                // generateMeanReversionSignals 沒有 A/B 兩級概念）捏造成 A 級，
                // 跟 8/6 那次 CSV 匯出層 `?? 'A'` 同一種錯誤（docs/ANALYSIS-
                // 2026-08-06B §0），只是這次是寫入層。用明確 `?? null`（不是省略
                // 這個 key）——object 裡值為 undefined 的 key 會被 JSON.stringify
                // 拿掉，若省略會讓 Supabase 退回欄位的 DB DEFAULT（可能仍是
                // 'A'），一樣白修。下游讀取端（trades/page.tsx、tierRiskMultiplier）
                // 本來就把 tier=null 當成全額風險處理，跟舊資料（tier系統加入前）
                // 的行為一致，不會因為這裡不再捏造值而改變任何風控算式。
                tier:                entrySignal.tier ?? null,
                score_breakdown:     entrySignal.scoreBreakdown ?? null,
              };

              // Missing-column detection: PostgREST returns PGRST204 ("Could not
              // find the 'x' column in the schema cache") for unknown INSERT
              // columns — 42703 only appears on raw SQL / column-grant paths.
              const isMissingColumn = (code?: string, msg?: string) =>
                code === '42703' || code === 'PGRST204' || /column/i.test(msg ?? '');

              const ir = await admin.from('trades').insert(insertData);
              if (!ir.error) {
                insertOk = true;
              } else if (ir.error.code === '23505') {
                // Partial unique index (trades_one_open_per_symbol) blocked this insert —
                // a concurrent analyze already inserted an open trade for this symbol.
                // Treat as "already exists": don't set lock here; the winning instance will.
                console.log(`[analyze] concurrent insert blocked for ${entrySignal.symbol} (23505) — another cron won the race`);
              } else if (isMissingColumn(ir.error.code, ir.error.message)) {
                // Two-stage fallback so a single missing NEW column doesn't strip
                // columns that DO exist (status/signal_price own the limit-order flow).
                // Stage 1: drop v2.1+ columns (tier, score_breakdown); Stage 2: pre-migration base.
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const { tier: _tier1, score_breakdown: _sb1, ...noTierData } = insertData;
                const irT = await admin.from('trades').insert(noTierData);
                if (!irT.error) {
                  insertOk = true;
                  console.log(`[analyze] insert ok without v2.1 columns for ${entrySignal.symbol} — run: ALTER TABLE trades ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'A'; ALTER TABLE trades ADD COLUMN IF NOT EXISTS score_breakdown JSONB;`);
                } else if (irT.error.code === '23505') {
                  console.log(`[analyze] concurrent insert blocked for ${entrySignal.symbol} (23505/no-tier) — another cron won the race`);
                } else if (isMissingColumn(irT.error.code, irT.error.message)) {
                  // eslint-disable-next-line @typescript-eslint/no-unused-vars
                  const { status: _s, signal_price: _sp, strategy: _str, regime: _reg, confidence: _conf, funding_rate: _fr, suggested_risk_pct: _srp, suggested_leverage: _slev, tier: _tier, score_breakdown: _sb, ...baseData } = insertData;
                  const ir2 = await admin.from('trades').insert(baseData);
                  if (!ir2.error) {
                    insertOk = true;
                    // 2026-07-27: this branch used to succeed SILENTLY. It strips `status`
                    // and `signal_price` — the two columns the whole limit-order flow runs
                    // on — so every trade it creates is born status=NULL: invisible to the
                    // 等待進場 tab, and monitored only because ecc40e6 buckets NULL as
                    // waiting. It had been firing on every insert for weeks with zero
                    // trace. Log loudly, and surface the ORIGINAL error so the missing
                    // column is identifiable instead of guessed at.
                    console.error(
                      `[analyze] DEGRADED INSERT for ${entrySignal.symbol} — status/signal_price were stripped ` +
                      `(row created with status=NULL). Triggering error: [${irT.error.code}] ${irT.error.message}. ` +
                      `Fix the schema so this stops: ALTER TABLE trades ` +
                      `ADD COLUMN IF NOT EXISTS strategy TEXT, ` +
                      `ADD COLUMN IF NOT EXISTS regime TEXT, ` +
                      `ADD COLUMN IF NOT EXISTS confidence NUMERIC, ` +
                      `ADD COLUMN IF NOT EXISTS funding_rate NUMERIC, ` +
                      `ADD COLUMN IF NOT EXISTS suggested_risk_pct NUMERIC, ` +
                      `ADD COLUMN IF NOT EXISTS suggested_leverage NUMERIC, ` +
                      `ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'A', ` +
                      `ADD COLUMN IF NOT EXISTS score_breakdown JSONB;`
                    );
                  } else if (ir2.error.code === '23505') {
                    console.log(`[analyze] concurrent insert blocked for ${entrySignal.symbol} (23505/fallback) — another cron won the race`);
                  } else {
                    console.error(`[analyze] trade insert failed for ${entrySignal.symbol}: [${ir2.error.code}] ${ir2.error.message}`);
                  }
                } else {
                  console.error(`[analyze] trade insert failed for ${entrySignal.symbol}: [${irT.error.code}] ${irT.error.message}`);
                }
              } else {
                console.error(`[analyze] trade insert failed for ${entrySignal.symbol}: [${ir.error.code}] ${ir.error.message}`);
              }
            }
          } catch (e) {
            console.error(`[analyze] trade insert threw for ${entrySignal.symbol}: ${String(e)}`);
          }
        } else {
          console.error(`[analyze] trade insert skipped for ${entrySignal.symbol} — DB not configured`);
        }

        if (!insertOk) gateNote = '⚠ 訊號達標但 DB 寫入失敗（詳見漏斗統計）';

        // ── Step 2: Lock + pending signals (only after trade is confirmed in DB) ──
        // Lock prevents re-triggering the same signal on the next cron cycle.
        // If insert failed above, lock is NOT set so the next cron can retry.
        if (insertOk) {
          notified.push(symbol);
          await setLock(symbol, {
            sentAt: Date.now(), candleBucket: current4hBucket(),
            direction: entrySignal.direction, locked: true,
          });
          const rp = getRedis();
          if (rp) {
            try {
              await rp.lpush('pending_signals', JSON.stringify(entrySignal));
              await rp.expire('pending_signals', 24 * 3600);
            } catch { pendingSignals.push(entrySignal); }
          } else {
            pendingSignals.push(entrySignal);
            if (pendingSignals.length > 50) pendingSignals.splice(0, pendingSignals.length - 50);
          }

          // ── Step 3: Signal notification (Web Push) ──────────────────────────
          if (profileId) {
            const edir  = entrySignal.direction === 'LONG' ? '做多▲' : '做空▼';
            const esym  = entrySignal.symbol.replace('USDT', '/USDT');
            const eTier = entrySignal.tier === 'B' ? ' 🅱輕倉' : '';
            const eKind = isScalp ? ' ⚡短線' : '';
            // Concrete order instructions: notional / margin / leverage at the
            // user's synced account size (tier B = half risk, leverage ≤5x)
            const effRisk = acctRiskPct * tierRiskMultiplier(entrySignal.symbol, entrySignal.tier);
            const plan = calcPositionPlan(acctSize, effRisk, entrySignal.entry, entrySignal.stopLoss, entrySignal.tier === 'B' ? 5 : 10);
            const planLine = plan ? `\n${formatPlanLine(plan)}｜止損虧 ${plan.riskUSDT}U` : '';
            await sendWebPushToUser(profileId, {
              title: `${edir} ${esym} 交易信號${eTier}${eKind}`,
              body: `${isLimitOrder ? '⏳掛單' : '🔴市場入場'} 進場 $${fmtPrice(entrySignal.entry)} ｜ TP1 $${fmtPrice(entrySignal.takeProfits[0])} ｜ SL $${fmtPrice(entrySignal.stopLoss)} ｜ ${entrySignal.score}分${planLine}`,
              tag: `signal-${entrySignal.id}`,
            });
          }
          // 市價單不再另外推一則「✅ 市場入場」確認（2026-07-27 移除，見同名註解於 pass 1 沿革）。
        }
      }

      // ── v2.1 §0: reject funnel — same shape as pass 1's, for a deferred candidate ──
      const signalSent = notified.includes(symbol);
      const rejectedAt = signalSent ? null
        : skipKey    ? skipKey
        : !profileId ? 'no_profile'
        : 'insert_failed';
      funnelEntries.push({
        at: Date.now(),
        symbol,
        strategy:  entrySignal.strategy ?? 'A',
        direction: entrySignal.direction,
        rawScore:  Math.max(cand.rawTopScore, entrySignal.score),
        tier:      entrySignal.tier ?? null,
        rejectedAt,
        rejectDetail: skipReason
          ?? (rejectedAt === 'no_profile'    ? 'profileId 未解析，無法寫入 DB'
            : rejectedAt === 'insert_failed' ? 'DB 寫入失敗（見 Vercel logs）'
            : null),
        filters: {
          adx4h:          isNaN(cand.symbolAdx) ? null : parseFloat(cand.symbolAdx.toFixed(1)),
          regime:         cand.symbolRegime,
          btcRegime:      btcState.regime,
          btcMovePct:     btcState.movePct ?? null,
          btcPausedLong:  btcState.longPaused,
          btcPausedShort: btcState.shortPaused,
          agreeTFs:       cand.agreeTFs,
          entryTfBias:    cand.entryTfBias,
          totalOpenRisk,
        },
      });

      // Shadow candidate: gate-rejected with concrete levels → simulate outcome
      if (rejectedAt && SHADOW_GATES.has(rejectedAt)) {
        const ssp = entrySignal.signalPrice ?? 0;
        const isLimit = ssp > 0 && Math.abs(entrySignal.entry - ssp) / ssp > 0.003;
        shadowCandidates.push({
          id: `shdw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          at: Date.now(),
          symbol,
          direction: entrySignal.direction,
          timeframe: entrySignal.timeframe,
          entry: entrySignal.entry,
          stopLoss: entrySignal.stopLoss,
          tp1: entrySignal.takeProfits[0],
          tp2: entrySignal.takeProfits[1] ?? entrySignal.takeProfits[0],
          score: entrySignal.score,
          tier: entrySignal.tier ?? null,
          strategy: entrySignal.strategy ?? 'A',
          rejectedAt,
          signalPrice: ssp,
          status: isLimit ? 'waiting' : 'active',
          ...(isLimit ? {} : { filledAt: Date.now() }),
          lastCheckedAt: Date.now(),
        });
      }

      results.push({
        symbol,
        signalCount: cand.strong.length,
        topScore: cand.topScore,
        rawTopScore: cand.rawTopScore,
        topSignal: cand.strong[0]
          ? { direction: cand.strong[0].direction, strength: cand.strong[0].strength, score: cand.strong[0].score, entry: cand.strong[0].entry, confidence: cand.strong[0].confidence, fundingRate: cand.strong[0].fundingRate }
          : null,
        locked: cand.locked,
        confluenceMet: cand.confluenceMet,
        agreeTFs: cand.agreeTFs,
        tfsAnalyzed: cand.tfsAnalyzed,
        regime: cand.symbolRegime,
        btcRegime: btcState.regime,
        adx4h: isNaN(cand.symbolAdx) ? null : parseFloat(cand.symbolAdx.toFixed(2)),
        atrPercentile: cand.symbolAtrPct,
        suggestedRiskPct: cand.suggestedRiskPct,
        fundingRate: cand.symbolFundingRate,
        event_filter_active: eventFilter.active,
        ...(skipReason        ? { note: skipReason }
          : gateNote          ? { note: gateNote }
          : cand.stratBPaused ? { note: '策略B連虧2筆暫停24h' }
          : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ symbol, signalCount: 0, topScore: cand.topScore, topSignal: null, locked: false, error: msg });
    }
  }

  // Monitor active trades for TP/SL hits (server-side, App can be closed)
  const monitor = await monitorActiveTrades(profileId, muteCancelPush)
    .catch(() => ({ monitored: 0, closed: 0, filled: 0, cancelled: 0 }));

  // Shadow simulation: merge new rejects, advance live ones against real candles
  await processShadowTrades(shadowCandidates);

  // v2.1 §0: flush reject-funnel entries (single batched lpush per scan)
  if (funnelEntries.length > 0) {
    const rf = getRedis();
    if (rf) {
      try {
        await rf.lpush('reject_funnel', ...funnelEntries.map(e => JSON.stringify(e)));
        await rf.ltrim('reject_funnel', 0, 1499);          // cap memory
        await rf.expire('reject_funnel', 14 * 24 * 3600);  // 14-day window
      } catch { /* non-fatal */ }
    }
  }

  // v2.1 §1.2: persist ADX hysteresis state transitions (single hset per scan)
  if (Object.keys(adxStateChanges).length > 0) {
    const rA = getRedis();
    if (rA) {
      try {
        await rA.hset('adx_states', adxStateChanges);
        await rA.expire('adx_states', 14 * 24 * 3600);
      } catch { /* non-fatal */ }
    }
  }

  // Persist scan summary so /api/scan-status (and the home-page panel) can show
  // why each coin was or wasn't signalled — spec §6 requires reject logs to be kept.
  {
    const rScan = getRedis();
    if (rScan) {
      try {
        await rScan.set('last_scan', {
          at: Date.now(),
          btcRegime: btcState.regime,
          circuitBreaker: breaker.triggered ? breaker.reason ?? true : null,
          drawdownHalt: drawdown.halted ? drawdown.reason ?? true : null,
          eventFilter: eventFilter.active ? eventFilter.reason ?? true : null,
          totalOpenRisk: parseFloat(totalOpenRisk.toFixed(2)),
          notified,
          coins: results.map(r => ({
            symbol: r.symbol,
            topScore: r.topScore,
            rawTopScore: r.rawTopScore ?? 0,
            adx4h: r.adx4h ?? null,
            regime: r.regime ?? null,
            agreeTFs: r.agreeTFs ?? 0,
            note: r.note ?? r.error ?? null,
          })),
        }, { ex: 7200 });
      } catch { /* non-fatal — panel just shows stale data */ }
    }
  }

  return NextResponse.json({
    ok: true, analyzedAt: new Date().toISOString(),
    minScore, usingRedis, coins: coins.length, notified, results,
    monitor,
    btcRegime: btcState.regime,
    circuitBreaker: breaker.triggered ? breaker.reason : null,
    drawdownHalt: drawdown.halted ? drawdown.reason : null,
    totalOpenRisk: parseFloat(totalOpenRisk.toFixed(2)),
    eventFilter: { active: eventFilter.active, ...(eventFilter.reason ? { reason: eventFilter.reason } : {}) },
  });
}

// ── POST — return pending signals for client auto-journal ──────
// Signals are NOT deleted on read — they expire via the 24h TTL set at push time.
// Client deduplicates by signalId so re-reads are harmless.
export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24h window
  const r = getRedis();
  if (r) {
    try {
      const raw = await r.lrange('pending_signals', 0, -1);
      const signals = raw.map(s => (typeof s === 'string' ? JSON.parse(s) : s)) as TradingSignal[];
      const filtered = signals.filter(s => s && s.timestamp > cutoff);
      return NextResponse.json({ ok: true, signals: filtered, source: 'redis' });
    } catch { /* fall through to in-memory */ }
  }
  // In-memory fallback: read-only, filter by age (no splice)
  const signals = pendingSignals.filter(s => s.timestamp > cutoff);
  return NextResponse.json({ ok: true, signals, source: 'memory' });
}

// ── DELETE — unlock coin or reset ALL locks ────────────────────
export async function DELETE(req: NextRequest) {
  if (!checkAuth(req) && !(await checkUserSession(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const symbol = req.nextUrl.searchParams.get('symbol')?.toUpperCase();
  const r = getRedis();

  if (!symbol) {
    // Reset ALL locks + risk-control state (breaker, BTC pause, loss cooldown).
    // ?scope=locks limits it to tlocks only; default clears everything.
    const scope = req.nextUrl.searchParams.get('scope');

    // 2026-08-19：?scope=drawdown — 回撤停機的「人工確認」。這道關卡的用意是
    // 「策略可能失效，停下來讓人工檢查」，所以解除方式刻意是**明確確認**而不是
    // 自動放行或加 TTL（自動放行等於這道關卡不存在）。確認後 checkDrawdownHalt
    // 只計算此刻之後平倉的單，等於「我看過了，從現在重新算」——風險上限一點
    // 都沒有放寬，但系統不會再永久卡死（見該函式的死結說明）。
    // 刻意不併進預設的 all-reset：那個是清鎖/冷卻這類例行操作，回撤確認代表
    // 「人已經檢查過策略」，語意完全不同，混在一起會讓人不小心就解除掉。
    if (scope === 'drawdown') {
      const pid = process.env.SUPABASE_PROFILE_ID ?? '';
      if (!pid) {
        return NextResponse.json({ ok: false, error: 'SUPABASE_PROFILE_ID 未設定，無法確認回撤停機' }, { status: 400 });
      }
      if (!r) {
        return NextResponse.json({ ok: false, error: 'Redis 未設定，回撤確認需要持久化' }, { status: 400 });
      }
      const at = Date.now();
      try {
        await r.set(DRAWDOWN_ACK_KEY(pid), at);
        return NextResponse.json({
          ok: true, scope: 'drawdown', acknowledgedAt: at,
          note: '回撤停機已確認解除——權益回撤改從此刻之後平倉的交易重新計算（風險上限未變動）',
        });
      } catch (e) {
        return NextResponse.json({ ok: false, error: `寫入確認失敗: ${String(e).slice(0, 120)}` }, { status: 500 });
      }
    }

    if (r) {
      try {
        const patterns = scope === 'locks'
          ? ['tlock:*']
          : ['tlock:*', 'circuit_breaker*', 'btc_pause:*', 'loss_cd:*'];
        const keyGroups = await Promise.all(patterns.map(p => r.keys(p)));
        const keys = keyGroups.flat();
        if (keys.length > 0) await Promise.all(keys.map(k => r.del(k)));
        return NextResponse.json({ ok: true, cleared: keys.length, scope: scope ?? 'all', usingRedis: true });
      } catch { /* fall through */ }
    }
    memLock.clear();
    memLossCd.clear();
    memBtcPause.long = 0; memBtcPause.short = 0;
    return NextResponse.json({ ok: true, cleared: memLock.size, usingRedis: false });
  }

  await unlockSymbol(symbol);
  return NextResponse.json({ ok: true, symbol, unlocked: true, usingRedis: !!r });
}

function delay(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}
