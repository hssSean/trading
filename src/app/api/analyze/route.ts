// /api/analyze — 外部 cron 每 60 秒打一次（實際節奏由 scan-run-lock 的 TTL 決定）。
//
// 2026-10-12 精簡：舊的 v2.1 評分策略（掃描、風控關卡、DB 模擬監控、影子模擬、拒絕漏斗）
// 已在 2026-10-07 停開新倉，持倉也歸零，整段 3700 行移除（最後的完整版本在 commit c2070fc）。
// 現在 GET 只做三件事：
//   1. live-runner 停止告警（src/lib/liveRunnerAlert.ts）
//   2. S3／S1 模擬帳本工作 prep → s3 → s1（src/lib/s3s1/engine.ts）＋分數影子追蹤
//   3. 研究端每日對帳的告警（src/lib/s3s1/xcheckAlert.ts）
// POST（App 撈待推訊號）與 DELETE（清鎖、確認回撤停機）是舊策略設定頁在用的小功能，原樣保留。
import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { runPrep, runS3, runS1, dueS3S1Job } from '@/lib/s3s1/engine';
import { binanceS3S1Deps } from '@/lib/s3s1/deps';
import { decideXcheckAlert } from '@/lib/s3s1/xcheckAlert';
import type { TradingSignal } from '@/types';
import { sendWebPushToUser } from '@/lib/webpush';
import { decideLiveRunnerHandoff } from '@/lib/liveRunnerHandoff';
import { decideRunnerAlert } from '@/lib/liveRunnerAlert';

export const maxDuration = 60;

let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (_redis) return _redis;
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    _redis = Redis.fromEnv();
    return _redis;
  }
  return null;
}

// SET key 1 NX EX <period>：一個指令同時檢查並佔住時段；null = 這段時間已經有人跑過。
async function claimPeriodicSlot(key: string, periodSec: number): Promise<boolean> {
  const r = getRedis();
  if (!r) return true; // 沒有 Redis：沒得節流，直接跑
  try {
    const got = await r.set(key, Date.now(), { nx: true, ex: periodSec });
    return got !== null;
  } catch {
    return true; // Redis 一時失敗不能讓工作永遠停住
  }
}

function checkAuth(req: NextRequest): boolean {
  const envSecret  = process.env.WEBHOOK_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  const cronAuth   = req.headers.get('authorization');
  // Vercel cron — must have CRON_SECRET set
  const isVercelCron = !!(cronSecret && cronAuth === `Bearer ${cronSecret}`);
  if (isVercelCron) return true;
  // 沒設 WEBHOOK_SECRET：只有非 production 放行（本機／preview 方便）；production 一律 fail-closed。
  if (!envSecret) return process.env.VERCEL_ENV !== 'production';
  const provided = req.headers.get('x-webhook-secret') ?? req.nextUrl.searchParams.get('secret');
  return provided === envSecret;
}

// 2026-08-11：DELETE（清鎖）另外接受已登入使用者的 Supabase JWT——正式站沒設 WEBHOOK_SECRET，
// 只認 checkAuth 的話這支端點完全打不到。只給 DELETE 用（低風險清理操作）。
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

// ── live-runner 停止告警 ─────────────────────────────────────────
//
// live-runner（EC2）每 15 秒把心跳寫進 Redis（TTL 90 秒）與 Supabase profiles.live_runner_heartbeat_at。
// 判斷「停了沒」用 decideLiveRunnerHandoff：只有**所有拿得到的來源都說死掉**才算停（8/23 那次
// Redis 額度用盡、兩邊同時失效而且完全無聲的教訓）。舊版這裡停了會「接手」舊策略的 DB 模擬監控；
// 舊策略移除後沒有東西可以接手——S3 真倉的移動止損、加碼、進場只有 live-runner 會做——所以只剩推播。
const LIVE_RUNNER_STALE_MS = 240_000;

