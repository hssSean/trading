// F1 前向紙上追蹤的執行器——route.ts 每小時最多呼叫一次，**不下任何單**。
//
// 規則全在 f1Paper.ts（與回測共用）；這裡只負責：抓資料、偵測新訊號、結算到期的單、
// 寫 Redis。依賴用參數注入，單元測試不必碰網路或 Redis。
//
// Redis 佈局（指令數要省，見 CLAUDE.md）：
//   f1p:open  hash  id → 未結算的紙上單（route 每次讀，永遠很小）
//   f1p:done  hash  id → 已結算（route 只寫不讀；報表腳本讀）
//   f1p:meta  hash  lastT → 已處理到的時間；busy:<symbol> → 該幣佔用到何時
// 一次執行固定 1 次 hgetall(open) + 1 次 hgetall(meta) + 最多 4 次寫入。
//
// **只往前記錄**：第一次執行把 lastT 設成當下，不回補歷史——回補的話就又變成回測了。
import {
  F1_UNIVERSE, detectF1Signals, resolveF1Trade, f1ResolvableAt,
  type Bar, type FundingPoint, type F1PaperTrade,
} from './f1Paper';

const H4 = 4 * 3_600_000;
/** 結算後等多久才去抓（幣安要一點時間才把該次結算放進歷史） */
const SETTLE_GRACE_MS = 10 * 60_000;
/** 到期後超過這麼久還結算不了（資料抓不到）就作廢，避免永遠卡在 open */
const RESOLVE_GIVE_UP_MS = 3 * 24 * 3_600_000;
const MAX_RESOLVE_PER_RUN = 8;
const FETCH_CONCURRENCY = 8;

export interface F1RedisLike {
  hgetall(key: string): Promise<Record<string, unknown> | null>;
  hset(key: string, kv: Record<string, string>): Promise<unknown>;
  hdel(key: string, ...fields: string[]): Promise<unknown>;
}

export interface F1Deps {
  fetchFundingHistory(symbol: string, limit: number, startTime?: number): Promise<FundingPoint[]>;
  fetch4h(symbol: string, limit: number, startTime: number): Promise<Bar[]>;
  universe?: string[];
}

export interface F1RunSummary { detected: number; resolved: number; voided: number; scanned: boolean; errors: number }

const parse = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;

async function inChunks<T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < xs.length; i += n) out.push(...await Promise.all(xs.slice(i, i + n).map(fn)));
  return out;
}

export async function runF1Paper(r: F1RedisLike, deps: F1Deps, now: number = Date.now()): Promise<F1RunSummary> {
  const sum: F1RunSummary = { detected: 0, resolved: 0, voided: 0, scanned: false, errors: 0 };
  const open = new Map<string, F1PaperTrade>(
    Object.entries((await r.hgetall('f1p:open')) ?? {}).map(([k, v]) => [k, parse<F1PaperTrade>(v)]));
  const metaRaw = (await r.hgetall('f1p:meta')) ?? {};
  const meta: Record<string, string> = {};
  for (const [k, v] of Object.entries(metaRaw)) meta[k] = String(v);

  const metaWrites: Record<string, string> = {};
  const openWrites: Record<string, string> = {};
  const doneWrites: Record<string, string> = {};
  const openDeletes: string[] = [];

  // ── 1. 結算到期的單 ──
  const due = Array.from(open.values())
    .filter(t => now >= f1ResolvableAt(t) + SETTLE_GRACE_MS)
    .sort((a, b) => a.entryT - b.entryT)
    .slice(0, MAX_RESOLVE_PER_RUN);
  await inChunks(due, FETCH_CONCURRENCY, async t => {
    try {
      const candles = await deps.fetch4h(t.symbol, 50, t.entryT - 25 * H4);
      const fund = await deps.fetchFundingHistory(t.symbol, 40, t.entryT - H4);
      const res = resolveF1Trade(t, candles, fund, now);
      if (res) {
        doneWrites[t.id] = JSON.stringify(res);
        openDeletes.push(t.id);
        if (res.status === 'done') sum.resolved++; else sum.voided++;
        return;
      }
    } catch { sum.errors++; }
    if (now > f1ResolvableAt(t) + RESOLVE_GIVE_UP_MS) {
      doneWrites[t.id] = JSON.stringify({ ...t, status: 'void', note: '資料抓不到，逾時作廢', resolvedAt: now });
      openDeletes.push(t.id);
      sum.voided++;
    }
  });

  // ── 2. 偵測新訊號（每個 4H 邊界之後最多一次）──
  const lastT = Number(meta.lastT);
  if (!Number.isFinite(lastT)) {
    // 第一次執行：從現在開始記，不回補
    metaWrites.lastT = String(now);
  } else {
    const boundary = Math.floor((now - SETTLE_GRACE_MS) / H4) * H4;
    if (boundary > lastT) {
      sum.scanned = true;
      const universe = deps.universe ?? F1_UNIVERSE;
      await inChunks(universe, FETCH_CONCURRENCY, async symbol => {
        try {
          const fund = await deps.fetchFundingHistory(symbol, 100);
          const busy = Number(meta[`busy:${symbol}`] ?? -Infinity);
          const sigs = detectF1Signals(symbol, fund.filter(x => x.t <= now), lastT, busy);
          for (const s of sigs) {
            if (open.has(s.id)) continue;
            openWrites[s.id] = JSON.stringify(s);
            metaWrites[`busy:${symbol}`] = String(f1ResolvableAt(s));
            sum.detected++;
          }
        } catch { sum.errors++; }
      });
      metaWrites.lastT = String(now - SETTLE_GRACE_MS);
    }
  }

  // ── 3. 寫回（每個 key 最多一次）──
  if (Object.keys(doneWrites).length) await r.hset('f1p:done', doneWrites);
  if (openDeletes.length) await r.hdel('f1p:open', ...openDeletes);
  if (Object.keys(openWrites).length) await r.hset('f1p:open', openWrites);
  if (Object.keys(metaWrites).length) await r.hset('f1p:meta', metaWrites);
  return sum;
}
