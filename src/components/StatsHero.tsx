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

const col  = (v: number | null) => (v == null ? '#E8ECF1' : v >= 0 ? '#0ECB81' : '#F6465D');
const sign = (v: number) => (v >= 0 ? '+' : '');

function Spark({ data }: { data: number[] }) {
  if (data.length < 2) return null;
  const min = Math.min(0, ...data);
  const max = Math.max(0, ...data);
  const range = max - min || 1;
  const W = 84, H = 28;
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
      <polyline points={pts} fill="none" stroke={up ? '#0ECB81' : '#F6465D'} strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Cell({ label, value, color, border }: { label: string; value: string; color: string; border?: boolean }) {
  return (
    <div className={`flex-1 px-3 ${border ? 'border-l border-white/[0.06]' : ''}`}>
      <div className="tlabel">{label}</div>
      <div className="text-[15px] font-medium num mt-1" style={{ color }}>{value}</div>
    </div>
  );
}

export function StatsHero({ totalR, avgR, weekR, winRate, expectedValue, equity, closedCount, pendingCount }: Props) {
  const ev = expectedValue == null ? null : parseFloat(expectedValue);
  return (
    <div className="bg-card-2 border border-white/[0.06] rounded-xl px-3.5 py-3 mb-2.5">
      <div className="flex items-center">
        <span className="tlabel">累積績效</span>
        <span className="flex-1" />
        <span className="text-text-m text-[10px] num">{closedCount} 結束 · {pendingCount} 持倉</span>
      </div>

      <div className="flex items-end gap-3 mt-2">
        <span className="text-[29px] font-medium leading-none num" style={{ color: col(totalR) }}>
          {totalR == null ? '—' : `${sign(totalR)}${totalR.toFixed(1)}R`}
        </span>
        {avgR != null && (
          <span className="text-[12px] num pb-0.5 text-text-s">每筆 {sign(avgR)}{avgR.toFixed(2)}R</span>
        )}
        <span className="flex-1" />
        <Spark data={equity} />
      </div>

      <div className="flex mt-3 pt-3 border-t border-white/[0.06] -mx-3.5">
        <Cell label="近 7 日" value={weekR == null ? '—' : `${sign(weekR)}${weekR.toFixed(1)}R`} color={col(weekR)} />
        <Cell label="勝率" value={winRate == null ? '—' : `${winRate}%`} color="#E8ECF1" border />
        <Cell label="每筆期望" value={ev == null ? '—' : `${ev >= 0 ? '+' : ''}${expectedValue}%`} color={ev == null ? '#E8ECF1' : ev >= 0 ? '#0ECB81' : '#F6465D'} border />
      </div>
    </div>
  );
}
