'use client';
// 一個座位：泡泡＋Clawd＋木桌＋名牌＋狀態燈。點擊開詳細卡。
import type { Seat } from '@/lib/office/seats';
import { Clawd } from './Clawd';

const LAMP: Record<Seat['state'], string> = {
  working: '#f4c430', celebrate: '#3ccf4e', alert: '#ff3b30', idle: '#8d8d8d', unknown: '#555b66',
};

/** 每個座位錯開眨眼時間：用 id 算一個固定的相位 */
const phase = (id: string) => id.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 47 / 10;

export function PixelSeat({ seat, t, look, onClick, big = false }: {
  seat: Seat; t: number; look: [number, number]; onClick: () => void; big?: boolean;
}) {
  const blink = (t + phase(seat.id)) % 4.2 < 0.15;
  return (
    <button type="button" onClick={onClick}
      className="group relative flex flex-col items-center pt-1 pb-2 rounded-md bg-[#3b2a1e]/40 hover:bg-[#3b2a1e]/70 transition-colors text-left">
      <span className={`max-w-full truncate px-1.5 py-0.5 mb-1 text-[10px] leading-4 font-mono rounded-sm border
        ${seat.state === 'alert' ? 'bg-[#3a1212] border-[#ff3b30]/60 text-[#ffb4ae]' : 'bg-[#f4f1e8] border-[#2a1d14] text-[#2a1d14]'}`}>
        {seat.bubble}
      </span>
      <Clawd state={seat.state} accessory={seat.accessory} t={t} look={look} blink={blink} size={big ? 104 : 76} />
      <div className="w-full h-3 -mt-1 bg-[#7a5232] border-t-2 border-[#a5744a] shadow-[0_3px_0_#4a301d]" />
      <div className="mt-2 flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-[1px]" style={{ background: LAMP[seat.state], boxShadow: seat.state === 'alert' ? '0 0 6px #ff3b30' : undefined }} />
        <span className="font-mono text-[11px] tracking-wider text-[#f0dcc0] bg-[#2a1d14] px-1.5 border border-[#a5744a]">{seat.label}</span>
      </div>
    </button>
  );
}