async function checkLiveRunner(): Promise<Record<string, string>> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return {};
  const { createClient } = await import('@supabase/supabase-js');
  const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: liveUsers, error } = await admin.from('profiles')
    .select('id, live_runner_heartbeat_at').eq('live_trading_enabled', true);
  const out: Record<string, string> = {};
  if (error) {
    // 42703 = 欄位不存在：Redis 掛掉時就判斷不了 live-runner 死活，要大聲講
    console.error(`[runner] 查 profiles 失敗: [${error.code}] ${error.message}`
      + (error.code === '42703' ? '（ALTER TABLE profiles ADD COLUMN IF NOT EXISTS live_runner_heartbeat_at BIGINT;）' : ''));
    return out;
  }
  const r = getRedis();
  const now = Date.now();
  for (const u of (liveUsers ?? []) as { id: string; live_runner_heartbeat_at: number | null }[]) {
    let redisHb: number | null | undefined;
    if (r) {
      try { redisHb = (await r.get<number>(`live-runner:heartbeat:${u.id}`)) ?? null; } catch { redisHb = undefined; }
    }
    const dbAt = u.live_runner_heartbeat_at ?? null;
    const handoff = decideLiveRunnerHandoff({ redisHeartbeat: redisHb, dbHeartbeatAt: dbAt, now, staleMs: LIVE_RUNNER_STALE_MS });
    out[u.id.slice(0, 8)] = handoff.reason;
    if (handoff.reason === 'no-signal') {
      console.error(`[runner] ⚠ ${u.id.slice(0, 8)} 兩個心跳來源都查不到，無法判斷 live-runner 死活`);
    }

    const alertKey = `live-runner:down-alert:${u.id}`;
    let lastAlertAt: number | null | undefined;
    if (r) {
      try { lastAlertAt = (await r.get<number>(alertKey)) ?? null; } catch { lastAlertAt = undefined; }
    }
    const alert = decideRunnerAlert({ handoff: handoff.reason, dbHeartbeatAt: dbAt, lastAlertAt, now });
    try {
      if (alert.action === 'alert') {
        const mins = alert.downMs === null ? null : Math.round(alert.downMs / 60_000);
        await sendWebPushToUser(u.id, {
          title: '⚠ live-runner 停止了',
          body: (mins === null ? '心跳查不到，' : `已 ${mins} 分鐘沒有心跳，`)
            + 'S3 真倉的移動止損、加碼與進場目前沒人執行（交易所硬止損仍在）。請檢查 EC2。',
          tag: 'live-runner-down',
        });
        if (r && lastAlertAt !== undefined) await r.set(alertKey, now, { ex: 7 * 86_400 });
        console.error(`[runner] ⚠ ${u.id.slice(0, 8)} live-runner 停止，已推播告警`);
      } else if (alert.action === 'recovered') {
        await sendWebPushToUser(u.id, { title: '✅ live-runner 恢復運作', body: '心跳已恢復，S3 真倉監控重新開始。', tag: 'live-runner-down' });
        if (r) await r.del(alertKey);
      }
    } catch (e) {
      console.error(`[runner] 告警推播失敗: ${String(e).slice(0, 150)}`);
    }
  }
  return out;
}

