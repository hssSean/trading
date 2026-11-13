'use client';
// SQUAWK 跑馬燈：最近的訊號（開倉綠、擋單灰附理由），新到舊。
import { fmtHm, type SquawkLine } from '@/lib/office/seats';

export function Squawk({ lines }: { lines: SquawkLine[] }) {
  return (
    <div className="rounded-lg border-2 border-[#33323f] bg-[#16151f] font-mono text-[11px] leading-5 overflow-hidden">
      <div className="flex justify-between px-2.5 py-1 bg-[#23222f] text-[#e6c35c] tracking-widest">
        <span>SQUAWK</span><span className="text-[#565E6B]">{lines.length}</span>
      </div>
      <div className="max-h-64 overflow-y-auto px-2.5 py-1.5 space-y-0.5">
        {lines.length === 0 && <p className="text-[#565E6B]">沒有訊號紀錄</p>}
        {lines.map(l => (
          <p key={l.key} className="flex gap-2 min-w-0">
            <span className="text-[#565E6B] shrink-0">{fmtHm(l.at)}</span>
            <span className={`shrink-0 w-12 ${l.tone === 'open' ? 'text-[#5fd068]' : 'text-[#7fb2ff]'}`}>{l.tag}</span>
            <span className={`truncate ${l.tone === 'open' ? 'text-[#5fd068]' : 'text-[#8A94A2]'}`}>{l.text}</span>
          </p>
        ))}
      </div>
    </div>
  );
}
