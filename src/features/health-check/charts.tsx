'use client';
// 績效體檢的兩張圖：權益曲線（累計損益）與損益分布直方圖。
// 沿用 trades 頁的手刻 SVG 作風，不引入圖表庫。

interface EquityProps {
  pnls: number[]; // 依出場時間排序的每筆損益
}

export function EquityCurveChart({ pnls }: EquityProps) {
  if (pnls.length < 2) return null;
  const cum: number[] = [];
  let acc = 0;
  for (const p of pnls) { acc += p; cum.push(acc); }

  const W = 320, H = 120, PAD = 6;
  const min = Math.min(0, ...cum);
  const max = Math.max(0, ...cum);
  const range = max - min || 1;
  const sx = (i: number) => PAD + (i / (cum.length - 1)) * (W - PAD * 2);
  const sy = (v: number) => PAD + (1 - (v - min) / range) * (H - PAD * 2);

  const path = cum.map((v, i) => `${i === 0 ? 'M' : 'L'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');
  const zeroY = sy(0);
  const final = cum[cum.length - 1];
  const color = final >= 0 ? '#00C851' : '#FF4444';

  return (
    <div className="bg-[#12121A] border border-[#1E1E2E] rounded-2xl p-3">
      <p className="text-[#606080] text-[10px] font-bold uppercase tracking-widest mb-2">權益曲線（累計損益）</p>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
        <line x1={PAD} y1={zeroY} x2={W - PAD} y2={zeroY} stroke="#1E1E2E" strokeWidth="1" strokeDasharray="3 3" />
        <path d={path} fill="none" stroke={color} strokeWidth="1.5" />
      </svg>
      <p className={`text-right text-xs font-bold ${final >= 0 ? 'text-[#00C851]' : 'text-[#FF4444]'}`}>
        最終 {final >= 0 ? '+' : ''}{final.toFixed(2)}
      </p>
    </div>
  );
}

export function PnlHistogram({ pnls }: EquityProps) {
  if (pnls.length < 2) return null;
  const min = Math.min(...pnls);
  const max = Math.max(...pnls);
  if (min === max) return null;

  const BINS = Math.min(12, Math.max(6, Math.ceil(Math.sqrt(pnls.length))));
  const width = (max - min) / BINS;
  const counts = new Array<number>(BINS).fill(0);
  const mids = new Array<number>(BINS).fill(0);
  for (let b = 0; b < BINS; b++) mids[b] = min + (b + 0.5) * width;
  for (const p of pnls) {
    let b = Math.floor((p - min) / width);
    if (b >= BINS) b = BINS - 1;
    counts[b]++;
  }
  const maxCount = Math.max(...counts);

  const W = 320, H = 110, PAD = 6;
  const bw = (W - PAD * 2) / BINS;

  return (
    <div className="bg-[#12121A] border border-[#1E1E2E] rounded-2xl p-3">
      <p className="text-[#606080] text-[10px] font-bold uppercase tracking-widest mb-2">損益分布</p>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
        {counts.map((c, b) => {
          const h = maxCount ? (c / maxCount) * (H - PAD * 2 - 10) : 0;
          const x = PAD + b * bw;
          const isWin = mids[b] > 0;
          return (
            <rect
              key={b}
              x={x + 1}
              y={H - PAD - h}
              width={Math.max(bw - 2, 1)}
              height={h}
              rx="2"
              fill={isWin ? '#00C851' : '#FF4444'}
              opacity={c === 0 ? 0.12 : 0.75}
            />
          );
        })}
      </svg>
      <div className="flex justify-between text-[9px] text-[#404060]">
        <span>{min.toFixed(0)}</span>
        <span>0</span>
        <span>{max.toFixed(0)}</span>
      </div>
    </div>
  );
}
