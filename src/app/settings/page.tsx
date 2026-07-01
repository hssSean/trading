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

export default function SettingsPage() {
  const {
    coins, settings, lineToken, lineUserId,
    removeCoin, clearSignals, updateSettings, setLine,
  } = useStore();

  const [token, setToken]   = useState(lineToken);
  const [userId, setUserId] = useState(lineUserId);
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testError, setTestError]   = useState('');
  const [appUrl, setAppUrl]         = useState('');
  const [copied, setCopied]         = useState(false);
  const [guideOpen, setGuideOpen]   = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined') setAppUrl(window.location.origin);
  }, []);

  // ── Save + test LINE ──
  const saveLine = () => setLine(token.trim(), userId.trim());

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
      if (data.ok) {
        setTestStatus('ok');
      } else {
        setTestStatus('fail');
        setTestError(data.error ?? '發送失敗');
      }
    } catch {
      setTestStatus('fail');
      setTestError('網路錯誤，請稍後再試');
    }
    setTimeout(() => { setTestStatus('idle'); setTestError(''); }, 4000);
  };

  const monitorUrl = `${appUrl}/api/analyze?secret=my-secret&coins=${coins.map((c) => c.symbol).join(',')}`;

  const copyUrl = () => {
    navigator.clipboard.writeText(monitorUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const unsavedLine = token.trim() !== lineToken || userId.trim() !== lineUserId;

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-14 pb-3 safe-top border-b border-[#1E1E2E]">
        <h1 className="text-[#EAEAF4] text-xl font-extrabold">設定</h1>
        <p className="text-[#606080] text-xs mt-0.5">通知、分析週期、幣種管理</p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pt-4 scroll-container space-y-4">

        {/* ── LINE Messaging API ── */}
        <Section title="💬 LINE 通知設定">

          {/* Setup Guide Toggle */}
          <button
            onClick={() => setGuideOpen((v) => !v)}
            className="w-full flex items-center justify-between bg-blue-500/10 border border-blue-500/30 rounded-xl px-4 py-3 mb-3"
          >
            <span className="text-blue-400 text-sm font-semibold">📖 設定教學（如何取得 Token 和 User ID）</span>
            <span className="text-blue-400">{guideOpen ? '▲' : '▼'}</span>
          </button>

          {guideOpen && (
            <div className="bg-[#1A1A26] rounded-xl p-4 mb-3 space-y-3 text-xs text-[#A0A0C0] leading-relaxed">
              <div>
                <p className="text-[#F0B90B] font-bold mb-1">步驟 1 — 建立 LINE Bot</p>
                <p>1. 開啟 <span className="text-blue-400">developers.line.biz</span> 並登入</p>
                <p>2. 點「Create a new provider」→ 輸入名稱</p>
                <p>3. 點「Create a new channel」→ 選「Messaging API」</p>
                <p>4. 填寫 App name（例如 Crypto Trader）、描述、Category</p>
              </div>
              <div>
                <p className="text-[#F0B90B] font-bold mb-1">步驟 2 — 取得 Channel Access Token</p>
                <p>1. 進入你的 Messaging API Channel</p>
                <p>2. 點「Messaging API」分頁</p>
                <p>3. 滾到底找「Channel access token」→ 點「Issue」</p>
                <p>4. 複製那串 token，貼到下方</p>
              </div>
              <div>
                <p className="text-[#F0B90B] font-bold mb-1">步驟 3 — 取得你的 User ID</p>
                <p>1. 點「Basic settings」分頁</p>
                <p>2. 滾到「Your user ID」欄位，格式為 <span className="font-mono text-green-400">Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx</span></p>
                <p>3. 複製貼到下方</p>
              </div>
              <div>
                <p className="text-[#F0B90B] font-bold mb-1">步驟 4 — 加入 Bot 好友</p>
                <p>在「Messaging API」分頁，用手機掃描 QR Code 加你的 Bot 為好友，這樣才能收到訊息</p>
              </div>
            </div>
          )}

          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Channel Access Token"
            className="input-field mb-2"
          />
          <input
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="User ID（格式：Uxxxxxxxxxxxxxxxx）"
            className="input-field mb-3"
          />

          {testError && (
            <p className="text-red-400 text-xs mb-2 bg-red-500/10 rounded-lg px-3 py-2">{testError}</p>
          )}

          <div className="flex gap-2">
            <button
              onClick={saveLine}
              disabled={!unsavedLine}
              className="flex-1 btn-primary py-2.5 rounded-xl text-sm disabled:opacity-40"
            >
              {unsavedLine ? '儲存' : '✓ 已儲存'}
            </button>
            <button
              onClick={testLine}
              disabled={!token.trim() || !userId.trim() || testStatus === 'sending'}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-[#1A1A26] text-[#A0A0C0] border border-[#1E1E2E] disabled:opacity-40"
            >
              {testStatus === 'sending' ? (
                <span className="flex items-center justify-center gap-1.5">
                  <span className="w-3 h-3 border-2 border-[#A0A0C0] border-t-transparent rounded-full animate-spin" />
                  發送中
                </span>
              ) : testStatus === 'ok' ? '✅ 成功！'
                : testStatus === 'fail' ? '❌ 失敗'
                : '測試發送'}
            </button>
          </div>
        </Section>

        {/* ── UptimeRobot ── */}
        <Section title="⏰ 自動監控（UptimeRobot）">
          <p className="text-[#606080] text-xs mb-3 leading-5">
            部署到 Vercel 後，到 <span className="text-[#F0B90B]">uptimerobot.com</span>（免費）
            建立「HTTP(s)」監控，輸入下方 URL，每 5 分鐘自動分析並推送 LINE 通知：
          </p>
          <div className="bg-[#1A1A26] rounded-xl p-3 mb-2">
            <p className="text-[#A0A0C0] text-xs font-mono break-all leading-5">
              {monitorUrl || '先部署到 Vercel 後此處會顯示完整 URL'}
            </p>
          </div>
          {appUrl && (
            <button
              onClick={copyUrl}
              className="w-full py-2.5 rounded-xl bg-[#1A1A26] border border-[#1E1E2E] text-sm text-[#A0A0C0] font-semibold"
            >
              {copied ? '✅ 已複製！' : '複製 URL'}
            </button>
          )}
          <div className="mt-3 bg-yellow-400/5 border border-yellow-400/20 rounded-xl px-4 py-3">
            <p className="text-[#F0B90B] text-xs font-semibold mb-1">Vercel 環境變數設定</p>
            <p className="text-[#A0A0C0] text-xs font-mono leading-6">
              LINE_CHANNEL_TOKEN=你的token<br />
              LINE_USER_ID=你的userId<br />
              WEBHOOK_SECRET=my-secret<br />
              WATCH_COINS=BTCUSDT,ETHUSDT<br />
              ANALYSIS_TIMEFRAMES=4h,1h<br />
              MIN_SCORE=7
            </p>
          </div>
        </Section>

        {/* ── Analysis Interval ── */}
        <Section title="🔄 分析頻率">
          <p className="text-[#606080] text-xs mb-3">UptimeRobot 最短支援 5 分鐘，建議設 15 分鐘</p>
          <div className="flex gap-2">
            {INTERVALS.map((m) => (
              <button
                key={m}
                onClick={() => updateSettings({ analysisIntervalMinutes: m })}
                className={`chip ${settings.analysisIntervalMinutes === m ? 'chip-active' : ''}`}
              >
                {m >= 60 ? `${m / 60}h` : `${m}m`}
              </button>
            ))}
          </div>
        </Section>

        {/* ── Timeframes ── */}
        <Section title="📊 預設分析週期">
          <p className="text-[#606080] text-xs mb-3">新增幣種時套用的週期（可複選）</p>
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

        {/* ── Signal Strength ── */}
        <Section title="📶 最低信號強度篩選">
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
                <p className={`text-xs mt-0.5 ${settings.minSignalStrength === value ? 'text-yellow-400/70' : 'text-[#606080]'}`}>
                  {desc}
                </p>
              </button>
            ))}
          </div>
        </Section>

        {/* ── Coin Management ── */}
        <Section title="💼 監控幣種管理">
          {coins.length === 0 ? (
            <p className="text-[#606080] text-sm text-center py-4">無監控幣種，請到首頁新增</p>
          ) : (
            <div className="space-y-2">
              {coins.map((coin) => (
                <div
                  key={coin.symbol}
                  className="flex items-center justify-between bg-[#1A1A26] rounded-xl px-4 py-3"
                >
                  <div>
                    <p className="text-[#EAEAF4] font-semibold text-sm">{coin.displayName}</p>
                    <p className="text-[#606080] text-xs mt-0.5">
                      {coin.timeframes.join(' · ')}
                      {coin.signals.length > 0 && ` · ${coin.signals.length} 個信號`}
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      if (confirm(`確定移除 ${coin.displayName}？`)) removeCoin(coin.symbol);
                    }}
                    className="text-red-400 text-xs font-semibold px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20"
                  >
                    移除
                  </button>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* ── Data Management ── */}
        <Section title="🗑️ 資料管理">
          <button
            onClick={() => {
              if (confirm('確定清除所有歷史信號？此動作無法復原。')) clearSignals();
            }}
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
