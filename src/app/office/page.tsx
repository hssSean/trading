'use client';
// 像素辦公室：8 個模組畫成 Clawd 員工＋SQUAWK 跑馬燈（設計 docs/superpowers/specs/2026-11-13-office-view-design.md）。
// 只讀現有的 /api/s3/{overview,signals,ledgers}，60 秒更新。開發環境 ?demo=1 用假資料、不需登入。
import { Suspense, useMemo, useState, type PointerEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useS3Api } from '@/lib/s3s1/useS3Api';
import type { LedgersResp, OverviewResp, SignalsResp } from '@/lib/s3s1/apiTypes';
import { buildSeats, buildSquawk, type Seat } from '@/lib/office/seats';
import { DEMO_NOW, demoLedgers, demoOverview, demoSignals } from '@/lib/office/demo';
import { PixelSeat } from '@/components/office/PixelSeat';
import { Squawk } from '@/components/office/Squawk';
import { useTick } from '@/components/office/useTick';
import { ErrorBox, PageHeader } from '@/components/s3/ui';

const ALLOW_DEMO = process.env.NODE_ENV !== 'production';

export default function OfficePage() {
  // Next 14：用 useSearchParams 的 client 頁要包 Suspense，否則 next build 失敗
  return <Suspense fallback={null}><OfficeInner /></Suspense>;
}

function OfficeInner() {
  const params = useSearchParams();
  const demo = ALLOW_DEMO && params.get('demo') === '1';
  const ov = useS3Api<OverviewResp>(demo ? '' : '/api/s3/overview', demo ? undefined : 60_000);
  const sig = useS3Api<SignalsResp>(demo ? '' : '/api/s3/signals', demo ? undefined : 60_000);
  const led = useS3Api<LedgersResp>(demo ? '' : '/api/s3/ledgers', demo ? undefined : 60_000);
  const t = useTick(8);
  const [look, setLook] = useState<[number, number]>([0, 0]);
  const [open, setOpen] = useState<Seat | null>(null);

  const minute = Math.floor(Date.now() / 60_000);
  const { seats, squawk } = useMemo(() => {
    const o = demo ? demoOverview() : ov.data, s = demo ? demoSignals() : sig.data, l = demo ? demoLedgers() : led.data;
    const now = demo ? DEMO_NOW : Date.now();
    return { seats: buildSeats(o, s, l, now), squawk: buildSquawk(o, s) };
  }, [demo, ov.data, sig.data, led.data, minute]);

  // 眼睛追游標／最後點擊的位置：相對畫面中心，量化成 ±0.5 格
  const onPointer = (e: PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    const dx = (e.clientX - r.left) / r.width - 0.5, dy = (e.clientY - r.top) / r.height - 0.5;
    setLook([Math.round(dx * 2) / 4, Math.round(dy * 2) / 4]);
  };

  const [chief, ...rest] = seats;
  const errors = demo ? [] : [ov.error, sig.error, led.error].filter(Boolean);
  const loading = !demo && ov.loading && sig.loading && led.loading;

  return (
    <div className="min-h-screen bg-[#0A0D11] text-[#E8ECF1]" onPointerMove={onPointer} onPointerDown={onPointer}>
      <PageHeader title="辦公室" sub={demo ? '假資料預覽（?demo=1）' : '每個座位是一個正在跑的模組・60 秒更新'} />
      <div className="px-3 py-3 space-y-3 pb-20">
        {errors.length > 0 && <ErrorBox text={errors.join('；')} />}
        {loading && <p className="text-[#565E6B] text-xs text-center py-2">載入中…</p>}
        <div className="rounded-xl p-3 border-2 border-[#4a301d]"
          style={{ background: 'repeating-linear-gradient(90deg,#5a3b26 0 22px,#4f3421 22px 24px), #5a3b26' }}>
          <div className="flex justify-center mb-3">
            <div className="w-1/2 min-w-[140px]"><PixelSeat seat={chief} t={t} look={look} big onClick={() => setOpen(chief)} /></div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {rest.map(s => <PixelSeat key={s.id} seat={s} t={t} look={look} onClick={() => setOpen(s)} />)}
          </div>
        </div>
        <Squawk lines={squawk} />
      </div>

      {open && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-end justify-center" onClick={() => setOpen(null)}>
          <div className="w-full max-w-xl bg-[#0D0D16] border-t-2 border-[#a5744a] rounded-t-xl p-4 pb-8" onClick={e => e.stopPropagation()}>
            <p className="font-mono text-sm text-[#f0dcc0]">{open.label}<span className="text-[#565E6B] text-xs ml-2">{open.role}</span></p>
            <p className="text-xs mt-1 text-[#8A94A2]">{open.bubble}</p>
            <dl className="mt-3 space-y-1 text-xs">
              {open.details.map(d => (
                <div key={d.k} className="flex justify-between gap-3"><dt className="text-[#565E6B]">{d.k}</dt><dd className="text-right num">{d.v}</dd></div>
              ))}
              {open.details.length === 0 && <p className="text-[#565E6B]">沒有更多資料</p>}
            </dl>
            <Link href={open.href} className="block mt-4 text-center text-xs py-2 rounded-lg border border-[#1B222B] text-[#7fb2ff]">到原頁面看 →</Link>
          </div>
        </div>
      )}
    </div>
  );
}
