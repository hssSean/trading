'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/store/useStore';
import { SignalCard } from '@/components/SignalCard';
import { SignalDirection, SignalStrength } from '@/types';

type StrengthFilter = SignalStrength | 'ALL';
type DirFilter = SignalDirection | 'ALL';

export default function SignalsPage() {
  const router = useRouter();
  const { allSignals, markSignalRead, clearSignals } = useStore();

  const [dir, setDir] = useState<DirFilter>('ALL');
  const [strength, setStrength] = useState<StrengthFilter>('ALL');

  const filtered = allSignals
    .filter((s) => dir === 'ALL' || s.direction === dir)
    .filter((s) => strength === 'ALL' || s.strength === strength);

  const unread = allSignals.filter((s) => !s.isRead).length;

  const markAllRead = () =>
    allSignals.forEach((s) => !s.isRead && markSignalRead(s.id));

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ── */}
      <div className="px-4 pt-14 pb-3 safe-top border-b border-[#1E1E2E]">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-[#EAEAF4] text-xl font-extrabold">交易信號</h1>
            <p className="text-[#606080] text-xs mt-0.5">
              共 {allSignals.length} 筆{unread > 0 ? ` · ${unread} 個未讀` : ''}
            </p>
          </div>
          <div className="flex gap-2">
            {unread > 0 && (
              <button
                onClick={markAllRead}
                className="text-[#F0B90B] text-xs font-semibold border border-[#F0B90B]/30 rounded-full px-3 py-1.5"
              >
                全部已讀
              </button>
            )}
            {allSignals.length > 0 && (
              <button
                onClick={() => {
                  if (confirm('確定清除所有歷史信號？')) clearSignals();
                }}
                className="text-red-400 text-xs font-semibold border border-red-400/30 rounded-full px-3 py-1.5"
              >
                清除
              </button>
            )}
          </div>
        </div>

        {/* ── Filters ── */}
        <div className="flex gap-2 mb-2">
          {(['ALL', 'LONG', 'SHORT'] as DirFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setDir(f)}
              className={`chip text-xs ${dir === f ? 'chip-active' : ''}`}
            >
              {f === 'ALL' ? '全部' : f === 'LONG' ? '做多 ▲' : '做空 ▼'}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          {(['ALL', 'STRONG', 'MODERATE', 'WEAK'] as StrengthFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setStrength(f)}
              className={`chip text-xs ${strength === f ? 'chip-active' : ''}`}
            >
              {f === 'ALL' ? '全部強度' : f === 'STRONG' ? '強' : f === 'MODERATE' ? '中' : '弱'}
            </button>
          ))}
        </div>
      </div>

      {/* ── Signal list ── */}
      <div className="flex-1 overflow-y-auto px-4 pt-3 scroll-container">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 gap-4 text-center">
            <span className="text-4xl">📊</span>
            <div>
              <p className="text-[#A0A0C0] font-semibold">
                {allSignals.length === 0 ? '還沒有交易信號' : '沒有符合篩選條件的信號'}
              </p>
              <p className="text-[#606080] text-sm mt-1">
                {allSignals.length === 0
                  ? '回到首頁點擊「重新分析」'
                  : '請調整篩選條件'}
              </p>
            </div>
          </div>
        ) : (
          filtered.map((signal) => (
            <SignalCard
              key={signal.id}
              signal={signal}
              onClick={() => {
                markSignalRead(signal.id);
                router.push(`/analysis/${signal.symbol}`);
              }}
            />
          ))
        )}
        <div className="h-4" />
      </div>
    </div>
  );
}
