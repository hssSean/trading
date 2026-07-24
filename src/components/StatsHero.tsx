'use client';

interface Props {
  totalR: number | null;
  avgR: number | null;
  weekR: number | null;
  winRate: number | null;
  expectedValue: string | null; // EV% per trade (pre-formatted string) or null
  equity: number[];             // cumulative equity curve for the sparkline
  closedCount: number;
  pendingCount: number;
}

const col  = (v: number | null) => (v == null ? '#EAEDF2' : v >= 0 ? '#0ECB81' : '#F6465D');
const sign = (v: number) => (v >= 0 ? '+' : '');

function Spark({ data }: { data: number[] }) {
  if (data.length < 2) return null;
  const min = Math.min(0, ...data);
  const max = Math.max(0, ...data);
  const range = max - min || 1;
  const W = 84, H = 30;
  const pts = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * W;
      const y = H - ((v - min) / range) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const up = (data[data.length - 1] ?? 0) >= 0;
  return (
    <svg width={W} height={H} className="shrink-0" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={up ? '#0ECB81' : '#F6465D'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Cell({ label, value, color, align }: { label: string; value: string; color: string; align: 'left' | 'center' | 'right' }) {
  const a = align === 'left' ? 'items-start' : align === 'right' ? 'items-end' : 'items-center';
  return (
    <div className={`flex-1 flex flex-col ${a}`}>
      <span className="text-[#59616E] text-[11px]">{label}</span>
      <span className="text-[15px] font-medium num mt-0.5" style={{ color }}>{value}</span>
    </div>
  );
}

export function StatsHero({ totalR, avgR, weekR, winRate, expectedValue, equity, closedCount, pendingCount }: Props) {
  const ev = expectedValue == null ? null : parseFloat(expectedValue);
  return (
    <div className="bg-[#12161C] border border-[#222A35] rounded-xl p-4 mb-3">
      <div className="flex items-center">
        <span className="text-[#97A2B0] text-xs">累積績效</span>
        <span className="flex-1" />
        <span className="text-[#59616E] text-[11px] num">{closedCount} 結束 · {pendingCount} 持倉</span>
      </div>

      <div className="flex items-end gap-3 mt-2">
        <span className="text-[30px] font-medium leading-none num" style={{ color: col(totalR) }}>
          {totalR == null ? '—' : `${sign(totalR)}${totalR.toFixed(1)}R`}
        </span>
        {avgR != null && (
          <span className="text-[13px] num pb-0.5" style={{ color: col(avgR) }}>每筆 {sign(avgR)}{avgR.toFixed(2)}R</span>
        )}
        <span className="flex-1" />
        <Spark data={equity} />
      </div>

      <div className="flex mt-3.5 pt-3 border-t border-[#1B2129]">
        <Cell label="近 7 日" value={weekR == null ? '—' : `${sign(weekR)}${weekR.toFixed(1)}R`} color={col(weekR)} align="left" />
        <Cell label="勝率" value={winRate == null ? '—' : `${winRate}%`} color="#EAEDF2" align="center" />
        <Cell label="每筆期望" value={ev == null ? '—' : `${ev >= 0 ? '+' : ''}${expectedValue}%`} color={ev == null ? '#EAEDF2' : ev >= 0 ? '#0ECB81' : '#F6465D'} align="right" />
      </div>
    </div>
  );
}