// ── S3／S1 帳本工作與對帳告警 ─────────────────────────────────────
//
// 2026-10-07：S3-A／S3-B／S1 三個模擬帳戶（docs/strategy-deploy-2026-10-06.md）。一次呼叫最多跑一個
// 工作（prep → s3 → s1），各約 1～10 秒；時間窗外不花 Redis 指令。S3-A／B 另外由 live-runner 真下單。
async function runS3S1Jobs(profileId: string): Promise<Record<string, unknown>> {
  const nowJ = Date.now();
  const inDay = nowJ % 86_400_000, inHalf = nowJ % 43_200_000;
  const rj = getRedis();
  const out: Record<string, unknown> = {};
  if (!rj || !(inDay < 4 * 3_600_000 || (inHalf >= 3_600_000 && inHalf < 4 * 3_600_000))) return out;
  try {
    const metaJ = (await rj.hgetall<Record<string, unknown>>('s3s1:meta')) ?? {};
    const job = dueS3S1Job(metaJ, nowJ);
    if (job && await claimPeriodicSlot(`s3s1-job:${job}`, 600)) {
      const res = job === 'prep' ? await runPrep(rj, binanceS3S1Deps, nowJ)
        : job === 's3' ? await runS3(rj, binanceS3S1Deps, nowJ)
        : await runS1(rj, binanceS3S1Deps, nowJ);
      out[job] = res;
      console.log(`[s3s1] ${job} ${JSON.stringify(res).slice(0, 300)}`);
    }
  } catch (e) {
    console.error('[s3s1] failed:', String(e).slice(0, 200));
  }
  // 研究端每日前向對帳（s3_xcheck.py，台灣 09:30 跑）的結果：每天約 UTC 02:00 看一次，
  // 有新的不一致、或對帳超過 3 天沒跑就推播。
  if (profileId && inDay >= 2 * 3_600_000 && inDay < 4 * 3_600_000) {
    try {
      if (await claimPeriodicSlot('s3s1-xcheck-alert', 6 * 3600)) {
        const hash = (await rj.hgetall<Record<string, unknown>>('s3s1:xcheck')) ?? {};
        const notified = ((await rj.smembers('s3s1:xcheck:notified')) ?? []).map(String);
        const alert = decideXcheckAlert(hash, notified, nowJ);
        if (alert.bad.length) {
          const first = alert.bad[0];
          await sendWebPushToUser(profileId, {
            title: `🔴 S3 對帳不一致（${alert.bad.map(b => b.day).join('、')}）`,
            body: `${first.diffs.slice(0, 2).join('；')}${first.diffs.length > 2 ? ` 等 ${first.diffs.length} 處` : ''}。研究端重算與線上不同，詳見 trading_stratage/reports/xcheck。`,
            tag: 's3-xcheck',
          });
          await rj.sadd('s3s1:xcheck:notified', ...alert.bad.map(b => String(b.X)) as [string, ...string[]]);
          await rj.expire('s3s1:xcheck:notified', 30 * 86_400);
        } else if (alert.stale) {
          await sendWebPushToUser(profileId, {
            title: '⚠ S3 對帳超過 3 天沒跑',
            body: '研究端 s3_xcheck.py 沒有新結果（電腦沒開或排程壞了）。線上交易不受影響，但分岔不會被發現。',
            tag: 's3-xcheck',
          });
        }
        out.xcheck = { bad: alert.bad.length, stale: alert.stale };
      }
    } catch (e) {
      console.error('[s3s1] xcheck alert failed:', String(e).slice(0, 200));
    }
  }
  return out;
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // 執行鎖兼節流器：外部 cron 每 60 秒打一次，TTL 240 秒 ⇒ 實際約 4 分鐘跑一輪
  // （2026-09-10 為了 CPU 從 70 改 240）。函式被砍掉時鎖也會自己過期。
  const r = getRedis();
  if (r) {
    try {
      const got = await r.set('scan-run-lock', Date.now(), { nx: true, ex: 240 });
      if (!got) return NextResponse.json({ ok: true, skipped: 'scan already running (lock held)' });
    } catch { /* Redis 失敗就不鎖，照跑 */ }
  }

  const began = Date.now();
  const runner = await checkLiveRunner().catch(e => ({ error: String(e).slice(0, 150) }));
  const s3s1 = await runS3S1Jobs(process.env.SUPABASE_PROFILE_ID ?? '');
  console.log(`[analyze] ${Date.now() - began}ms runner=${JSON.stringify(runner)}`);
  return NextResponse.json({ ok: true, analyzedAt: new Date().toISOString(), runner, s3s1 });
}

// ── POST — 回傳待推訊號給 App 自動記帳（舊策略；現在不會再有新的） ──────
export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const r = getRedis();
  if (r) {
    try {
      const raw = await r.lrange('pending_signals', 0, -1);
      const signals = raw.map(s => (typeof s === 'string' ? JSON.parse(s) : s)) as TradingSignal[];
      return NextResponse.json({ ok: true, signals: signals.filter(s => s && s.timestamp > cutoff), source: 'redis' });
    } catch { /* fall through */ }
  }
  return NextResponse.json({ ok: true, signals: [], source: 'none' });
}

