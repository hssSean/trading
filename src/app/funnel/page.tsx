'use client';
// 拒絕漏斗 + 影子模擬淨R 數據可視化——之前只能工程師手動用瀏覽器 console
// 帶 Supabase JWT 查 /api/reject-funnel，這頁讓使用者自己在 App 裡就能看
// （2026-08-10，reject-funnel API 那次順手加的 checkUserSession 驗證路徑）。
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';

interface ShadowStat {
  win: number;
  loss: number;
  other: number;
  pending: number;
  netR: number;
}

interface TimeStopStat {
  win: number;
  loss: number;
  stillOpen: number;
  live: number;
  netR: number;
  realNetR: number;
}

interface CancelStat {
  win: number;
  loss: number;
  stillOpen: number;
  live: number;
  netR: number;
}

interface FunnelReason {
  key: string;
  count: number;
  pctOfRejected: number;
  pctOfTotal: number;
  shadow?: ShadowStat;
}

interface FunnelResponse {
  ok: boolean;
  reason?: string;
  days?: number;
  total?: number;
  sent?: number;
  rejected?: number;
  reasons?: FunnelReason[];
  topSymbols?: { symbol: string; count: number }[];
  shadowStats?: Record<string, ShadowStat>;
  timeStopStats?: Record<string, TimeStopStat>;
  cancelStats?: Record<string, CancelStat>;
}

// 拒絕漏斗的關卡 key 沒有中文對照表（route.ts 只有機器可讀的 key），這裡
// 補一份，找不到就直接顯示原始 key 不要讓畫面空白。
const REASON_LABEL: Record<string, string> = {
  event_filter: '事件過濾中',
  circuit_breaker: '熔斷保護',
  drawdown_halt: '回撤停機',
  total_risk_cap: '持倉風險上限',
  locked: '持倉中（同symbol鎖定）',
  same_candle: '同根K線重複',
  cooldown: '冷卻中',
  confluence: '多框架未確認',
  no_entry_tf: '進場時區無合格訊號',
  same_dir_cap: '同方向數量上限',
  loss_cooldown: '虧損冷卻',
  btc_pause: 'BTC大盤暫停',
  btc_direction: 'BTC方向衝突',
  btc_chaos: 'BTC盤整混亂',
  no_entry_tf_score: '進場時區分數不足',
};

const TIME_STOP_LABEL: Record<string, string> = {
  stall: '8根K線盤整停滯',
  expiry: '到期自動平倉',
};

const CANCEL_LABEL: Record<string, string> = {
  cancel_expired: '掛單過期取消',
  cancel_tp1_direct: '過期但若市價進場直達TP1',
  cancel_ran_away: '過期後行情直接噴出',
};

function netRColor(netR: number): string {
  if (netR > 0.5) return 'text-[#F6465D]'; // 正值代表擋太嚴（擋到贏家）——用警示色
  if (netR < -0.5) return 'text-[#0ECB81]'; // 負值代表擋得對——用安全色
  return 'text-[#8A94A2]';
}

function netRLabel(netR: number): string {
  if (netR > 0.5) return '擋太嚴，可考慮放寬';
  if (netR < -0.5) return '擋得對，別動';
  return '接近中性';
}

