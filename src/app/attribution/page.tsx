'use client';
// 策略歸因分析——score_breakdown（五組因子：趨勢/動能/結構/量能/K線）
// 跟真實結果交叉，回答「評分公式給的高分是不是真的對應更好的結果」。
// 見 /funnel 頁「拒絕漏斗」是看被擋掉的候選；這頁看的是已經進場、已經
// 有結果的 trade，維度不同、目的互補。
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';

interface BucketStat {
  bucket: '低' | '中' | '高';
  count: number;
  winRate: number;
  avgR: number;
  netR: number;
  // avgR 的標準誤。舊資料（這個欄位加上去之前的快取回應）沒有，所以可選；
  // 缺值時 factorVerdict 會退回「分不出來」而不是假裝算得出顯著性。
  seR?: number;
}

interface FactorCorrelation {
  group: string;
  rho: number;
  n: number;
  t: number;
}

interface FactorGroupDirectionAvg {
  group: string;
  longAvg: number;
  shortAvg: number;
  overallAvg: number;
}

interface TagStat {
  count: number;
  winRate: number;
  avgR: number;
}

interface AttributionResponse {
  ok: boolean;
  reason?: string;
  byFactorBucket?: Record<string, BucketStat[]>;
  factorCorrelations?: FactorCorrelation[];
  factorGroupByDirection?: FactorGroupDirectionAvg[];
  extensionAtrBuckets?: BucketStat[];
  tagStats?: Record<string, TagStat>;
  byRegime?: Record<string, TagStat>;
  confidenceBuckets?: BucketStat[];
  scoreBucketsByStrategy?: Record<string, BucketStat[]>;
  sampleSize?: { total: number; withBreakdown: number };
}

const REGIME_LABEL: Record<string, string> = {
  trending: '趨勢盤(策略A)',
  ranging: '盤整盤(策略B)',
  transitional: '過渡區(不進場)',
};

const STRATEGY_LABEL: Record<string, string> = {
  A: '策略A(趨勢)',
  B: '策略B(均值回歸)',
  unknown: '未知(8/4前舊資料無strategy欄位)',
};

const FACTOR_LABEL: Record<string, string> = {
  trend: '趨勢',
  momentum: '動能',
  structure: '結構',
  volume: '量能',
  priceAction: 'K線',
};

// 2026-08-11：momentum/priceAction 組總分「分數越高、結果越差」查到這裡——
// 拆到子條件層級才看得出具體是哪一個。
const TAG_LABEL: Record<string, string> = {
  rsi_extreme: 'RSI極端值(超賣/超買)',
  rsi_recovering: 'RSI回升/回落區間',
  rsi_healthy_pullback: 'RSI健康區回調',
  rsi_divergence: 'RSI背離',
  macd_cross: 'MACD黃金/死亡交叉',
  macd_momentum_shift: 'MACD動能改善/轉弱',
  engulfing: '吞噬K線',
  reversal_candle: '錘子/流星線',
};

// 2026-08-23 重寫。原本的判語只比較 `high.avgR < low.avgR`，沒有任何顯著性
// 檢定就直接印出「這組是有效訊號」或「這組權重虛高」。每桶約 34 筆、單筆 R
// 標準差 >1R，兩桶差距的標準誤大概 0.25R——這種樣本下純靠平均值大小下判語，
// 等於擲硬幣然後把結果印成結論，而且資料每多幾筆就可能翻面。
//
// 這正是這個專案一再踩的坑（同一天稍早：選幣圈比較差距 +0.130R 看起來像
// 結論，標準誤 ±0.129R、t=1.00，兩組根本分不出來）。而這個畫面正是要用來
// 決定「哪一組該砍」的地方，判錯的代價是砍掉有用的因子或留著沒用的。
//
// 現在需要兩個獨立證據同時成立才給方向性判語：
//   ① 高低桶差距 > 2 倍合併標準誤
//   ② 該組因子與 R 的等級相關 |t| >= 2
// 只有一個成立就是「訊號微弱」，兩個都不成立就誠實說「分不出來」。
// 預期多數組在目前樣本下都會落在「分不出來」——那是正確答案，不是缺陷。
function factorVerdict(
  buckets: BucketStat[],
  corr?: { rho: number; t: number; n: number },
): { text: string; color: string } | null {
  if (buckets.length < 3) return null;
  const [low, , high] = buckets;
  if (low.count === 0 || high.count === 0) return null;

  const diff = high.avgR - low.avgR;
  // 合併標準誤。任一桶算不出標準誤（n<2）時退回無限大，讓判定必然落到
  // 「分不出來」——不確定的時候不要給方向性結論。
  const lowSe = low.seR ?? 0;
  const highSe = high.seR ?? 0;
  const se = (lowSe > 0 && highSe > 0)
    ? Math.sqrt(lowSe ** 2 + highSe ** 2)
    : Infinity;
  const bucketSignificant = Math.abs(diff) > 2 * se;
  const corrSignificant = !!corr && Math.abs(corr.t) >= 2;

  const detail = se === Infinity
    ? `高低桶差 ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}R`
    : `高低桶差 ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}R ±${se.toFixed(2)}`
      + (corr ? `　rho=${corr.rho} t=${corr.t}` : '');

  if (bucketSignificant && corrSignificant) {
    return diff > 0
      ? { text: `高分確實較好 — 這組是有效訊號（${detail}）`, color: '#0ECB81' }
      : { text: `高分反而較差 — 這組權重虛高，該砍或重做（${detail}）`, color: '#F6465D' };
  }
  if (bucketSignificant || corrSignificant) {
    return { text: `訊號微弱，只有一項證據成立 — 再等資料（${detail}）`, color: '#C99A2E' };
  }
  return { text: `分不出來 — 差距在雜訊範圍內，不可據此調權重（${detail}）`, color: '#5A7A8A' };
}

