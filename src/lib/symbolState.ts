// 每檔幣的風控狀態，合併成單一 Redis hash。
//
// 2026-08-23：Upstash 免費額度（50 萬次/月）被燒完，整個 Redis 停擺——訊號鎖
// 失效、熔斷讀不到、冷卻讀不到，全部 fallback 都是「不擋」，等於裸奔。盤點
// 出最大宗是掃描迴圈裡的逐幣讀鍵：每輪 15 檔幣，各讀 tlock: / bias_hold: /
// loss_cd: / stratB_pause: 四種鍵，一輪 45～75 次，×288 輪/天 ≈ 69 萬次/月，
// 光這一項就超過整個額度。
//
// CLAUDE.md 早就寫著「避免迴圈內逐鍵操作」，但那段就是。改成整包 hgetall
// 讀一次、整包 hset 寫一次，一輪從 45～75 次降到 2 次。
//
// ── 為什麼到期時間要搬進值裡面 ──
// 原本每個鍵各有自己的 TTL，Redis 自動過期。hash **只有整體 TTL、沒有逐欄位
// 過期**，所以合併之後：
//   1. 到期時間必須存進值裡，讀的時候自己比對 now
//   2. 必須自己修剪，否則 hash 會無限長大（原本靠 TTL 自動清）
// 這兩件事漏掉任何一件，後果都是風控靜默失效——鎖永遠不過期（訊號再也發不
// 出來），或鎖立刻過期（同一個幣重複發單）。8/6 就有前科：ADAUSDT 在 40 筆
// 訊號裡出現 10 次，起因就是冷卻判斷式被寫壞。所以這裡全部抽成純函數配測試。

export type Dir = 'LONG' | 'SHORT';

export interface LockEntry {
  locked: boolean;
  sentAt: number;
}

export interface SymbolState {
  lock?:   { entry: LockEntry; exp: number };
  bias?:   { dir: string; exp: number };
  // 多空各自獨立的冷卻到期時間（做多被停損不該連做空一起鎖）
  lossCd?: Partial<Record<Dir, number>>;
  bPause?: number;
}

export type SymbolStateMap = Record<string, SymbolState>;

// ── 讀 ──────────────────────────────────────────────────────────
// 全部吃 now 參數而不是自己叫 Date.now()：純函數才測得動「剛好在到期邊界」
// 這類情況。

export function readLock(map: SymbolStateMap, symbol: string, now: number): LockEntry | null {
  const s = map[symbol]?.lock;
  if (!s || s.exp <= now) return null;
  return s.entry;
}

export function readBias(map: SymbolStateMap, symbol: string, now: number): string | null {
  const s = map[symbol]?.bias;
  if (!s || s.exp <= now) return null;
  return s.dir;
}

export function readLossCd(map: SymbolStateMap, symbol: string, dir: string, now: number): boolean {
  const exp = map[symbol]?.lossCd?.[dir as Dir];
  return exp != null && exp > now;
}

export function readBPause(map: SymbolStateMap, symbol: string, now: number): boolean {
  const exp = map[symbol]?.bPause;
  return exp != null && exp > now;
}

// ── 寫（就地更新傳入的 map，回傳被改動的 symbol 供批次寫入）──────────
// 刻意就地改而不是回傳新 map：呼叫端在一輪掃描裡會改很多次，每次複製整包
// 是浪費。回傳 symbol 讓呼叫端只把真的動過的欄位寫回 Redis。

export function writeLock(map: SymbolStateMap, symbol: string, entry: LockEntry, ttlSec: number, now: number): string {
  (map[symbol] ??= {}).lock = { entry, exp: now + ttlSec * 1000 };
  return symbol;
}

export function writeBias(map: SymbolStateMap, symbol: string, dir: string, ttlSec: number, now: number): string {
  (map[symbol] ??= {}).bias = { dir, exp: now + ttlSec * 1000 };
  return symbol;
}

export function writeLossCd(map: SymbolStateMap, symbol: string, dir: string, ttlSec: number, now: number): string {
  const s = (map[symbol] ??= {});
  (s.lossCd ??= {})[dir as Dir] = now + ttlSec * 1000;
  return symbol;
}

export function writeBPause(map: SymbolStateMap, symbol: string, ttlSec: number, now: number): string {
  (map[symbol] ??= {}).bPause = now + ttlSec * 1000;
  return symbol;
}

// ── 修剪 ────────────────────────────────────────────────────────
// 合併成 hash 之後沒有逐欄位 TTL 了，過期資料必須自己清，否則 hash 會一直
// 長大（幣圈會輪動，下架的幣種永遠留在裡面）。回傳「要從 hash 刪掉的
// symbol」讓呼叫端一次 hdel。

export interface PruneResult {
  /** 仍有有效欄位、需要寫回的 symbol */
  keep: string[];
  /** 全部欄位都過期、可以從 hash 刪掉的 symbol */
  drop: string[];
}

export function pruneState(map: SymbolStateMap, now: number): PruneResult {
  const keep: string[] = [];
  const drop: string[] = [];
  for (const [symbol, s] of Object.entries(map)) {
    if (s.lock   && s.lock.exp   <= now) delete s.lock;
    if (s.bias   && s.bias.exp   <= now) delete s.bias;
    if (s.bPause && s.bPause     <= now) delete s.bPause;
    if (s.lossCd) {
      for (const d of Object.keys(s.lossCd) as Dir[]) {
        if ((s.lossCd[d] ?? 0) <= now) delete s.lossCd[d];
      }
      if (Object.keys(s.lossCd).length === 0) delete s.lossCd;
    }
    if (Object.keys(s).length === 0) { drop.push(symbol); delete map[symbol]; }
    else keep.push(symbol);
  }
  return { keep, drop };
}

// Redis hash 的值可能是字串（自己 JSON.stringify 存的）或已被 SDK 解析過的
// 物件——兩種都要吃，壞掉的欄位丟掉而不是讓整輪掃描爆掉。
export function parseStateMap(raw: Record<string, unknown> | null | undefined): SymbolStateMap {
  const out: SymbolStateMap = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    try {
      const parsed = (typeof v === 'string' ? JSON.parse(v) : v) as SymbolState;
      if (parsed && typeof parsed === 'object') out[k] = parsed;
    } catch { /* 壞掉的欄位直接丟 */ }
  }
  return out;
}
