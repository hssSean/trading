'use client';
// 設定頁最上方的「策略」區：S3-A 真倉的模式與停用狀態、規則摘要、月報指令。
import { useS3Api } from '@/lib/s3s1/useS3Api';
import type { OverviewResp } from '@/lib/s3s1/apiTypes';
import { HEARTBEAT_STALE_MS } from '@/lib/s3s1/view';
import { fmtT } from './ui';

export function StrategySection() {
  const { data, error } = useS3Api<OverviewResp>('/api/s3/overview');
  const meta = data?.meta ?? {};
  const alive = data?.heartbeatAt != null && data.now - data.heartbeatAt < HEARTBEAT_STALE_MS;
  const rows: [string, string, string?][] = [
    ['live-runner', data ? (alive ? '運作中' : `沒在跑${data.heartbeatAt ? `（最後 ${fmtT(data.heartbeatAt)}）` : ''}`) : '—', data ? (alive ? 'text-up' : 'text-down') : undefined],
    ['模式', meta.mode === 'dry' ? 'DRY RUN（只印不下單）' : meta.mode === 'live' ? 'testnet 真下單' : '—', meta.mode === 'dry' ? 'text-[#F0B90B]' : undefined],
    ['狀態', meta.halted ? `⛔ 已停用：${String(meta.halted)}` : '正常', meta.halted ? 'text-down' : undefined],
  ];
  return (
    <div className="bg-card-2 border border-accent/20 rounded-xl p-3.5">
      <h2 className="tlabel mb-3">策略（S3-A 真倉）</h2>
      {error && <p className="text-down text-xs mb-2">{error}</p>}
      <div className="space-y-1.5 text-xs num">
        {rows.map(([k, v, cls]) => (
          <div key={k} className="flex justify-between gap-3"><span className="text-text-m">{k}</span><span className={cls ?? 'text-text-p'}>{v}</span></div>
        ))}
      </div>
      <ul className="text-text-m text-xs leading-5 mt-3 space-y-0.5 list-disc pl-4">
        <li>日線唐奇安 20 日突破＋分數 = 2 才做；只做多</li>
        <li>每天台灣 08:00–10:00 進場；持倉每 15 秒檢查</li>
        <li>每筆風險 4%、風險加總 ≤ 20%、最多 10 筆</li>
        <li>+1R 平 1/3 後止損移到保本；之後用 10 日低點移動止損</li>
        <li>停用：回撤 &gt; 35% 或連虧 7 筆（自動停止開新倉）</li>
      </ul>
      <p className="text-text-m text-[11px] leading-5 mt-3">
        真下單／試跑切換在雲端機器的 live-runner：設 <span className="text-accent num">S3A_DRY_RUN=1</span> 只印不下單，拿掉後重啟恢復。
        月報：<span className="text-accent num">npm run s3s1-report</span>。
      </p>
    </div>
  );
}
