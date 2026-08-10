'use client';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/store/useStore';
import { supabase } from '@/lib/supabase';
import { setIsResetting, clearSessionDeletedIds, removeCoinPermanently } from '@/components/StoreHydration';
import { SignalStrength, Timeframe } from '@/types';
import { FormField } from '@/components/ui/FormField';
import { ToggleChip } from '@/components/ui/ToggleChip';

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '';

function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const arr = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) arr[i] = rawData.charCodeAt(i);
  return arr.buffer;
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function isStandalone(): boolean {
  return (
    ('standalone' in navigator && (navigator as { standalone?: boolean }).standalone === true) ||
    window.matchMedia('(display-mode: standalone)').matches
  );
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const arr = new Uint8Array(buffer);
  let str = '';
  for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]);
  return btoa(str);
}

const INTERVALS = [5, 15, 30, 60];
const TFS: Timeframe[] = ['5m', '15m', '1h', '4h', '1d'];
const STRENGTHS: { value: SignalStrength; label: string; desc: string }[] = [
  { value: 'WEAK',     label: '全部',       desc: '所有信號，包含弱信號（較多雜訊）' },
  { value: 'MODERATE', label: '中等以上',  desc: '得分 ≥7，平衡質量與數量（推薦）' },
  { value: 'STRONG',   label: '僅強信號', desc: '得分 ≥12，最高可信度信號' },
];

interface AnalyzeResult {
  ok: boolean;
  // 2026-07-27 起 cron 改每分鐘一次，跟手動觸發撞鎖（monitor-run-lock/
  // scan-run-lock）的機率大增。撞鎖時 API 回 { ok:true, skipped: "..." }，
  // 沒有 notified/results——這不是「分析完成、什麼都沒發現」，是根本沒跑。
  skipped?: string;
  analyzedAt?: string;
  minScore?: number;
  notified?: string[];
  results?: {
    symbol: string;
    signalCount: number;
    topScore: number;
    topSignal: { direction: string; strength?: string; score: number; entry: number } | null;
    locked?: boolean;
    confluenceMet?: boolean;
    agreeTFs?: number;
    tfsAnalyzed?: string[];
    note?: string;
    error?: string;
  }[];
}