// ── DELETE — 清舊策略的鎖／風控狀態，或確認回撤停機（舊策略設定頁在用） ──
interface LockEntry { sentAt: number; candleBucket: number; direction: string; locked: boolean }
const LOCK_TTL_SEC = 24 * 3600;
const DRAWDOWN_ACK_KEY = (profileId: string) => `drawdown_ack:${profileId}`;

export async function DELETE(req: NextRequest) {
  if (!checkAuth(req) && !(await checkUserSession(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const symbol = req.nextUrl.searchParams.get('symbol')?.toUpperCase();
  const r = getRedis();

  if (!symbol) {
    const scope = req.nextUrl.searchParams.get('scope');

    // ?scope=drawdown：回撤停機的「人工確認」——確認後只計算此刻之後平倉的單。
    // 雙寫 Redis＋Supabase，任一邊成功就算解除（8/23 Upstash 額度用盡時只寫 Redis 會卡死到下個月）。
    if (scope === 'drawdown') {
      const pid = process.env.SUPABASE_PROFILE_ID ?? '';
      if (!pid) return NextResponse.json({ ok: false, error: 'SUPABASE_PROFILE_ID 未設定，無法確認回撤停機' }, { status: 400 });
      const at = Date.now();
      let redisOk = false, dbOk = false;
      const errs: string[] = [];
      if (r) {
        try { await r.set(DRAWDOWN_ACK_KEY(pid), at); redisOk = true; }
        catch (e) { errs.push(`Redis: ${String(e).slice(0, 100)}`); }
      }
      try {
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
        if (url && key) {
          const { createClient: mk } = await import('@supabase/supabase-js');
          const { error } = await mk(url, key).from('profiles').update({ drawdown_ack_at: at }).eq('id', pid);
          if (error) {
            errs.push(error.code === '42703' || error.code === 'PGRST204'
              ? 'Supabase: profiles.drawdown_ack_at 欄位不存在（請執行 ALTER TABLE profiles ADD COLUMN IF NOT EXISTS drawdown_ack_at BIGINT;）'
              : `Supabase: [${error.code}] ${error.message}`);
          } else dbOk = true;
        }
      } catch (e) {
        errs.push(`Supabase: ${String(e).slice(0, 100)}`);
      }
      if (!redisOk && !dbOk) {
        return NextResponse.json({ ok: false, error: `兩個儲存都寫入失敗，確認未生效：${errs.join(' ｜ ')}` }, { status: 500 });
      }
      return NextResponse.json({
        ok: true, scope: 'drawdown', acknowledgedAt: at,
        persistedTo: [redisOk && 'redis', dbOk && 'supabase'].filter(Boolean),
        ...(errs.length > 0 ? { warnings: errs } : {}),
        note: '回撤停機已確認解除——權益回撤改從此刻之後平倉的交易重新計算（風險上限未變動）',
      });
    }

    if (r) {
      try {
        const patterns = scope === 'locks' ? ['tlock:*'] : ['tlock:*', 'circuit_breaker*', 'btc_pause:*', 'loss_cd:*'];
        const keys = (await Promise.all(patterns.map(p => r.keys(p)))).flat();
        if (keys.length > 0) await Promise.all(keys.map(k => r.del(k)));
        return NextResponse.json({ ok: true, cleared: keys.length, scope: scope ?? 'all', usingRedis: true });
      } catch { /* fall through */ }
    }
    return NextResponse.json({ ok: true, cleared: 0, usingRedis: false });
  }

  // 解鎖單一幣：保留 sentAt（8/6 修：歸零會讓 6h 冷卻在解鎖後失效）
  if (r) {
    try {
      const entry = await r.get<LockEntry>(`tlock:${symbol}`);
      if (entry) await r.set(`tlock:${symbol}`, { ...entry, locked: false }, { ex: LOCK_TTL_SEC });
    } catch { /* ignore */ }
  }
  return NextResponse.json({ ok: true, symbol, unlocked: true, usingRedis: !!r });
}
