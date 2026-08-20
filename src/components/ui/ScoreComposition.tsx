import type { ScoreBreakdown } from '@/types';

// 2026-08-21：取代原本那行「評分：趨勢13 · 動能3 · 結構9 · 量能0 · K線5」。
//
// 舊寫法把五組擠成一行純文字，每組看起來一樣重要，得自己讀數字才知道這張單
// 的性格。改成迷你長條 + 依得分高低排序，一眼看得出「趨勢很強、量能掛零」。
// 分母用 signals.ts 的 GROUP_CAPS，不是佔總分的比例——重點是「這組拿到上限
// 的幾成」，那才看得出強弱；用佔比會讓上限只有 10 分的組永遠顯得無足輕重。
const GROUP_CAPS = { trend: 15, momentum: 10, structure: 15, volume: 10, priceAction: 10 } as const;
const GROUP_LABEL: Record<keyof typeof GROUP_CAPS, string> = {
  trend: '趨勢', momentum: '動能', structure: '結構', volume: '量能', priceAction: 'K線',
};

interface ScoreCompositionProps {
  score: number;
  breakdown: ScoreBreakdown;
}

export function ScoreComposition({ score, breakdown }: ScoreCompositionProps) {
  const rows = (Object.keys(GROUP_CAPS) as (keyof typeof GROUP_CAPS)[])
    .map(key => ({
      key,
      label: GROUP_LABEL[key],
      value: breakdown[key] ?? 0,
      cap: GROUP_CAPS[key],
    }))
    .sort((a, b) => b.value / b.cap - a.value / a.cap);

  const earned = rows.reduce((s, r) => s + r.value, 0);
  const penalties = breakdown.penalties ?? 0;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2.5">
        <span className="text-text-s text-[11px]">評分組成</span>
        <span className="text-text-p text-[13px] num">
          {score}
          <span className="text-text-s text-[11px] ml-1">
            = 基礎40 +{earned}{penalties < 0 ? ` ${penalties}` : ''}
          </span>
        </span>
      </div>

      <div className="grid grid-cols-[34px_1fr_36px] gap-x-2 gap-y-1.5 items-center text-[10px] num">
        {rows.map(r => {
          // 掛零的組標紅：那是這張單最明顯的弱點，值得一眼看到。
          const zero = r.value === 0;
          return (
            <div key={r.key} className="contents">
              <span className={zero ? 'text-down' : 'text-text-m'}>{r.label}</span>
              <div className="h-[5px] rounded-full bg-[#161C24] relative">
                {r.value > 0 && (
                  <div
                    className="absolute left-0 top-0 h-full rounded-full bg-accent"
                    style={{ width: `${(r.value / r.cap) * 100}%` }}
                  />
                )}
              </div>
              <span className={`text-right ${zero ? 'text-down' : 'text-text-p'}`}>{r.value}/{r.cap}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