export default function SettingsPage() {
  const {
    coins, settings, webhookSecret,
    clearSignals, updateSettings, setWebhookSecret,
  } = useStore();
  const router = useRouter();

  const [userEmail, setUserEmail] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUserEmail(data.user?.email ?? '');
    });
  }, []);

  const handleLogout = async () => {
    setLoggingOut(true);
    await supabase.auth.signOut();
    useStore.getState().setUserId('');
    router.replace('/login');
  };

  const [secret, setSecret]       = useState(webhookSecret);
  const [appUrl, setAppUrl]         = useState('');
  const [copied, setCopied]         = useState(false);
  const [diagResult, setDiagResult] = useState<AnalyzeResult | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetMsg,    setResetMsg]    = useState('');
  const [fullResetting, setFullResetting] = useState(false);
  const [fullResetMsg,  setFullResetMsg]  = useState('');
  // Local string state so the field can be cleared while typing — committing
  // parseFloat directly made empty input snap back to the previous value
  // (the "stuck 1" bug: could never type 20 over a cleared field).
  const [acctInput, setAcctInput] = useState<string | null>(null);

  // ── Web Push state ─────────────────────────────────────────────
  type PushStatus = 'unknown' | 'unsupported' | 'ios-hint' | 'denied' | 'enabled' | 'disabled' | 'loading';
  const [pushStatus, setPushStatus]     = useState<PushStatus>('unknown');
  const [pushSub,    setPushSub]        = useState<PushSubscription | null>(null);
  type TestPushStatus = 'idle' | 'loading' | 'ok' | 'fail';
  const [pushTestStatus, setPushTestStatus] = useState<TestPushStatus>('idle');
  const [pushTestError,  setPushTestError]  = useState('');

  const checkPushStatus = useCallback(async () => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      setPushStatus('unsupported');
      return;
    }
    if (isIos() && !isStandalone()) {
      setPushStatus('ios-hint');
      return;
    }
    if (Notification.permission === 'denied') {
      setPushStatus('denied');
      return;
    }
    try {
      // getRegistration resolves immediately (undefined if no SW yet);
      // serviceWorker.ready hangs forever when no SW is registered.
      const reg = await navigator.serviceWorker.getRegistration('/');
      if (!reg) {
        setPushStatus('disabled');
        return;
      }
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        setPushSub(sub);
        setPushStatus('enabled');
      } else {
        setPushStatus('disabled');
      }
    } catch {
      setPushStatus('unsupported');
    }
  }, []);

  useEffect(() => { checkPushStatus(); }, [checkPushStatus]);

  const enablePush = async () => {
    if (!VAPID_PUBLIC_KEY) { alert('NEXT_PUBLIC_VAPID_PUBLIC_KEY 未設定'); return; }
    setPushStatus('loading');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') { setPushStatus('denied'); return; }

      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });

      const { data: { session } } = await supabase.auth.getSession();
      const jwt = session?.access_token ?? '';
      if (!jwt) { setPushStatus('disabled'); return; }

      const res = await fetch('/api/push-subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({
          endpoint: sub.endpoint,
          keys: {
            p256dh: arrayBufferToBase64(sub.getKey('p256dh')!),
            auth:   arrayBufferToBase64(sub.getKey('auth')!),
          },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        // Clean up the browser subscription so state stays consistent
        await sub.unsubscribe().catch(() => {});
        alert(`訂閱儲存失敗：${err.error ?? res.status}`);
        setPushStatus('disabled');
        return;
      }
      setPushSub(sub);
      setPushStatus('enabled');
    } catch (e) {
      console.error('[push] enable failed:', e);
      setPushStatus('disabled');
    }
  };

  const sendTestPush = async () => {
    setPushTestStatus('loading');
    setPushTestError('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const jwt = session?.access_token ?? '';
      if (!jwt) { setPushTestStatus('fail'); return; }
      const res = await fetch('/api/push-test', {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const data = await res.json() as {
        ok: boolean; subsCount?: number;
        vapidConfigured?: boolean; diagCount?: number; diagError?: string | null;
        results?: { ok: boolean; statusCode?: number; errorBody?: string; errorMessage?: string }[];
      };
      if (data.ok) {
        setPushTestStatus('ok');
      } else {
        const first = data.results?.find(r => !r.ok);
        let hint: string;
        if (first) {
          hint = `HTTP ${first.statusCode ?? '?'}: ${first.errorBody || first.errorMessage || '無詳情'}`;
        } else if ((data.subsCount ?? 0) === 0) {
          const dc = data.diagCount ?? -1;
          if (dc > 0 && data.vapidConfigured === false) {
            hint = `伺服器找到 ${dc} 筆訂閱，但 VAPID 金鑰未設定（請至 Vercel 環境變數加入 NEXT_PUBLIC_VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY）`;
          } else if (dc > 0) {
            hint = `伺服器找到 ${dc} 筆訂閱但發送仍失敗，請查 Vercel Function Logs`;
          } else if (dc === 0) {
            hint = '找不到訂閱，請重新啟用推播';
          } else {
            hint = 'SUPABASE_SERVICE_ROLE_KEY 未設定，無法查詢訂閱';
          }
        } else {
          hint = '發送失敗';
        }
        setPushTestError(hint);
        setPushTestStatus('fail');
      }
    } catch {
      setPushTestStatus('fail');
      setPushTestError('網路錯誤');
    }
    setTimeout(() => { setPushTestStatus('idle'); setPushTestError(''); }, 8000);
  };

  const disablePush = async () => {
    setPushStatus('loading');
    try {
      if (pushSub) {
        const { data: { session } } = await supabase.auth.getSession();
        const jwt = session?.access_token ?? '';
        if (jwt) {
          await fetch('/api/push-subscribe', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
            body: JSON.stringify({ endpoint: pushSub.endpoint }),
          });
        }
        await pushSub.unsubscribe();
        setPushSub(null);
      }
      setPushStatus('disabled');
    } catch (e) {
      console.error('[push] disable failed:', e);
      await checkPushStatus();
    }
  };

  useEffect(() => {
    if (typeof window !== 'undefined') setAppUrl(window.location.origin);
  }, []);

  const handleResetAllLocks = async () => {
    if (!confirm('確定要重置所有幣種的推播鎖定嗎？\n（解除後，下次分析達到條件即可重新推播）')) return;
    setResetting(true); setResetMsg('');
    try {
      const res  = await fetch('/api/analyze', { method: 'DELETE', headers: { 'x-webhook-secret': secret.trim() || 'abc123' } });
      const data = await res.json();
      setResetMsg(`已重置 ${data.cleared ?? 0} 個鎖定`);
    } catch {
      setResetMsg('重置失敗，請重試');
    } finally {
      setResetting(false);
      setTimeout(() => setResetMsg(''), 4000);
    }
  };

  const handleFullReset = async () => {
    if (!confirm(
      '警告：此操作將永久刪除全部交易紀錄與推薦單，無法復原，且所有已登入的裝置都會同步清空。\n\n確定要清空所有紀錄並重置嗎？'
    )) return;

    setFullResetting(true);
    setFullResetMsg('');

    try {
      // Block all background syncs so in-flight saves can't resurrect old data
      setIsResetting(true);
      clearSessionDeletedIds();

      // Wipe local state immediately (persist middleware synchronously clears localStorage)
      useStore.setState({ trades: [] });
      useStore.getState().clearSignals();

      // Get Supabase JWT for server-side user verification
      const { data: { session } } = await supabase.auth.getSession();
      const jwt = session?.access_token ?? '';

      const res = await fetch('/api/reset', {
        method: 'POST',
        headers: {
          'x-webhook-secret': secret.trim() || 'abc123',
          ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
        },
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }

      const data = await res.json() as { deletedTrades: number; clearedKeys: number; resetAt: number };

      // Stamp the local store with the server reset time so other open devices
      // detect the change on their next 2-min sync and also wipe their local cache.
      useStore.getState().setLastResetAt(data.resetAt);

      setFullResetMsg(`已清空 ${data.deletedTrades} 筆交易、解除 ${data.clearedKeys} 個 Redis 鎖定`);
    } catch (e) {
      setFullResetMsg(`重置失敗：${String(e).slice(0, 80)}`);
    } finally {
      setIsResetting(false);
      setFullResetting(false);
      setTimeout(() => setFullResetMsg(''), 8000);
    }
  };

  const saveWebhookSecret = () => {
    setWebhookSecret(secret.trim() || 'abc123');
  };

  // Manually trigger analyze and show full diagnostic
  const runDiag = async () => {
    setDiagLoading(true);
    setDiagResult(null);
    try {
      // No ?coins= → server uses its own dynamic top-15 list (same as cron)
      const res = await fetch('/api/analyze', { headers: { 'x-webhook-secret': secret.trim() || 'abc123' } });
      const data = await res.json();
      setDiagResult(data);
    } catch {
      setDiagResult({ ok: false });
    } finally {
      setDiagLoading(false);
    }
  };

  // No ?coins= so the cron uses the server's dynamic top-15 scan (not the client watchlist)
  const monitorUrl = `${appUrl}/api/analyze?secret=${encodeURIComponent(secret || 'abc123')}`;

  const copyUrl = () => {
    navigator.clipboard.writeText(monitorUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-14 pb-3 safe-top border-b border-white/[0.06]">
        <h1 className="text-text-p text-[15px] font-medium tracking-[0.05em]">設定</h1>
        <p className="text-text-m text-xs mt-0.5">通知、分析週期、幣種管理</p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pt-4 scroll-container space-y-4">

        {/* Account */}
        <Section title="帳號">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-text-p text-sm font-medium">{userEmail || '載入中…'}</p>
              <p className="text-text-m text-xs mt-0.5">已登入</p>
            </div>
            <button
              onClick={handleLogout}
              disabled={loggingOut}
              className="px-4 py-2 rounded-full border border-down/30 text-down text-sm disabled:opacity-40"
            >
              {loggingOut ? '登出中…' : '登出'}
            </button>
          </div>
        </Section>

        {/* Web Push */}
        <Section title="手機推播（Web Push）">
          {pushStatus === 'unknown' && (
            <p className="text-text-m text-xs">偵測中…</p>
          )}

          {pushStatus === 'unsupported' && (
            <div className="border border-[#C99A2E]/30 rounded-[10px] px-4 py-3">
              <p className="text-[#C99A2E] text-sm">此瀏覽器不支援推播</p>
              <p className="text-text-m text-xs mt-1">請使用 iOS 16.4+ Safari（已加入主畫面）或 Android Chrome</p>
            </div>
          )}

          {pushStatus === 'ios-hint' && (
            <div className="border border-accent/30 rounded-[10px] px-4 py-3 space-y-2">
              <p className="text-accent text-sm">iOS 需先加入主畫面</p>
              <p className="text-text-s text-xs leading-5">
                iOS 16.4+ 才支援 Web Push，且必須以 Standalone App 模式開啟：
              </p>
              <ol className="text-text-s text-xs leading-6 list-decimal list-inside space-y-1">
                <li>點 Safari 底部的 <span className="text-accent">分享</span> 按鈕</li>
                <li>選擇「<span className="text-accent">加入主畫面</span>」</li>
                <li>從主畫面的 App 圖示重新開啟</li>
                <li>回到此頁面啟用推播</li>
              </ol>
            </div>
          )}

          {pushStatus === 'denied' && (
            <div className="border border-down/30 rounded-[10px] px-4 py-3">
              <p className="text-down text-sm">推播權限已被封鎖</p>
              <p className="text-text-m text-xs mt-1">請到瀏覽器設定 → 網站設定 → 通知 → 允許此網站</p>
            </div>
          )}

          {(pushStatus === 'disabled' || pushStatus === 'loading') && (
            <div className="space-y-3">
              <div className="bg-card-2 rounded-[10px] px-4 py-3">
                <p className="text-text-p text-sm">狀態：<span className="text-text-m">未啟用</span></p>
                <p className="text-text-m text-xs mt-1">啟用後，信號、成交、止盈/止損通知將直接推送到此裝置</p>
              </div>
              <button
                onClick={enablePush}
                disabled={pushStatus === 'loading'}
                className="w-full py-3 rounded-full border border-accent/40 text-accent text-sm disabled:opacity-40"
              >
                {pushStatus === 'loading' ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                    啟用中…
                  </span>
                ) : '啟用手機推播'}
              </button>
            </div>
          )}

          {pushStatus === 'enabled' && (
            <div className="space-y-3">
              <div className="border border-up/30 rounded-[10px] px-4 py-3">
                <p className="text-up text-sm">推播已啟用</p>
                <p className="text-text-m text-xs mt-1 break-all">
                  {pushSub?.endpoint.slice(0, 60)}…
                </p>
              </div>
              <button
                onClick={sendTestPush}
                disabled={pushTestStatus === 'loading'}
                className="w-full py-2.5 rounded-full border border-accent/30 text-accent text-sm disabled:opacity-40"
              >
                {pushTestStatus === 'loading' ? '發送中…'
                  : pushTestStatus === 'ok'   ? '測試推播已送出'
                  : pushTestStatus === 'fail' ? '發送失敗'
                  : '發送測試推播'}
              </button>
              {pushTestError && (
                <p className="text-down text-xs border border-down/30 rounded-[10px] px-3 py-2 break-all">{pushTestError}</p>
              )}
              <button
                onClick={disablePush}
                className="w-full py-2.5 rounded-full bg-card-2 border border-white/[0.06] text-text-m text-sm"
              >
                關閉推播
              </button>
            </div>
          )}

          <p className="text-text-m text-xs mt-3 leading-5">
            推播從伺服器每小時自動掃描後觸發至此裝置
          </p>
        </Section>

        {/* Monitor URL + Diag */}
        <Section title="自動監控設定">
          <div className="mb-3 flex items-end gap-2">
            <div className="flex-1">
              <FormField
                label="Webhook 密鑰（要和 Vercel 環境變數一致）"
                value={secret}
                onChange={setSecret}
                placeholder="WEBHOOK_SECRET"
              />
            </div>
            <button onClick={saveWebhookSecret} className="btn-primary px-4 py-2.5 rounded-[10px] text-sm shrink-0">存</button>
          </div>

          <p className="text-text-m text-xs mb-2 leading-5">
            Vercel 每小時自動觸發。若需更高頻率，可將下方 URL 加到{' '}
            <span className="text-accent">cron-job.org</span>（免費）：
          </p>
          <div className="bg-card-2 rounded-[10px] p-3 mb-2">
            <p className="text-text-s text-xs font-mono break-all leading-5 num">{monitorUrl || '請先部署到 Vercel'}</p>
          </div>
          {appUrl && (
            <button onClick={copyUrl} className="w-full py-2.5 rounded-full bg-card-2 border border-white/[0.06] text-sm text-text-s mb-3">
              {copied ? '已複製' : '複製 URL'}
            </button>
          )}

          {/* Manual trigger + diagnostic */}
          <button
            onClick={runDiag}
            disabled={diagLoading}
            className="w-full py-2.5 rounded-full border border-up/30 text-up text-sm mb-3"
          >
            {diagLoading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-up border-t-transparent rounded-full animate-spin" />
                分析中…
              </span>
            ) : '手動觸發分析（查看通知診斷）'}
          </button>

          {diagResult && diagResult.skipped && (
            <div className="bg-card-2 rounded-[10px] p-3 text-xs space-y-1 border border-[#C99A2E]/30">
              <p className="text-[#C99A2E] num">未執行——伺服器排程正在跑（每分鐘一次）</p>
              <p className="text-text-m">{diagResult.skipped}，等它跑完再按一次，或直接等下一輪結果自然出現</p>
            </div>
          )}
          {diagResult && !diagResult.skipped && (
            <div className="bg-card-2 rounded-[10px] p-3 text-xs space-y-2">
              <p className="text-accent num">{diagResult.ok ? `分析完成（已掃描 ${diagResult.results?.length ?? 0} 檔）` : '分析失敗'}</p>
              <p className="text-text-s">
                已通知：{diagResult.notified?.join(', ') || '無'}
                {!diagResult.notified?.length && (
                  <span className="text-text-m">（無＝這次沒有新訊號通過進場關卡，非未執行——下方為各幣即時分析結果）</span>
                )}
              </p>
              {diagResult.results?.map((r) => (
                <div key={r.symbol} className={`rounded-[10px] px-3 py-2 border ${
                  diagResult.notified?.includes(r.symbol) ? 'border-up/30' :
                  r.locked                                ? 'border-[#C99A2E]/30' :
                  'border-white/[0.06]'
                }`}>
                  <div className="flex items-center justify-between">
                    <span className="text-text-p num">{r.symbol.replace('USDT', '')}</span>
                    <span className={diagResult.notified?.includes(r.symbol) ? 'text-up' : r.locked ? 'text-[#C99A2E]' : 'text-text-m'}>
                      {diagResult.notified?.includes(r.symbol) ? '已通知' : r.locked ? '持倉鎖定' : '—'}
                    </span>
                  </div>
                  {r.topSignal && (
                    <p className="text-text-s mt-1">
                      {r.topSignal.direction === 'LONG' ? 'LONG' : 'SHORT'} ·{' '}
                      <span className={`num ${r.topScore >= 16 ? 'text-up' : 'text-[#C99A2E]'}`}>{r.topScore}分</span>
                      {r.agreeTFs !== undefined && (
                        <span className={r.confluenceMet ? ' text-up' : ''}>
                          {' '}· {r.agreeTFs}/2 TF 同向{r.confluenceMet ? '（達標）' : '（未達）'}
                        </span>
                      )}
                    </p>
                  )}
                  {!r.topSignal && <p className="text-text-m mt-1">無信號（得分 {r.topScore}）</p>}
                  {r.note && <p className="text-[#C99A2E]/80 mt-1">{r.note}</p>}
                  {r.error && <p className="text-down mt-1">錯誤：{r.error}</p>}
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 border border-accent/20 rounded-[10px] px-4 py-3">
            <p className="text-accent text-xs mb-1">Vercel 環境變數</p>
            <p className="text-text-s text-xs font-mono leading-6 num">
              WEBHOOK_SECRET={secret || 'abc123'}<br />
              CRON_SECRET=任意密碼<br />
              ANALYSIS_TIMEFRAMES=4h,1h<br />
              MIN_SCORE=5<br />
              <span className="text-accent">NEXT_PUBLIC_SUPABASE_URL=你的url</span><br />
              <span className="text-accent">NEXT_PUBLIC_SUPABASE_ANON_KEY=你的key</span><br />
              <span className="text-accent">SUPABASE_SERVICE_ROLE_KEY=你的key</span><br />
              <span className="text-accent">SUPABASE_PROFILE_ID=你的 profiles.id</span><br />
              <span className="text-up">NEXT_PUBLIC_VAPID_PUBLIC_KEY=（見部署說明）</span><br />
              <span className="text-up">VAPID_PRIVATE_KEY=（見部署說明）</span>
            </p>
            <p className="text-text-m text-[10px] mt-2">藍色為 Supabase 必填；綠色為 Web Push 必填</p>
          </div>
        </Section>

        {/* Account Size + per-trade risk */}
        <Section title="帳戶資金（倉位計算用）">
          <p className="text-text-m text-xs mb-2 leading-5">
            設定後，每張信號會根據 <span className="text-accent num">{settings.riskPctPerTrade ?? 1}% 風險原則</span> 自動計算建議倉位、本金與槓桿
          </p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              inputMode="decimal"
              value={acctInput ?? String(settings.accountSize)}
              onChange={(e) => {
                setAcctInput(e.target.value);
                const v = parseFloat(e.target.value);
                if (!isNaN(v) && v > 0) updateSettings({ accountSize: v });
              }}
              onBlur={() => setAcctInput(null)} // snap display back to committed value
              placeholder="1000"
              className="w-full bg-card-2 border border-white/[0.06] rounded-[10px] px-3 py-2.5 text-[13px] text-text-p outline-none focus:border-accent focus:ring-1 focus:ring-accent/40 transition-colors flex-1"
            />
            <span className="text-text-m text-sm shrink-0">USDT</span>
          </div>

          <p className="text-text-m text-xs mt-3 mb-1.5">每筆風險比例（A 級單；B 級輕倉自動減半）</p>
          <div className="flex gap-1.5 flex-wrap">
            {[0.5, 1, 2, 3, 5, 10].map(p => (
              <ToggleChip
                key={p}
                label={`${p}%`}
                active={(settings.riskPctPerTrade ?? 1) === p}
                onClick={() => updateSettings({ riskPctPerTrade: p })}
              />
            ))}
          </div>
          {(settings.riskPctPerTrade ?? 1) >= 5 ? (
            <p className="text-[#F6465D]/90 text-xs mt-1.5">
              極高風險：連續 3 筆虧損就吃掉 {(3 * (settings.riskPctPerTrade ?? 1)).toFixed(0)}% 本金，
              小帳戶用來滿足交易所最低下單額時務必嚴守停損
            </p>
          ) : (settings.riskPctPerTrade ?? 1) >= 2 && (
            <p className="text-[#C99A2E]/80 text-xs mt-1.5">
              高風險模式：連續虧損時資金回撤會很快，小資金滾倉建議搭配嚴格停損紀律
            </p>
          )}
          <p className="text-text-m text-xs mt-2 num">
            每筆最大虧損 = {(settings.accountSize * (settings.riskPctPerTrade ?? 1) / 100).toFixed(2)} USDT（帳戶 {settings.riskPctPerTrade ?? 1}%）
          </p>
        </Section>

        {/* Cancel-push mute */}
        <Section title="推薦單失效通知">
          <p className="text-[#565E6B] text-xs mb-3 leading-5">
            每張達標訊號都會自動記一張紙上單；沒回測到進場價時系統會自動失效。
            關閉後這類「未進場」通知不再推播，但漏斗統計與方向 bias 判斷照常運作，不受影響。
          </p>
          <div className="flex gap-2">
            {[
              { v: false, label: '推播（預設）' },
              { v: true,  label: '靜音' },
            ].map(({ v, label }) => (
              <div key={String(v)} className="flex-1">
                <ToggleChip
                  label={label}
                  active={(settings.muteCancelPush ?? false) === v}
                  onClick={() => updateSettings({ muteCancelPush: v })}
                />
              </div>
            ))}
          </div>
        </Section>

        {/* Signal Strength */}
        <Section title="最低信號強度">
          <div className="space-y-2">
            {STRENGTHS.map(({ value, label, desc }) => (
              <button
                key={value}
                onClick={() => updateSettings({ minSignalStrength: value })}
                className={`w-full text-left px-4 py-3 rounded-[10px] border transition-all ${
                  settings.minSignalStrength === value
                    ? 'border-accent text-accent'
                    : 'border-white/[0.06] bg-card-2 text-text-s'
                }`}
              >
                <p className="text-sm">{label}</p>
                <p className={`text-xs mt-0.5 ${settings.minSignalStrength === value ? 'text-accent/70' : 'text-text-m'}`}>{desc}</p>
              </button>
            ))}
          </div>
        </Section>

        {/* Analysis interval */}
        <Section title="本地信號分析間隔">
          <p className="text-[#565E6B] text-xs mb-3 leading-5">
            客戶端每隔多久重新分析一次信號（價格更新仍每 30 秒一次）。伺服器每小時獨立掃描與推播，不受此設定影響。
          </p>
          <div className="flex gap-2">
            {INTERVALS.map((v) => (
              <div key={v} className="flex-1">
                <ToggleChip
                  label={`${v}m`}
                  active={settings.analysisIntervalMinutes === v}
                  onClick={() => updateSettings({ analysisIntervalMinutes: v })}
                />
              </div>
            ))}
          </div>
        </Section>

        {/* Timeframes */}
        <Section title="預設分析週期">
          <div className="flex gap-2">
            {TFS.map((t) => (
              <ToggleChip
                key={t}
                label={t}
                active={settings.defaultTimeframes.includes(t)}
                onClick={() => {
                  const cur = settings.defaultTimeframes;
                  const next = cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t];
                  if (next.length > 0) updateSettings({ defaultTimeframes: next });
                }}
              />
            ))}
          </div>
        </Section>

        {/* Coins */}
        <Section title="監控幣種">
          {coins.length === 0 ? (
            <p className="text-text-m text-sm text-center py-4">無監控幣種，請到首頁新增</p>
          ) : (
            <div className="space-y-2">
              {coins.map((coin) => (
                <div key={coin.symbol} className="flex items-center justify-between bg-white/[0.04] rounded-[10px] px-4 py-3">
                  <div>
                    <p className="text-text-p text-sm num">{coin.displayName}</p>
                    <p className="text-text-m text-xs mt-0.5">{coin.timeframes.join(' · ')}{coin.signals.length > 0 && ` · ${coin.signals.length} 個信號`}</p>
                  </div>
                  <button
                    onClick={() => { if (confirm('確定移除 ' + coin.displayName + '？')) removeCoinPermanently(coin.symbol); }}
                    className="text-down text-xs px-3 py-1.5 rounded-full border border-down/20"
                  >
                    移除
                  </button>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Cloud Sync */}
        <Section title="雲端同步（Supabase）">
          <div className="border border-up/20 rounded-[10px] px-4 py-3 mb-3">
            <p className="text-up text-xs mb-1">自動同步已啟用</p>
            <p className="text-text-m text-xs leading-5">
              交易紀錄、自選幣種、通知設定均自動同步至 Supabase。<br />
              任何裝置登入同一帳號，資料即時一致。
            </p>
          </div>
          <p className="text-text-m text-xs leading-5">
            同步時機：資料變動後 4 秒自動儲存，以及每 10 分鐘定期備份。<br />
            首次登入新裝置時自動從雲端載入所有紀錄。
          </p>
        </Section>

        {/* Data */}
        <Section title="資料管理">
          {/* Reset all signal notification locks */}
          {resetMsg && (
            <div className={`mb-3 px-3 py-2 rounded-[10px] text-xs ${
              resetMsg.includes('失敗') ? 'border border-down/30 text-down' : 'border border-up/30 text-up'
            }`}>{resetMsg}</div>
          )}
          <button
            onClick={handleResetAllLocks}
            disabled={resetting}
            className="w-full py-3 rounded-full border border-[#C99A2E]/30 text-[#C99A2E] text-sm mb-3 disabled:opacity-40"
          >
            {resetting ? '重置中…' : '重置所有推播鎖定'}
          </button>
          <p className="text-text-m text-xs mb-4 -mt-1">解除所有幣種的 24 小時推播鎖定，讓下次分析可以重新推播</p>
          <button
            onClick={() => { if (confirm('確定清除所有歷史信號？')) clearSignals(); }}
            className="w-full py-3 rounded-full border border-down/30 text-down text-sm"
          >
            清除所有歷史信號
          </button>

          {/* Full atomic reset */}
          <div className="mt-5 pt-4 border-t border-white/[0.06]">
            {fullResetMsg && (
              <div className={`mb-3 px-3 py-2 rounded-[10px] text-xs ${
                fullResetMsg.includes('失敗') ? 'border border-down/30 text-down' : 'border border-up/30 text-up'
              }`}>{fullResetMsg}</div>
            )}
            <button
              onClick={handleFullReset}
              disabled={fullResetting}
              className="w-full py-3 rounded-full border border-down/50 text-down text-sm disabled:opacity-40"
            >
              {fullResetting ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 border-2 border-down border-t-transparent rounded-full animate-spin" />
                  重置中…
                </span>
              ) : '清空所有紀錄並重置'}
            </button>
            <p className="text-text-m text-xs mt-2 leading-5">
              永久刪除全部交易紀錄、推薦單與 Redis 鎖定，所有裝置同步清空，無法復原
            </p>
          </div>

          <p className="text-text-m text-xs mt-4 text-center leading-6">
            資料來源：Binance API（僅讀取，不交易）<br />
            分析引擎：SMC · SNR · RSI · MACD · EMA<br />
            <span className="text-down/70">本 App 僅供參考，不構成投資建議</span>
          </p>
        </Section>

        <Section title="診斷">
          <button
            onClick={() => router.push('/funnel')}
            className="w-full py-3 rounded-full border border-accent/30 text-accent text-sm"
          >
            拒絕漏斗診斷（各關卡擋單統計 + 影子模擬淨R）
          </button>
        </Section>

        {/* Build version — a PWA tab can sit open on a stale bundle for days;
            this makes it obvious whether you're actually looking at the latest deploy. */}
        <p className="text-text-m text-[10px] text-center num pb-2">
          build {process.env.NEXT_PUBLIC_BUILD_SHA ? process.env.NEXT_PUBLIC_BUILD_SHA.slice(0, 7) : 'dev'}
        </p>

        <div className="h-4" />
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-card-2 border border-white/[0.06] rounded-xl p-3.5">
      <h2 className="tlabel mb-4">{title}</h2>
      {children}
    </div>
  );
}
