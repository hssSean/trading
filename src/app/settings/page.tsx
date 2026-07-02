'use client';
import { useState, useEffect } from 'react';
import { useStore } from '@/store/useStore';
import { SignalStrength, Timeframe } from '@/types';

const INTERVALS = [5, 15, 30, 60];
const TFS: Timeframe[] = ['15m', '1h', '4h', '1d'];
const STRENGTHS: { value: SignalStrength; label: string; desc: string }[] = [
  { value: 'WEAK',     label: '★ 全部',       desc: '所有信號，包含弱信號（較多雜訊）' },
  { value: 'MODERATE', label: '★★ 中等以上',  desc: '得分 ≥7，平衡質量與數量（推薦）' },
  { value: 'STRONG',   label: '★★★ 僅強信號', desc: '得分 ≥12，最高可信度信號' },
];

type TestStatus = 'idle' | 'sending' | 'ok' | 'fail';

interface AnalyzeResult {
  ok: boolean;
  analyzedAt?: string;
  minScore?: number;
  lineReady?: boolean;
  notified?: string[];
  results?: {
    symbol: string;
    signalCount: number;
    topScore: number;
    topSignal: { direction: string; score: number; entry: number } | null;
    lineSent: boolean;
    lineError?: string;
    error?: string;
  }[];
}