export default function FunnelPage() {
  const router = useRouter();
  const [data, setData] = useState<FunnelResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [days, setDays] = useState(14);

  const load = useCallback(async (d: number) => {
    setLoading(true);
    setError('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const jwt = session?.access_token ?? '';
      if (!jwt) { setError('尚未登入，無法查詢'); setLoading(false); return; }
      const res = await fetch(`/api/reject-funnel?days=${d}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const json = await res.json() as FunnelResponse;
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `查詢失敗（${res.status}）`);
        setData(null);
      } else {
        setData(json);
      }
    } catch (e) {
      setError(String(e).slice(0, 150));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(days); }, [load, days]);

  return (
    <div className="min-h-screen bg-[#0A0D11] text-[#E8ECF1]">
      <div className="px-3 pt-14 pb-2.5 safe-top border-b border-[#1B222B]">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[15px] font-medium tracking-[0.05em]">拒絕漏斗診斷</h1>
            <p className="text-[#565E6B] text-[10px] mt-0.5 num">
              各關卡擋單統計 + 影子模擬淨R——正值代表擋太嚴，負值代表擋得對
            </p>
          </div>
          <button
            onClick={() => router.push('/settings')}
            className="text-[#8A94A2] text-[11px] px-2.5 py-1 border border-[#232B35] rounded active:bg-[#141A21]"
          >
            返回設定
          </button>
        </div>
        <div className="flex gap-1.5 mt-2.5">
          {[3, 7, 14].map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`text-[11px] px-2.5 py-1 border rounded ${
                days === d ? 'text-[#2DD4BF] border-[#2DD4BF]/40' : 'text-[#565E6B] border-[#1B222B]'
              }`}
            >
              近{d}天
            </button>
          ))}
        </div>
      </div>

      <div className="px-3 py-3 space-y-4 pb-20">
        {loading && <p className="text-[#565E6B] text-xs text-center py-8">載入中…</p>}
        {error && (
          <div className="bg-[#0D0D16] border border-[#F6465D]/30 rounded-xl p-3">
            <p className="text-[#F6465D] text-xs">{error}</p>
          </div>
        )}

        {!loading && !error && data && (
          <>
            <div className="bg-[#0D0D16] border border-[#1B222B] rounded-xl p-3">
              <p className="text-[#3A424E] text-[9px] uppercase font-bold tracking-widest mb-1.5">總覽</p>
              <div className="grid grid-cols-3 gap-2 num">
                <div>
                  <p className="text-[#565E6B] text-[10px]">候選總數</p>
                  <p className="text-[#E8ECF1] text-sm">{data.total}</p>
                </div>
                <div>
                  <p className="text-[#565E6B] text-[10px]">放行</p>
                  <p className="text-[#0ECB81] text-sm">{data.sent}</p>
                </div>
                <div>
                  <p className="text-[#565E6B] text-[10px]">擋下</p>
                  <p className="text-[#F6465D] text-sm">{data.rejected}</p>
                </div>
              </div>
            </div>

            <div>
              <p className="text-[#3A424E] text-[9px] uppercase font-bold tracking-widest mb-1.5 px-0.5">
                各關卡擋單數 + 影子模擬淨R
              </p>
              <div className="space-y-1.5">
                {(data.reasons ?? []).map(r => (
                  <div key={r.key} className="bg-[#0D0D16] border border-[#1B222B] rounded-xl p-3">
                    <div className="flex items-center justify-between">
                      <p className="text-[#E8ECF1] text-xs">{REASON_LABEL[r.key] ?? r.key}</p>
                      <p className="text-[#565E6B] text-[10px] num">
                        {r.count}筆 · {r.pctOfRejected}%
                      </p>
                    </div>
                    {r.shadow && (
                      <div className="mt-1.5 flex items-center justify-between">
                        <p className="text-[#5A7A8A] text-[10px] num">
                          {r.shadow.win}勝{r.shadow.loss}負{r.shadow.other}待定/到期{r.shadow.pending}追蹤中
                        </p>
                        <p className={`text-[11px] font-medium num ${netRColor(r.shadow.netR)}`}>
                          淨R {r.shadow.netR >= 0 ? '+' : ''}{r.shadow.netR}（{netRLabel(r.shadow.netR)}）
                        </p>
                      </div>
                    )}
                  </div>
                ))}
                {(data.reasons ?? []).length === 0 && (
                  <p className="text-[#565E6B] text-xs text-center py-4">這段期間沒有擋單紀錄</p>
                )}
              </div>
            </div>

            <div>
              <p className="text-[#3A424E] text-[9px] uppercase font-bold tracking-widest mb-1.5 px-0.5">
                時間止損影子模擬
              </p>
              <div className="space-y-1.5">
                {Object.entries(data.timeStopStats ?? {}).map(([key, s]) => (
                  <div key={key} className="bg-[#0D0D16] border border-[#1B222B] rounded-xl p-3">
                    <div className="flex items-center justify-between">
                      <p className="text-[#E8ECF1] text-xs">{TIME_STOP_LABEL[key] ?? key}</p>
                      <p className="text-[#565E6B] text-[10px] num">{s.win}勝{s.loss}負{s.stillOpen}未平{s.live}持倉中</p>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between text-[11px] num">
                      <p className="text-[#5A7A8A]">若不介入淨R {s.netR >= 0 ? '+' : ''}{s.netR}</p>
                      <p className={s.realNetR >= s.netR ? 'text-[#0ECB81]' : 'text-[#F6465D]'}>
                        實際介入淨R {s.realNetR >= 0 ? '+' : ''}{s.realNetR}
                      </p>
                    </div>
                  </div>
                ))}
                {Object.keys(data.timeStopStats ?? {}).length === 0 && (
                  <p className="text-[#565E6B] text-xs text-center py-4">這段期間沒有時間止損紀錄</p>
                )}
              </div>
            </div>

            <div>
              <p className="text-[#3A424E] text-[9px] uppercase font-bold tracking-widest mb-1.5 px-0.5">
                取消訂單影子模擬
              </p>
              <div className="space-y-1.5">
                {Object.entries(data.cancelStats ?? {}).map(([key, s]) => (
                  <div key={key} className="bg-[#0D0D16] border border-[#1B222B] rounded-xl p-3">
                    <div className="flex items-center justify-between">
                      <p className="text-[#E8ECF1] text-xs">{CANCEL_LABEL[key] ?? key}</p>
                      <p className="text-[#565E6B] text-[10px] num">{s.win}勝{s.loss}負{s.stillOpen}未平{s.live}持倉中</p>
                    </div>
                    <p className={`mt-1.5 text-[11px] num ${netRColor(s.netR)}`}>
                      淨R {s.netR >= 0 ? '+' : ''}{s.netR}
                    </p>
                  </div>
                ))}
                {Object.keys(data.cancelStats ?? {}).length === 0 && (
                  <p className="text-[#565E6B] text-xs text-center py-4">這段期間沒有取消訂單紀錄</p>
                )}
              </div>
            </div>

            {(data.topSymbols ?? []).length > 0 && (
              <div>
                <p className="text-[#3A424E] text-[9px] uppercase font-bold tracking-widest mb-1.5 px-0.5">
                  最常被擋幣種
                </p>
                <div className="bg-[#0D0D16] border border-[#1B222B] rounded-xl p-3 flex flex-wrap gap-1.5">
                  {(data.topSymbols ?? []).map(s => (
                    <span key={s.symbol} className="text-[#8A94A2] text-[10px] px-2 py-1 border border-[#232B35] rounded num">
                      {s.symbol} × {s.count}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
