import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

export const dynamic = 'force-dynamic';

// Same auth contract as /api/analyze: webhook secret via header or query param.
function checkAuth(req: NextRequest): boolean {
  const envSecret = process.env.WEBHOOK_SECRET;
  // No secret configured: fail-open only outside production, fail-closed on production
  // (待修改事項.md P2-1).
  if (!envSecret) return process.env.VERCEL_ENV !== 'production';
  const provided = req.headers.get('x-webhook-secret') ?? req.nextUrl.searchParams.get('secret');
  return provided === envSecret;
}

export interface ScanStatusCoin {
  symbol: string;
  topScore: number;
  adx4h: number | null;
  regime: string | null;
  agreeTFs: number;
  note: string | null;
}

export interface ScanStatus {
  at: number;
  btcRegime: string;
  circuitBreaker: string | boolean | null;
  // 跨日權益回撤停機（2026-08-04）——舊的 last_scan 快照沒有這個 key，
  // 讀到 undefined 時視同「沒停機」，不會把舊快照誤判成停機中。
  drawdownHalt?: string | boolean | null;
  eventFilter: string | boolean | null;
  totalOpenRisk: number;
  notified: string[];
  coins: ScanStatusCoin[];
}

// 2026-08-23：Upstash 免費額度（50 萬次/月）被燒完，整個 Redis 停擺——
// 影子模擬沒在記錄、熔斷/訊號鎖/冷卻的 fallback 全是「不擋」，等於裸奔。
// 盤點下來這支端點是第三大戶：ScanStatusPanel 和 BtcStatusBar 各自每 90 秒
// 打一次，兩個元件 × 每個開著的分頁，約 5.8 萬次/月。
//
// 修法選記憶體快取而不是叫前端共用一次 fetch：這樣不管開幾個分頁、將來
// 又多幾個元件來讀，Redis 讀取都被壓在每 60 秒最多一次。前端共用只能解決
// 「同一個分頁的兩個元件」，多開一個分頁就破功。
//
// last_scan 本來就是 cron 每 5 分鐘才更新一次的快照，快取 60 秒不會讓使用者
// 看到更舊的東西——資料本身的解析度就是 5 分鐘。
//
// 註：Vercel 的實例是短命的，這個快取只在單一暖實例內有效。以這個專案的
// 流量（單一使用者）通常就是一個實例，足以解決問題；不追求跨實例一致，
// 那需要再引入一層快取，反而增加要維護的東西。
let cached: { at: number; scan: ScanStatus | null } | null = null;
const CACHE_MS = 60_000;

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return NextResponse.json({ ok: false, reason: 'redis-not-configured', scan: null });
  }

  if (cached && Date.now() - cached.at < CACHE_MS) {
    return NextResponse.json({ ok: true, scan: cached.scan, cached: true });
  }

  try {
    const redis = Redis.fromEnv();
    const scan  = await redis.get<ScanStatus>('last_scan');
    cached = { at: Date.now(), scan: scan ?? null };
    return NextResponse.json({ ok: true, scan: scan ?? null });
  } catch (e) {
    // 刻意不寫入快取：失敗（例如額度用完）不該被記住 60 秒，那會讓恢復
    // 之後還要多等一輪。
    return NextResponse.json({ ok: false, reason: String(e).slice(0, 120), scan: null });
  }
}
