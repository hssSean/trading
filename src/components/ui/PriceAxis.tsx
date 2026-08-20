import { calcAxisPositions, ZONE_COLOR, PriceZone } from '@/lib/priceAxis';

// 2026-08-21：取代 PriceProgressBar。差別在標籤**釘在真實比例位置**（絕對
// 定位）而不是 justify-between 平均分佈——舊版那樣會讓「進場」標籤跟軸上
// 真正的進場刻度差到 11 個百分點，使用者因此看不出「現價還沒到進場價」。
// 位置算式在 src/lib/priceAxis.ts，有測試。
//
// 分段上色（使用者要求「價格到 TP1 後要變不同顏色」）：
//   止損→進場 紅（風險區）｜進場→TP1 綠（有賺沒到目標）｜TP1→TP2 青（已達標）
// 現價標記本身也跟著 zone 換色，滑過清單時不用讀數字就知道這單走到哪。

interface PriceAxisProps {
  direction: 'LONG' | 'SHORT';
  stopLoss: number;
  entry: number;
  tp1: number;
  tp2: number;
  current: number;
  formatPrice: (n: number) => string;
  // TP1 後的移動止損。有值時左半段轉灰、並標出這條線——移動止損上移之後
  // 「止損到移動止損」那段在經濟意義上已經不存在，再用紅色畫會誇大風險。
  trailingStop?: number | null;
  // 已結束的交易：標出實際出場點，並把整體調暗（歷史不該跟活單搶注意力）。
  exitPrice?: number | null;
  // 距離文字（例如「距 TP1 0.94%」）——只有活單才算得出來，掛在刻度下方
  // 省掉使用者自己心算。
  distToTp1Label?: string;
  distToStopLabel?: string;
}

export function PriceAxis({
  direction, stopLoss, entry, tp1, tp2, current, formatPrice,
  trailingStop, exitPrice, distToTp1Label, distToStopLabel,
}: PriceAxisProps) {
  const pos = calcAxisPositions({ direction, stopLoss, entry, tp1, tp2, current });
  const isClosed = exitPrice != null;
  const markerPct = isClosed
    ? calcAxisPositions({ direction, stopLoss, entry, tp1, tp2, current: exitPrice }).current
    : pos.current;
  const markerZone: PriceZone = isClosed
    ? calcAxisPositions({ direction, stopLoss, entry, tp1, tp2, current: exitPrice }).zone
    : pos.zone;
  const markerColor = ZONE_COLOR[markerZone];

  const trailPct = trailingStop != null
    ? calcAxisPositions({ direction, stopLoss, entry, tp1, tp2, current: trailingStop }).current
    : null;
  // tp1===tp2 是策略B單一止盈（signals.ts generateMeanReversionSignals），
  // 分開標兩個一樣的數字會讓人以為故障。
  const singleTp = tp1 === tp2;

  return (
    <div className={isClosed ? 'opacity-90' : undefined}>
      {!isClosed && (
        <div className="relative h-[34px]">
          <div
            className="absolute -translate-x-1/2 whitespace-nowrap text-[11px] num px-1.5 py-0.5 rounded"
            style={{ left: `${markerPct}%`, color: markerColor, backgroundColor: 'rgba(255,255,255,0.06)' }}
          >
            {formatPrice(current)}
          </div>
          <div
            className="absolute top-[22px] w-px h-3 -translate-x-1/2"
            style={{ left: `${markerPct}%`, backgroundColor: markerColor }}
          />
        </div>
      )}

      <div className="relative h-2 rounded-full overflow-hidden bg-[#161C24]">
        <div
          className="absolute left-0 top-0 h-full"
          style={{
            width: `${trailPct ?? pos.entry}%`,
            backgroundColor: trailPct != null ? 'rgba(89,97,110,0.22)' : 'rgba(246,70,93,0.30)',
          }}
        />
        <div
          className="absolute top-0 h-full"
          style={{
            left: `${trailPct ?? pos.entry}%`,
            width: `${Math.max(0, pos.tp1 - (trailPct ?? pos.entry))}%`,
            backgroundColor: 'rgba(14,203,129,0.32)',
          }}
        />
        <div
          className="absolute top-0 h-full"
          style={{ left: `${pos.tp1}%`, width: `${100 - pos.tp1}%`, backgroundColor: 'rgba(45,212,191,0.38)' }}
        />
        <div
          className="absolute top-0 w-0.5 h-full"
          style={{ left: `${pos.entry}%`, backgroundColor: isClosed ? '#59616E' : '#EAEDF2' }}
        />
        {trailPct != null && (
          <div className="absolute top-0 w-0.5 h-full bg-accent" style={{ left: `${trailPct}%` }} />
        )}
        {isClosed && (
          <div
            className="absolute top-0 w-[3px] h-full"
            style={{ left: `${markerPct}%`, backgroundColor: markerColor }}
          />
        )}
      </div>

      <div className="relative h-[30px] mt-1.5 text-[10px] num">
        <div className="absolute left-0 top-0 text-down">
          {distToStopLabel ?? '止損'}
          <br /><span className="text-text-s">{formatPrice(stopLoss)}</span>
        </div>

        {trailPct != null && (
          <div className="absolute top-0 -translate-x-1/2 text-center whitespace-nowrap text-accent" style={{ left: `${trailPct}%` }}>
            移動止損
            <br /><span className="text-text-s">{formatPrice(trailingStop!)}</span>
          </div>
        )}

        <div
          className="absolute top-0 -translate-x-1/2 text-center whitespace-nowrap text-text-m"
          style={{ left: `${pos.entry}%` }}
        >
          進場
          <br /><span className="text-text-s">{formatPrice(entry)}</span>
        </div>

        {!singleTp && (
          <div
            className="absolute top-0 -translate-x-1/2 text-center whitespace-nowrap text-accent"
            style={{ left: `${pos.tp1}%` }}
          >
            {distToTp1Label ?? 'TP1'}
            <br /><span className="text-text-s">{formatPrice(tp1)}</span>
          </div>
        )}

        <div className="absolute right-0 top-0 text-right text-accent">
          {singleTp ? '止盈' : 'TP2'}
          <br /><span className="text-text-s">{formatPrice(tp2)}</span>
        </div>
      </div>

      {isClosed && (
        <div className="mt-0.5 text-[10px] num" style={{ color: markerColor }}>
          出場 {formatPrice(exitPrice)}
        </div>
      )}
    </div>
  );
}