export default function SettingsPage() {
  const {
    coins, settings, lineToken, lineUserId, webhookSecret,
    removeCoin, clearSignals, updateSettings, setLine, setWebhookSecret,
  } = useStore();

  const [token, setToken]         = useState(lineToken);
  const [userId, setUserId]       = useState(lineUserId);
  const [secret, setSecret]       = useState(webhookSecret);
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testError, setTestError]   = useState('');
  const [appUrl, setAppUrl]         = useState('');
  const [copied, setCopied]         = useState(false);
  const [guideOpen, setGuideOpen]   = useState(false);
  const [diagResult, setDiagResult] = useState<AnalyzeResult | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined') setAppUrl(window.location.origin);
  }, []);

  const saveLine = () => {
    setLine(token.trim(), userId.trim());
    setWebhookSecret(secret.trim() || 'abc123');
  };

  const testLine = async () => {
    if (!token.trim() || !userId.trim()) return;
    setTestStatus('sending');
    setTestError('');
    try {
      const res = await fetch('/api/test-line', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelToken: token.trim(), userId: userId.trim() }),
      });
      const data = await res.json();
      if (data.ok) { setTestStatus('ok'); }
      else { setTestStatus('fail'); setTestError(data.error ?? '發送失敗'); }
    } catch {
      setTestStatus('fail');
      setTestError('網路錯誤');
    }
    setTimeout(() => { setTestStatus('idle'); setTestError(''); }, 4000);
  };

  // Manually trigger analyze and show full diagnostic
  const runDiag = async () => {
    setDiagLoading(true);
    setDiagResult(null);
    try {
      const coinList = coins.map((c) => c.symbol).join(',');
      const url = `/api/analyze?secret=${encodeURIComponent(secret.trim() || 'abc123')}&coins=${coinList}`;
      const res = await fetch(url);
      const data = await res.json();
      setDiagResult(data);
    } catch (e) {
      setDiagResult({ ok: false });
    } finally {
      setDiagLoading(false);
    }
  };

  const monitorUrl = `${appUrl}/api/analyze?secret=${encodeURIComponent(secret || 'abc123')}&coins=${coins.map((c) => c.symbol).join(',')}`;

  const copyUrl = () => {
    navigator.clipboard.writeText(monitorUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const unsaved = token.trim() !== lineToken || userId.trim() !== lineUserId || (secret.trim() || 'abc123') !== webhookSecret;

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-14 pb-3 safe-top border-b border-[#1E1E2E]">
        <h1 className="text-[#EAEAF4] text-xl font-extrabold">設定</h1>
        <p className="text-[#606080] text-xs mt-0.5">通知、分析週期、幣種管理</p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pt-4 scroll-container space-y-4">

        {/* LINE */}
        <Section title="💬 LINE 通知設定">
          <button
            onClick={() => setGuideOpen((v) => !v)}
            className="w-full flex items-center justify-between bg-blue-500/10 border border-blue-500/30 rounded-xl px-4 py-3 mb-3"
          >
            <span className="text-blue-400 text-sm font-semibold">📖 設定教學</span>
            <span className="text-blue-400 text-xs">{guideOpen ? '▲ 收起' : '▼ 展開'}</span>
          </button>

          {guideOpen && (
            <div className="bg-[#1A1A26] rounded-xl p-4 mb-3 space-y-3 text-xs text-[#A0A0C0] leading-relaxed">
              <p><span className="text-[#F0B90B] font-bold">步驟 1</span> — 開啟 developers.line.biz → 建立 Provider → 建立 Messaging API channel</p>
              <p><span className="text-[#F0B90B] font-bold">步驟 2</span> — 進入 Channel → 「Messaging API」分頁 → 滾到底 → 「Channel access token」→ Issue → 複製</p>
              <p><span className="text-[#F0B90B] font-bold">步驟 3</span> — 「Basic settings」分頁 → 找「Your user ID」(格式 Uxxxxxx) → 複製</p>
              <p><span className="text-[#F0B90B] font-bold">步驟 4</span> — 用手機掃 QR Code 加 Bot 好友（必做！）</p>
            </div>
          )}

          <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Channel Access Token" className="input-field mb-2" />
          <input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="User ID（格式：Uxxxxxxxxxxxxxxxx）" className="input-field mb-3" />

          {testError && <p className="text-red-400 text-xs mb-2 bg-red-500/10 rounded-lg px-3 py-2">{testError}</p>}

          <div className="flex gap-2">
            <button onClick={saveLine} disabled={!unsaved} className="flex-1 btn-primary py-2.5 rounded-xl text-sm disabled:opacity-40">
              {unsaved ? '儲存' : '✓ 已儲存'}
            </button>
            <button
              onClick={testLine}
              disabled={!token.trim() || !userId.trim() || testStatus === 'sending'}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-[#1A1A26] text-[#A0A0C0] border border-[#1E1E2E] disabled:opacity-40"
            >
              {testStatus === 'sending' ? '發送中…' : testStatus === 'ok' ? '✅ 成功！' : testStatus === 'fail' ? '❌ 失敗' : '測試發送'}
            </button>
          </div>
        </Section>

        {/* Monitor URL + Diag */}
        <Section title="⏰ 自動監控設定">
          <div className="mb-3">
            <p className="text-[#606080] text-xs mb-1.5 font-semibold">Webhook 密鑰（要和 Vercel 環境變數一致）</p>
            <div className="flex gap-2">
              <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="WEBHOOK_SECRET" className="input-field flex-1" />
              <button onClick={saveLine} className="btn-primary px-4 rounded-xl text-sm shrink-0">存</button>
            </div>
          </div>

          <p className="text-[#606080] text-xs mb-2 leading-5">
            複製下方 URL 到 <span className="text-[#F0B90B]">cron-job.org</span>（免費，每小時觸發）或 UptimeRobot：
          </p>
          <div className="bg-[#1A1A26] rounded-xl p-3 mb-2">
            <p className="text-[#A0A0C0] text-xs font-mono break-all leading-5">{monitorUrl || '請先部署到 Vercel'}</p>
          </div>
          {appUrl && (
            <button onClick={copyUrl} className="w-full py-2.5 rounded-xl bg-[#1A1A26] border border-[#1E1E2E] text-sm text-[#A0A0C0] font-semibold mb-3">
              {copied ? '✅ 已複製！' : '複製 URL'}
            </button>
          )}

          {/* Manual trigger + diagnostic */}
          <button
            onClick={runDiag}
            disabled={diagLoading}
            className="w-full py-2.5 rounded-xl bg-green-500/10 border border-green-500/30 text-green-400 text-sm font-semibold mb-3"
          >
            {diagLoading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-green-400 border-t-transparent rounded-full animate-spin" />
                分析中…
              </span>
            ) : '🔍 手動觸發分析（查看通知診斷）'}
          </button>

          {diagResult && (
            <div className="bg-[#1A1A26] rounded-xl p-3 text-xs space-y-2">
              <p className="text-[#F0B90B] font-bold">
                {diagResult.ok ? '✅ 分析完成' : '❌ 分析失敗'} · 門檻得分：{diagResult.minScore} · LINE {diagResult.lineReady ? '✓' : '✗ 未設定'}
              </p>
              <p className="text-[#A0A0C0]">已通知：{diagResult.notified?.join(', ') || '無'}</p>
              {diagResult.results?.map((r) => (
                <div key={r.symbol} className={`rounded-lg px-3 py-2 border ${r.lineSent ? 'border-green-500/30 bg-green-500/5' : 'border-[#2A2A3E] bg-[#12121A]'}`}>
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-[#EAEAF4]">{r.symbol}</span>
                    <span className={r.lineSent ? 'text-green-400' : 'text-[#606080]'}>
                      {r.lineSent ? '✅ LINE 已發送' : '— 未發送'}
                    </span>
                  </div>
                  <p className="text-[#606080] mt-1">
                    最高得分 <span className={r.topScore >= (diagResult.minScore ?? 5) ? 'text-green-400' : 'text-red-400'}>{r.topScore}</span>
                    {r.topSignal ? ` · ${r.topSignal.direction} · 入場 $${r.topSignal.entry}` : ' · 無信號'}
                  </p>
                  {r.lineError && <p className="text-red-400 mt-1">LINE 錯誤：{r.lineError}</p>}
                  {r.error && <p className="text-red-400 mt-1">錯誤：{r.error}</p>}
                  {!r.lineSent && !r.lineError && r.topScore < (diagResult.minScore ?? 5) && (
                    <p className="text-yellow-400/70 mt-1">得分不足（需 ≥{diagResult.minScore}）</p>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 bg-yellow-400/5 border border-yellow-400/20 rounded-xl px-4 py-3">
            <p className="text-[#F0B90B] text-xs font-semibold mb-1">Vercel 環境變數</p>
            <p className="text-[#A0A0C0] text-xs font-mono leading-6">
              LINE_CHANNEL_TOKEN=你的token<br />
              LINE_USER_ID=你的userId<br />
              WEBHOOK_SECRET={secret || 'abc123'}<br />
              CRON_SECRET=任意密碼<br />
              WATCH_COINS=BTCUSDT,ETHUSDT,SOLUSDT<br />
              ANALYSIS_TIMEFRAMES=4h,1h<br />
              MIN_SCORE=5
            </p>
          </div>
        </Section>

        {/* Account Size */}
        <Section title="💰 帳戶資金（倉位計算用）">
          <p className="text-[#606080] text-xs mb-2 leading-5">
            設定後，每張信號卡會根據 <span className="text-[#F0B90B]">1% 風險原則</span> 自動計算建議倉位大小
          </p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={settings.accountSize}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (!isNaN(v) && v > 0) updateSettings({ accountSize: v });
              }}
              placeholder="1000"
              className="input-field flex-1"
            />
            <span className="text-[#606080] text-sm shrink-0">USDT</span>
          </div>
          <p className="text-[#404060] text-xs mt-2">
            每筆最大虧損 = {(settings.accountSize * 0.01).toFixed(0)} USDT（帳戶 1%）
          </p>
        </Section>

        {/* Signal Strength */}
        <Section title="📶 最低信號強度">
          <div className="space-y-2">
            {STRENGTHS.map(({ value, label, desc }) => (
              <button
                key={value}
                onClick={() => updateSettings({ minSignalStrength: value })}
                className={`w-full text-left px-4 py-3 rounded-xl border transition-all ${
                  settings.minSignalStrength === value
                    ? 'border-[#F0B90B] bg-yellow-400/10 text-[#F0B90B]'
                    : 'border-[#1E1E2E] bg-[#1A1A26] text-[#A0A0C0]'
                }`}
              >
                <p className="font-semibold text-sm">{label}</p>
                <p className={`text-xs mt-0.5 ${settings.minSignalStrength === value ? 'text-yellow-400/70' : 'text-[#606080]'}`}>{desc}</p>
              </button>
            ))}
          </div>
        </Section>

        {/* Timeframes */}
        <Section title="📊 預設分析週期">
          <div className="flex gap-2">
            {TFS.map((t) => (
              <button
                key={t}
                onClick={() => {
                  const cur = settings.defaultTimeframes;
                  const next = cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t];
                  if (next.length > 0) updateSettings({ defaultTimeframes: next });
                }}
                className={`chip ${settings.defaultTimeframes.includes(t) ? 'chip-active' : ''}`}
              >
                {t}
              </button>
            ))}
          </div>
        </Section>

        {/* Coins */}
        <Section title="💼 監控幣種">
          {coins.length === 0 ? (
            <p className="text-[#606080] text-sm text-center py-4">無監控幣種，請到首頁新增</p>
          ) : (
            <div className="space-y-2">
              {coins.map((coin) => (
                <div key={coin.symbol} className="flex items-center justify-between bg-[#1A1A26] rounded-xl px-4 py-3">
                  <div>
                    <p className="text-[#EAEAF4] font-semibold text-sm">{coin.displayName}</p>
                    <p className="text-[#606080] text-xs mt-0.5">{coin.timeframes.join(' · ')}{coin.signals.length > 0 && ` · ${coin.signals.length} 個信號`}</p>
                  </div>
                  <button
                    onClick={() => { if (confirm('確定移除 ' + coin.displayName + '？')) removeCoin(coin.symbol); }}
                    className="text-red-400 text-xs font-semibold px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20"
                  >
                    移除
                  </button>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Data */}
        <Section title="🗑️ 資料管理">
          <button
            onClick={() => { if (confirm('確定清除所有歷史信號？')) clearSignals(); }}
            className="w-full py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm font-semibold"
          >
            清除所有歷史信號
          </button>
          <p className="text-[#606080] text-xs mt-4 text-center leading-6">
            資料來源：Binance API（僅讀取，不交易）<br />
            分析引擎：SMC · SNR · RSI · MACD · EMA<br />
            <span className="text-red-400/70">本 App 僅供參考，不構成投資建議</span>
          </p>
        </Section>

        <div className="h-4" />
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <h2 className="text-[#EAEAF4] font-bold text-sm mb-4">{title}</h2>
      {children}
    </div>
  );
}
