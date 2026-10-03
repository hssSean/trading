'use client';
// 紙上策略追蹤（2026-10-03 部署）：策略 A（日線 Keltner）與影片策略 A/B/C 的紙上紀錄。
// 只記錄、不下單；資料由 /api/analyze 每天 UTC 00:20 後寫入 Redis（src/lib/paper/runner.ts），
// 這頁透過 /api/paper-stats 讀取。統計口徑與 scripts/paper-report.ts 共用 src/lib/paper/stats.ts。
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { type PaperSummary, type PaperRecord } from '@/lib/paper/stats';
import { PaperStratCard } from '@/components/PaperStratCard';

interface Resp {
  ok: boolean;
  reason?: string;
  trackStart: { strategyA: number | null; video: number | null };
  lastRunDay: { strategyA: number | null; video: number | null };
  strategies: { summary: PaperSummary; recent: PaperRecord[] }[];
}

const fmtT = (t: number | null | undefined) => {
  if (!t) return '—';
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const fmtD = (t: number | null | undefined) => (t ? `${new Date(t).getMonth() + 1}/${new Date(t).getDate()}` : '—');

export default function PaperPage() {
  const router = useRouter();
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const jwt = session?.access_token ?? '';
      if (!jwt) { setError('尚未登入，無法查詢'); return; }
      const res = await fetch('/api/paper-stats', { headers: { Authorization: `Bearer ${jwt}` } });
      const json = await res.json() as Resp;
      if (!res.ok || !json.ok) { setError(json.reason ?? `查詢失敗（${res.status}）`); setData(null); }
      else setData(json);
    } catch (e) {
      setError(String(e).slice(0, 150));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="min-h-screen bg-[#0A0D11] text-[#E8ECF1]">
      <div className="px-3 pt-14 pb-2.5 safe-top border-b border-[#1B222B]">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[15px] font-medium tracking-[0.05em]">紙上策略追蹤</h1>
            <p className="text-[#565E6B] text-[10px] mt-0.5">只記錄、不下單・每天早上 08:20 後更新</p>
          </div>
          <button
            onClick={() => router.push('/settings')}
            className="text-[#8A94A2] text-[11px] px-2.5 py-1 border border-[#232B35] rounded active:bg-[#141A21]"
          >
            返回設定
          </button>
        </div>
        {data && (
          <p className="text-[#3A424E] text-[10px] mt-2 num">
            起點 {fmtT(data.trackStart.strategyA ?? data.trackStart.video)}・最近更新 策略A {fmtD(data.lastRunDay.strategyA)}／影片 {fmtD(data.lastRunDay.video)}
          </p>
        )}
      </div>

      <div className="px-3 py-3 space-y-2 pb-20">
        {loading && <p className="text-[#565E6B] text-xs text-center py-8">載入中…</p>}
        {error && (
          <div className="bg-[#0D0D16] border border-[#F6465D]/30 rounded-xl p-3">
            <p className="text-[#F6465D] text-xs">{error}</p>
          </div>
        )}
        {!loading && !error && data && !data.trackStart.strategyA && !data.trackStart.video && (
          <p className="text-[#565E6B] text-xs text-center py-8">還沒開始記錄</p>
        )}
        {!loading && !error && data?.strategies.map(x => <PaperStratCard key={x.summary.key} {...x} />)}
        {!loading && !error && data && (
          <p className="text-[#3A424E] text-[10px] leading-4 px-1 pt-2">
            「回測」是規格裡的回測數字（策略 A 為持倉上限 10 筆的版本）。R ＝ 以止損距離為 1 單位的報酬，已扣手續費與資金費率。
            在達到判斷所需筆數之前，數字只是進度，不要據此決定上線或放棄。
          </p>
        )}
      </div>
    </div>
  );
}