export default function AttributionPage() {
  const router = useRouter();
  const [data, setData] = useState<AttributionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const jwt = session?.access_token ?? '';
      if (!jwt) { setError('尚未登入，無法查詢'); setLoading(false); return; }
      const res = await fetch('/api/score-attribution', {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const json = await res.json() as AttributionResponse;
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

  useEffect(() => { load(); }, [load]);

  return (
    <div className="min-h-screen bg-[#0A0D11] text-[#E8ECF1]">
      <div className="px-3 pt-14 pb-2.5 safe-top border-b border-[#1B222B]">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[15px] font-medium tracking-[0.05em]">策略歸因分析</h1>
            <p className="text-[#565E6B] text-[10px] mt-0.5 num">
              評分公式的哪一組因子跟結果真的相關——不是看總分，是拆到五組分數各自檢驗
            </p>
          </div>
          <button
            onClick={() => router.push('/settings')}
            className="text-[#8A94A2] text-[11px] px-2.5 py-1 border border-[#232B35] rounded active:bg-[#141A21]"
          >
            返回設定
          </button>
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
              <p className="text-[#3A424E] text-[9px] uppercase font-bold tracking-widest mb-1.5">樣本</p>
              <p className="text-[#E8ECF1] text-sm num">
                {data.sampleSize?.total ?? 0} 筆已結束 · {data.sampleSize?.withBreakdown ?? 0} 筆有評分明細
              </p>
              {(data.sampleSize?.withBreakdown ?? 0) < 20 && (
                <p className="text-[#C99A2E] text-[10px] mt-1">
                  樣本偏少（score_breakdown 是 8/4 才開始記錄的，舊資料沒有），結論先當方向參考，別急著下定論
                </p>
              )}
            </div>

            {Object.keys(data.byRegime ?? {}).length > 0 && (
              <div>
                <p className="text-[#3A424E] text-[9px] uppercase font-bold tracking-widest mb-1.5 px-0.5">
                  Regime(4H ADX判定) vs 結果
                </p>
                <div className="bg-[#0D0D16] border border-[#1B222B] rounded-xl p-3 grid grid-cols-3 gap-2 num">
                  {Object.entries(data.byRegime ?? {}).map(([regime, s]) => (
                    <div key={regime} className="bg-[#141A21] rounded-lg px-2 py-1.5">
                      <p className="text-[#5A7A8A] text-[9px] mb-0.5">{REGIME_LABEL[regime] ?? regime} · {s.count}筆</p>
                      <p className="text-[#E8ECF1] text-[11px]">{s.winRate}% 勝率</p>
                      <p className={`text-[11px] ${s.avgR >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'}`}>
                        {s.avgR >= 0 ? '+' : ''}{s.avgR}R/筆
                      </p>
                    </div>
                  ))}
                </div>
                <p className="text-[#565E6B] text-[10px] mt-1.5 px-0.5">
                  趨勢盤表現變差 = regime判斷本身可能失準；只是整體筆數變少 = 判斷正常，是別的原因(比如市場波動性下降)
                </p>
              </div>
            )}

            <div>
              <p className="text-[#3A424E] text-[9px] uppercase font-bold tracking-widest mb-1.5 px-0.5">
                五組因子：分數高低 vs 實際結果
              </p>
              <div className="space-y-2">
                {Object.entries(data.byFactorBucket ?? {}).map(([group, buckets]) => {
                  const corr = data.factorCorrelations?.find(c => c.group === group);
                  const verdict = factorVerdict(buckets, corr);
                  return (
                    <div key={group} className="bg-[#0D0D16] border border-[#1B222B] rounded-xl p-3">
                      <div className="flex items-center justify-between mb-1.5">
                        <p className="text-[#E8ECF1] text-xs">{FACTOR_LABEL[group] ?? group}</p>
                        {verdict && <p className="text-[10px]" style={{ color: verdict.color }}>{verdict.text}</p>}
                      </div>
                      {buckets.length === 0 ? (
                        <p className="text-[#565E6B] text-[10px]">樣本不足,無法分桶</p>
                      ) : (
                        <div className="grid grid-cols-3 gap-2 num">
                          {buckets.map(b => (
                            <div key={b.bucket} className="bg-[#141A21] rounded-lg px-2 py-1.5">
                              <p className="text-[#5A7A8A] text-[9px] mb-0.5">{b.bucket}分區 · {b.count}筆</p>
                              <p className="text-[#E8ECF1] text-[11px]">{b.winRate}% 勝率</p>
                              <p className={`text-[11px] ${b.avgR >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'}`}>
                                {b.avgR >= 0 ? '+' : ''}{b.avgR}R/筆
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <p className="text-[#3A424E] text-[9px] uppercase font-bold tracking-widest mb-1.5 px-0.5">
                做多 vs 做空：每組因子平均分數
              </p>
              <div className="bg-[#0D0D16] border border-[#1B222B] rounded-xl p-3 space-y-2">
                {(data.factorGroupByDirection ?? []).map(row => {
                  const gap = row.longAvg - row.shortAvg;
                  return (
                    <div key={row.group} className="flex items-center justify-between num">
                      <p className="text-[#8A94A2] text-[11px] w-12">{FACTOR_LABEL[row.group] ?? row.group}</p>
                      <p className="text-[#0ECB81] text-[11px]">多 {row.longAvg}</p>
                      <p className="text-[#F6465D] text-[11px]">空 {row.shortAvg}</p>
                      <p className={`text-[10px] ${Math.abs(gap) > row.overallAvg * 0.3 ? 'text-[#C99A2E]' : 'text-[#565E6B]'}`}>
                        差{gap >= 0 ? '+' : ''}{gap.toFixed(1)}
                      </p>
                    </div>
                  );
                })}
              </div>
              <p className="text-[#565E6B] text-[10px] mt-1.5 px-0.5">
                差距明顯的那組(橘字)，值得懷疑是不是做多/做空評分不對稱的來源
              </p>
            </div>

            <div>
              <p className="text-[#3A424E] text-[9px] uppercase font-bold tracking-widest mb-1.5 px-0.5">
                進場位置延伸度(離EMA20幾個ATR) vs 結果
              </p>
              <div className="bg-[#0D0D16] border border-[#1B222B] rounded-xl p-3">
                {(data.extensionAtrBuckets ?? []).length === 0 ? (
                  <p className="text-[#565E6B] text-[10px]">樣本不足,無法分桶</p>
                ) : (
                  <>
                    <div className="grid grid-cols-3 gap-2 num mb-1.5">
                      {(data.extensionAtrBuckets ?? []).map(b => (
                        <div key={b.bucket} className="bg-[#141A21] rounded-lg px-2 py-1.5">
                          <p className="text-[#5A7A8A] text-[9px] mb-0.5">{b.bucket}延伸 · {b.count}筆</p>
                          <p className="text-[#E8ECF1] text-[11px]">{b.winRate}% 勝率</p>
                          <p className={`text-[11px] ${b.avgR >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'}`}>
                            {b.avgR >= 0 ? '+' : ''}{b.avgR}R/筆
                          </p>
                        </div>
                      ))}
                    </div>
                    <p className="text-[#565E6B] text-[10px]">
                      「高延伸」桶R值明顯較差 = 訊號常常在行情已經走過頭時才觸發，追高/追低進場
                    </p>
                  </>
                )}
              </div>
            </div>

            <div>
              <p className="text-[#3A424E] text-[9px] uppercase font-bold tracking-widest mb-1.5 px-0.5">
                Confidence分數(0-100,目前純顯示不擋單) vs 結果
              </p>
              <div className="bg-[#0D0D16] border border-[#1B222B] rounded-xl p-3">
                {(data.confidenceBuckets ?? []).length === 0 ? (
                  <p className="text-[#565E6B] text-[10px]">樣本不足,無法分桶</p>
                ) : (
                  <>
                    <div className="grid grid-cols-3 gap-2 num mb-1.5">
                      {(data.confidenceBuckets ?? []).map(b => (
                        <div key={b.bucket} className="bg-[#141A21] rounded-lg px-2 py-1.5">
                          <p className="text-[#5A7A8A] text-[9px] mb-0.5">{b.bucket}confidence · {b.count}筆</p>
                          <p className="text-[#E8ECF1] text-[11px]">{b.winRate}% 勝率</p>
                          <p className={`text-[11px] ${b.avgR >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'}`}>
                            {b.avgR >= 0 ? '+' : ''}{b.avgR}R/筆
                          </p>
                        </div>
                      ))}
                    </div>
                    <p className="text-[#565E6B] text-[10px]">
                      「低」桶明顯較差 = confidence 有資格當第二層濾網；沒差 = 目前不擋單是對的，別急著加門檻
                    </p>
                  </>
                )}
              </div>
            </div>

            {Object.keys(data.scoreBucketsByStrategy ?? {}).length > 0 && (
              <div>
                <p className="text-[#3A424E] text-[9px] uppercase font-bold tracking-widest mb-1.5 px-0.5">
                  總分 vs 結果（依策略分開算，A/B 分數不同尺度不能混）
                </p>
                <div className="space-y-2">
                  {Object.entries(data.scoreBucketsByStrategy ?? {}).map(([strategy, buckets]) => (
                    <div key={strategy} className="bg-[#0D0D16] border border-[#1B222B] rounded-xl p-3">
                      <p className="text-[#E8ECF1] text-xs mb-1.5">
                        {STRATEGY_LABEL[strategy] ?? strategy}
                      </p>
                      <div className="grid grid-cols-3 gap-2 num">
                        {buckets.map(b => (
                          <div key={b.bucket} className="bg-[#141A21] rounded-lg px-2 py-1.5">
                            <p className="text-[#5A7A8A] text-[9px] mb-0.5">{b.bucket}分區 · {b.count}筆</p>
                            <p className="text-[#E8ECF1] text-[11px]">{b.winRate}% 勝率</p>
                            <p className={`text-[11px] ${b.avgR >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'}`}>
                              {b.avgR >= 0 ? '+' : ''}{b.avgR}R/筆
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-[#565E6B] text-[10px] mt-1.5 px-0.5">
                  2026-08-12：策略A/B 的總分是兩套不相容尺度（A 60-77、B 10-19），
                  混在一起分桶會把 B 的極端值錯誤丟進「低分桶」，做出「分數越高越差」
                  的假結論——這裡每個策略各自獨立分桶，unknown 是 8/4 前沒記 strategy
                  欄位的舊資料，不會被亂猜成 A 或 B。
                </p>
              </div>
            )}

            {Object.keys(data.tagStats ?? {}).length > 0 && (
              <div>
                <p className="text-[#3A424E] text-[9px] uppercase font-bold tracking-widest mb-1.5 px-0.5">
                  動能/K線子條件拆解 — 哪個具體規則在拖累結果
                </p>
                <div className="space-y-1.5">
                  {Object.entries(data.tagStats ?? {})
                    .sort((a, b) => a[1].avgR - b[1].avgR)
                    .map(([tag, s]) => (
                      <div key={tag} className="bg-[#0D0D16] border border-[#1B222B] rounded-xl p-3 flex items-center justify-between num">
                        <p className="text-[#E8ECF1] text-xs">{TAG_LABEL[tag] ?? tag}</p>
                        <p className="text-[#565E6B] text-[10px]">{s.count}筆</p>
                        <p className="text-[#8A94A2] text-[11px]">{s.winRate}%勝率</p>
                        <p className={`text-[11px] font-medium ${s.avgR >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'}`}>
                          {s.avgR >= 0 ? '+' : ''}{s.avgR}R/筆
                        </p>
                      </div>
                    ))}
                </div>
                <p className="text-[#565E6B] text-[10px] mt-1.5 px-0.5">
                  按平均R由差到好排序,最上面的是最可疑的子規則。這是 8/11 才開始記錄的資料,樣本會隨時間累積
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
