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

  // 2026-08-09：進度條是照「止損→TP2」整段距離的真實價格比例畫的，圓點
  // 位置沒有算錯——但 TP1 到 TP2 的距離通常遠小於止損到 TP1 的距離，導致
  // TP1 本身落在進度條很靠右的位置（實測案例：TP1 落在 86% 處），使用者
  // 只看圓點視覺位置容易誤以為「已經很接近/打到 TP1」，其實可能還差
  // 一段。加一條刻度線標出 TP1 真正的位置，圓點有沒有越過那條線才是
  // 「有沒有到 TP1」的直接視覺答案，不用只靠下面的文字換算。
  // tp1===tp2（策略B均值回歸，見下方判斷）沒有這個問題，不需要標記。
  const tp1Ratio = tp1 === tp2 ? null : calcProgressRatio({ direction, stopLoss, tp2, current: tp1 });

  return (
    <div>
      <div className="relative h-1.5 rounded-full bg-white/[0.07] mb-2">
        <div
          className="absolute left-0 top-0 h-full rounded-full bg-accent transition-[width] duration-1000 ease-out"
          style={{ width: `${pct}%` }}
        />
        {tp1Ratio !== null && (
          <div
            className="absolute top-1/2 w-0.5 h-3 bg-white/50 rounded-full"
            style={{ left: `${tp1Ratio * 100}%`, transform: 'translate(-50%, -50%)' }}
            title={`TP1 ${formatPrice(tp1)}`}
          />
        )}
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
