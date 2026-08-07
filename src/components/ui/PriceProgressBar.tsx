import { calcProgressRatio } from '@/lib/priceProgress';

interface PriceProgressBarProps {
  direction: 'LONG' | 'SHORT';
  stopLoss: number;
  entry: number;
  tp1: number;
  tp2: number;
  current: number;
  formatPrice: (n: number) => string;
}

export function PriceProgressBar({ direction, stopLoss, entry, tp1, tp2, current, formatPrice }: PriceProgressBarProps) {
  const ratio = calcProgressRatio({ direction, stopLoss, tp2, current });
  const pct = ratio * 100;

  return (
    <div>
      <div className="relative h-1.5 rounded-full bg-white/[0.07] mb-2">
        <div
          className="absolute left-0 top-0 h-full rounded-full bg-accent transition-[width] duration-1000 ease-out"
          style={{ width: `${pct}%` }}
        />
        <div
          className="absolute top-1/2 w-3.5 h-3.5 rounded-full bg-accent shadow-[0_0_0_3px_rgba(45,212,191,0.25)] transition-[left] duration-1000 ease-out"
          style={{ left: `${pct}%`, transform: 'translate(-50%, -50%)' }}
        />
      </div>
      <div className="flex justify-between text-[10px] num">
        <span className="text-down">止損 {formatPrice(stopLoss)}</span>
        <span className="text-text-s">進場 {formatPrice(entry)}</span>
        {tp1 === tp2 ? (
          // 均值回歸策略只有單一止盈目標（回到布林中軌），TP1/TP2 本來就同一個
          // 值——不是 bug，見 signals.ts generateMeanReversionSignals 的
          // takeProfits: [tp1, tp1]。分開顯示兩個一樣的數字容易讓人誤會是故障。
          <span className="text-accent">止盈 {formatPrice(tp1)}</span>
        ) : (
          <>
            <span className="text-accent">TP1 {formatPrice(tp1)}</span>
            <span className="text-accent">TP2 {formatPrice(tp2)}</span>
          </>
        )}
      </div>
    </div>
  );
}
