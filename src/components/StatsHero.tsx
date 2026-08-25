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
  // 2026-08-25：只算乾淨期（8/18 之後平倉）的 R。
  //
  // 上面的 totalR 涵蓋全部歷史，而歷史裡絕大部分是已知不可信的資料——實測
  // 103 筆已成交共 +16.82R，其中 27 筆 8/4 前的舊單就佔了 +16.14R，8/18
  // 之後的 21 筆是 −2.64R。使用者說「感覺只有大漲那天有營利」時畫面顯示
  // +25.8R：**體感是對的，畫面是錯的**，而那個數字每天在影響他的判斷。
  //
  // 不藏舊資料（那是另一種不誠實），而是把兩個期間並列、標清楚哪個能拿來
  // 判斷策略。分界依據見 src/lib/cleanPeriod.ts。
  cleanR: number | null;
  cleanCount: number;
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

export function StatsHero({
  totalR, avgR, weekR, winRate, expectedValue, equity, closedCount, pendingCount,
  cleanR, cleanCount,
}: Props) {
  const ev = expectedValue == null ? null : parseFloat(expectedValue);
  // 兩個期間差很多時才需要特別點出來。差不多的話多一行只是雜訊。
  const worthSplitting = cleanR != null && totalR != null
    && cleanCount > 0 && cleanCount < closedCount
    && Math.abs(totalR - cleanR) >= 1;
  return (
    <div className="bg-card-2 border border-white/[0.06] rounded-xl px-3.5 py-3 mb-2.5">
      <div className="flex items-center">
        <span className="tlabel">累積績效</span>
        <span className="flex-1" />
        {/* 2026-08-18：這個數字是 closedResults（已排除 CANCELLED 從未成交的
            推薦單），跟頁面標題那個「N 已結束」（closed，含 CANCELLED）本來就
            是兩個不同母體，但兩邊都只寫「結束」，看起來像同一個數字對不起來
            （實測 199 vs 84，差的 115 筆全是從未成交的推薦單）。標題改成
            「有損益」點明母體差異。 */}
        <span className="text-text-m text-[10px] num">{closedCount} 筆有損益 · {pendingCount} 持倉</span>
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

      {worthSplitting && (
        <div className="flex items-baseline gap-1.5 mt-1.5">
          <span className="text-[11px] num font-medium" style={{ color: col(cleanR) }}>
            {sign(cleanR!)}{cleanR!.toFixed(1)}R
          </span>
          <span className="text-text-s text-[10px]">
            自 8/18 起（{cleanCount} 筆）— 這段才能拿來判斷策略
          </span>
        </div>
      )}

      <div className="flex mt-3 pt-3 border-t border-white/[0.06] -mx-3.5">
        <Cell label="近 7 日" value={weekR == null ? '—' : `${sign(weekR)}${weekR.toFixed(1)}R`} color={col(weekR)} />
        <Cell label="勝率" value={winRate == null ? '—' : `${winRate}%`} color="#E8ECF1" border />
        <Cell label="每筆期望" value={ev == null ? '—' : `${ev >= 0 ? '+' : ''}${expectedValue}%`} color={ev == null ? '#E8ECF1' : ev >= 0 ? '#0ECB81' : '#F6465D'} border />
      </div>
    </div>
  );
}
