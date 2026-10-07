'use client';
// 首頁：S3-A＋S3-B testnet 真倉總覽（同帳戶分帳）（2026-10-07 改版，docs/superpowers/specs/2026-10-07-s3-app-redesign-design.md）。
// 舊策略的自選幣首頁搬到 /legacy。資料來自 /api/s3/overview，每 30 秒更新。
import { useEffect, useMemo } from 'react';
import { useS3Api } from '@/lib/s3s1/useS3Api';
import type { OverviewResp } from '@/lib/s3s1/apiTypes';
import { todaySummary } from '@/lib/s3s1/view';
import { useS3Store } from '@/store/useS3Store';
import { usePriceStore } from '@/store/usePriceStore';
import { StatusStrip, TodayCard, LiveAccountCard, LivePositionCard, useNow } from '@/components/s3/HomeCards';
import { Card, Empty, ErrorBox, PageHeader } from '@/components/s3/ui';

export default function HomePage() {
  const { data, error, loading } = useS3Api<OverviewResp>('/api/s3/overview', 30_000);
  const now = useNow();
  const setNav = useS3Store((s) => s.set);
  const setExtra = usePriceStore((s) => s.setExtraSymbols);

  // 今天只隨資料或換日改變，不必每秒重算
  const day = Math.floor(now / 86_400_000);
  const today = useMemo(
    () => (data ? todaySummary(data.snapshot, data.signals, Date.now()) : null),
    [data, day],
  );

  useEffect(() => {
    if (!data || !today) return;
    setNav({ todayOpens: today.opened.length, openCount: data.positions.length });
    setExtra(data.positions.map(p => p.symbol));
  }, [data, today, setNav, setExtra]);

  return (
    <div className="min-h-screen bg-[#0A0D11] text-[#E8ECF1]">
      <PageHeader title="S3 趨勢策略" sub="日線唐奇安突破＋分數・S3-A＋S3-B testnet 真倉" />
      <div className="px-3 py-3 space-y-2 pb-20">
        {loading && !data && <p className="text-[#565E6B] text-xs text-center py-8">載入中…</p>}
        {error && <ErrorBox text={error} />}
        {data && today && (
          <>
            <StatusStrip heartbeatAt={data.heartbeatAt} meta={data.meta} now={now} />
            <TodayCard today={today} now={now} />
            <LiveAccountCard meta={data.meta} />
            <p className="text-[#565E6B] text-[10px] px-1 pt-2">持倉（{data.positions.length}）</p>
            {data.positions.length === 0 ? (
              <Card><Empty text={'目前沒有持倉。S3 一個月約 2 筆、獲利集中在少數大趨勢，沒單是常態。'} /></Card>
            ) : (
              data.positions.map(p => <LivePositionCard key={p.symbol} p={p} />)
            )}
          </>
        )}
      </div>
    </div>
  );
}
