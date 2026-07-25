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
      <div className="px-3 pt-14 pb-2.5 safe-top border-b border-[#1B222B]">
        <div className="flex items-center mb-2.5">
          <div>
            <h1 className="text-[#E8ECF1] text-[15px] font-medium tracking-[0.05em]">交易信號</h1>
            <p className="text-[#565E6B] text-[10px] mt-0.5 num">
              共 {allSignals.length} 筆{unread > 0 ? ` · ${unread} 個未讀` : ''}
            </p>
          </div>
          <span className="flex-1" />
          <div className="flex gap-1.5">
            {unread > 0 && (
              <button
                onClick={markAllRead}
                className="text-[#2DD4BF] text-[11px] border border-[#2DD4BF]/30 rounded px-2.5 py-1"
              >
                全部已讀
              </button>
            )}
            {allSignals.length > 0 && (
              <button
                onClick={() => {
                  if (confirm('確定清除所有歷史信號？')) clearSignals();
                }}
                className="text-[#F6465D] text-[11px] border border-[#F6465D]/30 rounded px-2.5 py-1"
              >
                清除
              </button>
            )}
          </div>
        </div>

        {/* ── Filters ── */}
        <div className="flex gap-1.5 mb-2">
          {(['ALL', 'LONG', 'SHORT'] as DirFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setDir(f)}
              className={`chip text-[11px] ${dir === f ? 'chip-active' : ''}`}
            >
              {f === 'ALL' ? '全部' : f === 'LONG' ? 'LONG' : 'SHORT'}
            </button>
          ))}
        </div>
        <div className="flex gap-1.5">
          {(['ALL', 'STRONG', 'MODERATE', 'WEAK'] as StrengthFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setStrength(f)}
              className={`chip text-[11px] ${strength === f ? 'chip-active' : ''}`}
            >
              {f === 'ALL' ? '全部強度' : f === 'STRONG' ? '強' : f === 'MODERATE' ? '中' : '弱'}
            </button>
          ))}
        </div>
      </div>

      {/* ── Signal list ── */}
      <div className="flex-1 overflow-y-auto px-3 pt-3 scroll-container">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 gap-4 text-center">
            <span className="text-[#2A323D] text-2xl num">[ ]</span>
            <div>
              <p className="text-[#8A94A2] font-medium">
                {allSignals.length === 0 ? '還沒有交易信號' : '沒有符合篩選條件的信號'}
              </p>
              <p className="text-[#565E6B] text-sm mt-1">
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
