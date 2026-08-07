'use client';
import { useState, useCallback, useMemo, memo } from 'react';
import { useStore } from '@/store/useStore';
import { usePriceStore } from '@/store/usePriceStore';
import { deleteTradePermanently, loadFromSupabase, saveToSupabase, fullSyncFromSupabase } from '@/components/StoreHydration';
import { calcPositionPlan, tierRiskMultiplier } from '@/lib/position';
import { isFinallyClosed, isUnconfirmedSync } from '@/lib/tradeSync';
import { TP1_PARTIAL_FRACTION } from '@/lib/monitorMath';
import { StatsHero } from '@/components/StatsHero';
import { TradeResult, TradeRecord } from '@/types';
import { TradeCard } from '@/components/ui/TradeCard';
import { PillBadge } from '@/components/ui/PillBadge';
import { StatChip } from '@/components/ui/StatChip';
import { PriceProgressBar } from '@/components/ui/PriceProgressBar';
import { Wallet, ShieldAlert, LineChart, FileText, Layers, Percent, Check } from 'lucide-react';

const RESULT_LABEL: Record<string, string> = {
  WIN_TP1:      'TP1 達標',
  WIN_TP2:      'TP2 達標',
  LOSS:         '止損出場',
  MANUAL_CLOSE: '手動平倉',
  CANCELLED:    '推薦單失效',
};

const RESULT_COLOR: Record<string, string> = {
  WIN_TP1:      '#0ECB81',
  WIN_TP2:      '#00A040',
  LOSS:         '#F6465D',
  MANUAL_CLOSE: '#2DD4BF',
  CANCELLED:    '#565E6B',
};

// CSV 匯出用：route.ts 寫入的 close_reason 值 → 中文標籤。
const CLOSE_REASON_LABEL: Record<string, string> = {
  tp2:                       'TP2 全部達標',
  trailing_stop:             '移動止損（TP1後）',
  stop_loss:                 '原始止損（未達TP1）',
  time_stop_stall:           '時間止損（盤面停滯）',
  time_stop_expiry:          '到期平倉（未達TP1）',
  time_stop_expiry_post_tp1: '到期平倉（TP1已達標）',
  cancel_expired:            '掛單逾期未成交',
  cancel_ran_away:           '行情走遠未成交',
  cancel_tp1_direct:         '直達TP1未成交',
  cancel_thesis_invalidated: '結構失效未成交',
  manual:                    '手動平倉',
};
const REGIME_LABEL: Record<string, string> = {
  trending: '趨勢', ranging: '盤整', transitional: '過渡',
};

function fmtPrice(p: number) {
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1)    return p.toFixed(4);
  return p.toFixed(6);
}

function fmtDate(ts: number) {
  return new Date(ts).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(ms: number) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}分鐘`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小時${m % 60 ? ` ${m % 60}分` : ''}`;
  const d = Math.floor(h / 24);
  return `${d}天${h % 24}時`;
}

function unlockCoin(symbol: string) {
  const secret = useStore.getState().webhookSecret;
  fetch(`/api/analyze?symbol=${symbol}`, { method: 'DELETE', headers: { 'x-webhook-secret': secret } }).catch(() => {});
}

// R multiple: PnL measured in units of initial risk (entry→SL distance).
// A -12% loss with a 12% stop is -1R — identical damage to a -1% loss with
// a 1% stop when position-sized correctly. Raw % comparisons are misleading.
function calcRMultiple(t: { entry: number; stopLoss: number; pnlPercent?: number }): number | null {
  const riskPct = Math.abs(t.entry - t.stopLoss) / t.entry * 100;
  if (riskPct <= 0 || t.pnlPercent === undefined) return null;
  return t.pnlPercent / riskPct;
}

// Account-level impact assuming the suggested risk sizing (A tier 1%, B tier 0.5%)
function accountPnlPct(t: { entry: number; stopLoss: number; pnlPercent?: number; tier?: 'A' | 'B' }): number | null {
  const r = calcRMultiple(t);
  if (r === null) return null;
  return r * (t.tier === 'B' ? 0.5 : 1.0);
}

// Win/loss is judged by realized PnL, not just the result label: a profitable
// 時間止損/到期平倉 (MANUAL_CLOSE) counts as a win, a losing one as a loss.
// WIN_TP*/LOSS keep their explicit meaning; a breakeven MANUAL_CLOSE (pnl 0) is neither.
// CANCELLED (a limit order that never filled) falls through to false in both —
// it was never a position, so it can't be a win or a loss.
type ClosedLike = { result?: TradeResult; pnlPercent?: number };
function isWinTrade(t: ClosedLike): boolean {
  if (t.result === 'WIN_TP1' || t.result === 'WIN_TP2') return true;
  if (t.result === 'MANUAL_CLOSE') return (t.pnlPercent ?? 0) > 0;
  return false;
}
function isLossTrade(t: ClosedLike): boolean {
  if (t.result === 'LOSS') return true;
  if (t.result === 'MANUAL_CLOSE') return (t.pnlPercent ?? 0) < 0;
  return false;
}

type CloseModalState = {
  id: string; symbol: string; direction: 'LONG' | 'SHORT';
  entry: number; tp1: number; tp2: number; sl: number;
} | null;

// 2026-08-07：浮盈/浮虧 chip 的即時計數自己訂閱 usePriceStore，不讓價格
// tick 逼整個交易紀錄頁（含分類按鈕列）每 3 秒重新 render 一次——同一個
// 問題、同一個修法，7/29 對 TradeRow 做過一次，但那次沒處理到按鈕列本身
// （它不在 TradeRow 裡）。實測連續快速點分類按鈕會漏掉部分點擊，console
// 無錯誤，判斷是高頻率重繪造成的，不是例外中斷。
const LiveCountLabel = memo(function LiveCountLabel({
  trades, dir, fallback,
}: { trades: TradeRecord[]; dir: 'up' | 'down'; fallback: string }) {
  const prices = usePriceStore(s => s.prices);
  let count = 0;
  for (const t of trades) {
    const px = prices[t.symbol]?.price;
    if (!px) continue;
    const pnl = t.direction === 'LONG' ? (px - t.entry) / t.entry : (t.entry - px) / t.entry;
    if (dir === 'up' ? pnl > 0 : pnl < 0) count++;
  }
  return <>{count > 0 ? `${fallback} (${count})` : fallback}</>;
});

interface TradeRowProps {
  trade: TradeRecord;
  now: number;
  accountSize: number;
  riskPct: number;
  selectMode: boolean;
  selected: boolean;
  unlocked: boolean;
  editing: boolean;
  noteText: string;
  toggleSelect: (id: string) => void;
  handleManualUnlock: (symbol: string) => void;
  setCloseModal: (m: CloseModalState) => void;
  setEditingNote: (id: string | null) => void;
  setNoteText: (v: string) => void;
  updateTrade: (id: string, patch: Partial<TradeRecord>) => void;
}

// Extracted so each row can subscribe to its OWN symbol's live price instead of
// the whole trades page re-rendering all ~40 cards every 3s tick (PriceFeed).
// React.memo + stable callback props (all useCallback/useState-setter/zustand-
// action references from the parent) means a price tick for symbol X only
// re-renders rows whose `trade.symbol === X` — everything else is skipped by
// the shallow prop comparison, since `trade` itself doesn't change on a price
// tick (see 待修改事項/session notes: 交易紀錄頁篩選按鈕偶爾要重整才有反應,
// root cause candidate — every row's heavy JSX re-executing every 3s).
const TradeRow = memo(function TradeRow({
  trade, now, accountSize, riskPct, selectMode, selected, unlocked, editing, noteText,
  toggleSelect, handleManualUnlock, setCloseModal, setEditingNote, setNoteText, updateTrade,
}: TradeRowProps) {
  const isWaiting     = trade.status === 'waiting';
  const isTp1Hit      = trade.status === 'tp1_hit';
  const isWatchingTp2 = isTp1Hit && trade.result === 'WIN_TP1' && !trade.closedAt;
  // 尚未拿到伺服器權威 status——不可當「持倉中」顯示（會捏造曝險/PnL）。
  const isUnconfirmed = isUnconfirmedSync(trade);
  const isPending     = !trade.result && !isWaiting && !isUnconfirmed;
  const isWin         = isWinTrade(trade);

  // Closed/cancelled rows never need a live price — the selector returns a
  // constant 0 for them, so this subscription never triggers a re-render for
  // history rows even while their symbol's price keeps ticking elsewhere.
  const needsLivePrice = isWaiting || isPending || isWatchingTp2;
  const livePx = usePriceStore(s => (needsLivePrice ? (s.prices[trade.symbol]?.price ?? 0) : 0));

  // 等待進場中的掛單：顯示距進場位的差距
  let distToEntry = 0;
  if (isWaiting && livePx > 0) {
    distToEntry = trade.direction === 'LONG'
      ? (livePx - trade.entry) / trade.entry * 100  // 正值 = 還差多少才到進場
      : (trade.entry - livePx) / trade.entry * 100;
  }

  // Live PnL and distances (only for active pending trades)
  let livePnl = 0, distTP1 = 0, distSL = 0, nearSL = false;
  if (isPending && livePx > 0) {
    livePnl = trade.direction === 'LONG'
      ? (livePx - trade.entry) / trade.entry * 100
      : (trade.entry - livePx) / trade.entry * 100;
    distTP1 = trade.direction === 'LONG'
      ? (trade.tp1 - livePx) / livePx * 100
      : (livePx - trade.tp1) / livePx * 100;
    distSL = trade.direction === 'LONG'
      ? (livePx - trade.stopLoss) / livePx * 100
      : (trade.stopLoss - livePx) / livePx * 100;
    nearSL = distSL < 1.5;
  }
  // Distance to TP2 for trades watching for TP2 upgrade
  let distTP2 = 0;
  if (isWatchingTp2 && livePx > 0) {
    distTP2 = trade.direction === 'LONG'
      ? (trade.tp2 - livePx) / livePx * 100
      : (livePx - trade.tp2) / livePx * 100;
  }

  const cardVariant = isWaiting ? 'waiting' : (isPending || isWatchingTp2 || isUnconfirmed) ? 'active' : 'closed';
  // Marker basis: live price when we have one, else the trade's exit price for
  // closed trades (shows where it actually landed in the SL→TP2 range), else entry.
  const displayPrice = livePx > 0 ? livePx : (trade.exitPrice ?? trade.entry);

  return (
    <TradeCard
      variant={cardVariant}
      onClick={selectMode ? () => toggleSelect(trade.id) : undefined}
      className={
        (selectMode ? 'cursor-pointer select-none ' : '') +
        (selectMode && selected ? '!border-accent/50 !bg-accent/5 ' : '') +
        (isPending && nearSL ? '!border-down/40' : '')
      }
    >
      {selectMode && (
        <div
          className="absolute top-3.5 right-3.5 w-4 h-4 rounded-full border flex items-center justify-center"
          style={{ borderColor: selected ? '#2DD4BF' : '#3A424E', background: selected ? '#2DD4BF' : 'transparent' }}
        >
          {selected && <Check className="w-2.5 h-2.5 text-[#0A0D11]" strokeWidth={3} />}
        </div>
      )}

      {/* Header: coin avatar + name + status badge */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-[12px] font-medium"
            style={{
              background: `${trade.direction === 'LONG' ? '#1D9E75' : '#E24B4A'}24`,
              color: trade.direction === 'LONG' ? '#5DCAA5' : '#F09595',
            }}
          >
            {trade.symbol.replace('USDT', '').slice(0, 1)}
          </div>
          <div className="min-w-0">
            <div className="text-[14px] font-medium text-text-p flex items-center gap-1.5 flex-wrap">
              {trade.symbol.replace('USDT', '')}/USDT
              {trade.tier === 'B' && <Tag text="B 輕倉 0.5%" />}
            </div>
            <div className="text-[11px] text-text-s truncate">
              {trade.timeframe} · {trade.direction === 'LONG' ? '做多' : '做空'}
              {(isPending || isWaiting || isUnconfirmed) && ` · ${fmtDuration(now - trade.openedAt)}`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isWaiting ? (
            <PillBadge label="等待進場" color="#E6AF5A" />
          ) : isUnconfirmed ? (
            <PillBadge label="同步中" color="#565E6B" />
          ) : isPending ? (
            <PillBadge label={isTp1Hit ? 'TP1·等TP2' : '持倉中'} color="#5DCAA5" pulse={!isTp1Hit} />
          ) : isWatchingTp2 ? (
            <PillBadge label="TP1·等TP2" color="#5DCAA5" />
          ) : (() => {
            const isManual = trade.result === 'MANUAL_CLOSE';
            const color = isManual
              ? (isWin ? '#5DCAA5' : isLossTrade(trade) ? '#F09595' : '#2DD4BF')
              : RESULT_COLOR[trade.result!];
            // 2026-08-05：伺服器端的時間止損／到期平倉也是寫 result='MANUAL_CLOSE'，
            // 只看 result 會一律標成「手動平倉」，使用者因此以為是自己或某個 bug
            // 把單平掉的（實際是系統依規則關的）。有 close_reason 時優先用它，
            // 只有真的是使用者按平倉（close_reason='manual'）或舊資料沒有這個
            // 欄位時，才退回 RESULT_LABEL。
            const label = isManual && trade.closeReason
              ? (CLOSE_REASON_LABEL[trade.closeReason] ?? RESULT_LABEL[trade.result!])
              : RESULT_LABEL[trade.result!];
            return <PillBadge label={label} color={color} />;
          })()}
          <span className="text-accent text-[12px] num">{trade.score}</span>
        </div>
      </div>

      {/* Waiting: distance to entry */}
      {isWaiting && (
        <div className="text-[12px] mb-3">
          {livePx > 0 ? (
            <>
              <span className={distToEntry > 0 ? 'text-[#E6AF5A]' : 'text-accent'}>
                {distToEntry > 0
                  ? `距進場位 還差 ${distToEntry.toFixed(2)}%`
                  // 2026-08-03：伺服器用 1h K 線 + 時間錨判定成交（route.ts），觸價
                  // 到伺服器真正確認之間最長可能有近 1 根 K 線的正常延遲（刻意設計，
                  // 不是卡住）——顯示已等多久，讓使用者分得出「正常等待中」vs「同步
                  // 真的壞了」，不用再靠猜的（docs/BUG-2026-08-03 §3.2-A）。
                  : `已觸價 · 等待伺服器確認成交 · 已等 ${fmtDuration(now - trade.openedAt)}`}
              </span>
              <span className="text-text-s ml-2 num">現價 {fmtPrice(livePx)}</span>
            </>
          ) : (
            <span className="text-text-s">等待即時價格…</span>
          )}
        </div>
      )}

      {/* Pending: PnL + live price */}
      {isPending && livePx > 0 && (
        <div className="flex items-baseline justify-between mb-3">
          <div className="flex items-baseline gap-1.5">
            <span className={`text-[22px] font-medium num ${livePnl >= 0 ? 'text-accent' : 'text-down'}`}>
              {livePnl >= 0 ? '+' : ''}{livePnl.toFixed(2)}%
            </span>
          </div>
          <div className="text-right">
            <div className="text-[11px] text-text-s">現價</div>
            <div className="text-[13px] text-text-p num">{fmtPrice(livePx)}</div>
          </div>
        </div>
      )}

      {/* Distance-to-TP1 / distance-to-SL, shown for active pending trades */}
      {isPending && livePx > 0 && (
        <div className="grid grid-cols-2 gap-1.5 mb-3">
          {isTp1Hit ? (
            <div className="border border-up/25 rounded-[10px] p-2 text-center">
              <div className="text-up text-[10px]">TP1 已達標</div>
              <div className="text-up text-[12px] num mt-0.5">
                {distTP1 > 0 ? `距TP2 還差 ${distTP1.toFixed(2)}%` : `已超過 TP2 ${Math.abs(distTP1).toFixed(2)}%`}
              </div>
            </div>
          ) : (
            <div className="border border-white/[0.06] rounded-[10px] p-2 text-center">
              <div className="tlabel">距 TP1</div>
              <div className={`text-[12px] num mt-0.5 ${distTP1 > 0 ? 'text-up/80' : 'text-up'}`}>
                {distTP1 > 0 ? `還差 ${distTP1.toFixed(2)}%` : `超過 ${Math.abs(distTP1).toFixed(2)}%`}
              </div>
            </div>
          )}
          <div className={`rounded-[10px] p-2 text-center border ${nearSL ? 'border-down/40' : 'border-white/[0.06]'}`}>
            <div className={`text-[10px] ${nearSL ? 'text-down' : 'tlabel'}`}>{nearSL ? '接近止損' : '距 SL'}</div>
            <div className={`text-[12px] num mt-0.5 ${nearSL ? 'text-down' : 'text-text-s'}`}>
              {distSL >= 0 ? `緩衝 ${distSL.toFixed(2)}%` : `穿越 ${Math.abs(distSL).toFixed(2)}%`}
            </div>
          </div>
        </div>
      )}

      {/* Progress bar: shown for every trade so entry/TP1/TP2/SL are always visible */}
      <div className="mb-3">
        <PriceProgressBar
          direction={trade.direction}
          stopLoss={trade.stopLoss}
          entry={trade.entry}
          tp1={trade.tp1}
          tp2={trade.tp2}
          current={displayPrice}
          formatPrice={fmtPrice}
        />
      </div>

      {isWatchingTp2 && livePx > 0 && (
        <div className="grid grid-cols-2 gap-1.5 mb-2">
          <div className="border border-up/25 rounded-[10px] p-2 text-center">
            <div className="text-up text-[10px]">
              TP1 已鎖定 · 請手動平掉 {Math.round(TP1_PARTIAL_FRACTION * 100)}% · 追蹤TP2
            </div>
            <div className="text-up text-[12px] num mt-0.5">
              {distTP2 > 0 ? `距TP2 還差 ${distTP2.toFixed(2)}%` : `已超過TP2 ${Math.abs(distTP2).toFixed(2)}%`}
            </div>
          </div>
          <div className="border border-white/[0.06] rounded-[10px] p-2 text-center">
            <div className="tlabel">現價</div>
            <div className="text-text-s text-[12px] num mt-0.5">{fmtPrice(livePx)}</div>
          </div>
        </div>
      )}

      {/* Live trailing stop for TP1-watching trades */}
      {isWatchingTp2 && (() => {
        const stopLvl = trade.currentStop && trade.currentStop > 0 ? trade.currentStop : trade.entry;
        const lockedR = Math.abs(trade.entry - trade.stopLoss) > 0
          ? (trade.direction === 'LONG' ? stopLvl - trade.entry : trade.entry - stopLvl) / Math.abs(trade.entry - trade.stopLoss)
          : 0;
        return (
          <div className="flex items-center justify-between bg-accent/[0.08] rounded-[10px] px-3 py-2 mb-3">
            <div>
              <div className="text-[11px] text-text-s">移動止損（請移到這）</div>
              <div className="text-[15px] text-accent num mt-0.5">{fmtPrice(stopLvl)}</div>
            </div>
            <p className="text-[10px] text-right leading-4 text-text-m">
              {lockedR >= 0.05 ? `已鎖 +${lockedR.toFixed(1)}R` : '保本（無虧損風險）'}<br/>
              碰到即以此價出場
            </p>
          </div>
        );
      })()}

      {/* Position sizing */}
      {isPending && (() => {
        const effRisk = riskPct * tierRiskMultiplier(trade.symbol, trade.tier);
        const plan = calcPositionPlan(accountSize, effRisk, trade.entry, trade.stopLoss, trade.tier === 'B' ? 5 : 10);
        if (!plan) return null;
        const slPct = Math.abs(trade.entry - trade.stopLoss) / trade.entry * 100;
        return (
          <div className="mb-3">
            <p className="tlabel mb-1.5">倉位計算（{effRisk}% 風險）</p>
            <div className="grid grid-cols-2 gap-2">
              <StatChip icon={<Wallet className="w-4 h-4" />} label="建議倉位" value={`${plan.positionUSDT}U`} />
              <StatChip icon={<Layers className="w-4 h-4" />} label="本金×槓桿" value={`${plan.marginUSDT}U×${plan.leverage}`} />
              <StatChip icon={<ShieldAlert className="w-4 h-4" />} label="止損虧損" value={`${plan.riskUSDT}U`} />
              <StatChip
                icon={<Percent className="w-4 h-4" />}
                label="止損幅度"
                value={`${slPct.toFixed(2)}%`}
                valueClassName={slPct > 5 ? 'text-down' : 'text-text-p'}
              />
            </div>
            {plan.belowMinNotional && (
              <p className="text-[#E6AF5A] text-[10px] mt-1.5">低於交易所最低下單額 5U</p>
            )}
          </div>
        );
      })()}

      {/* TP1 hit: breakeven reminder */}
      {isTp1Hit && (
        <div className="mb-3 bg-accent/[0.06] rounded-[10px] px-3 py-2">
          <p className="text-accent/85 text-[11px]">TP1 已達標，建議將止損移至成本 <span className="num text-accent">{fmtPrice(trade.entry)}</span>，繼續持有等待 TP2</p>
        </div>
      )}

      {/* Auto-generated entry reasons */}
      {trade.reasons && trade.reasons.length > 0 && (
        <div className="mb-2 border-t border-white/[0.06] pt-2">
          <p className="tlabel mb-1">分析依據</p>
          {trade.scoreBreakdown && (
            <p className="text-[#5A7A8A] text-[10px] leading-[1.5] mb-1 num">
              評分：趨勢{trade.scoreBreakdown.trend} · 動能{trade.scoreBreakdown.momentum} · 結構{trade.scoreBreakdown.structure} · 量能{trade.scoreBreakdown.volume} · K線{trade.scoreBreakdown.priceAction}
              {trade.scoreBreakdown.penalties < 0 ? ` · 扣分${trade.scoreBreakdown.penalties}` : ''}
            </p>
          )}
          {trade.reasons.map((r, i) => (
            <p key={i} className="text-[#5A7A8A] text-[10px] leading-[1.5]">› {r}</p>
          ))}
        </div>
      )}

      {/* Personal notes (editable) */}
      {editing ? (
        <div className="mt-2">
          <textarea
            value={noteText}
            onChange={e => setNoteText(e.target.value)}
            placeholder="個人備註、市場觀察…"
            rows={2}
            className="w-full bg-card-2 border border-white/[0.06] rounded-[10px] px-3 py-2 text-xs text-text-p resize-none outline-none mb-2"
          />
          <div className="flex gap-2">
            <button onClick={() => { updateTrade(trade.id, { entryNotes: noteText }); setEditingNote(null); }}
              className="flex-1 py-1.5 rounded-full bg-accent text-[#0A0D11] text-xs font-medium">儲存</button>
            <button onClick={() => setEditingNote(null)}
              className="px-3 py-1.5 rounded-full border border-white/[0.08] text-text-s text-xs">取消</button>
          </div>
        </div>
      ) : (
        <div className="mt-1.5 flex items-start gap-2">
          <div className="flex-1 min-w-0">
            {trade.entryNotes
              ? <p className="text-text-s text-xs leading-5 border-l border-white/[0.08] pl-2">{trade.entryNotes}</p>
              : !selectMode && <button onClick={() => { setEditingNote(trade.id); setNoteText(''); }}
                  className="text-text-m text-xs">＋ 個人備註</button>
            }
          </div>
          {trade.entryNotes && !selectMode && (
            <button onClick={() => { setEditingNote(trade.id); setNoteText(trade.entryNotes ?? ''); }}
              className="text-text-m text-[11px] shrink-0">編輯</button>
          )}
        </div>
      )}

      {/* Result row for closed trades */}
      {!isPending && !isWaiting && trade.exitPrice !== undefined && (() => {
        const r    = calcRMultiple(trade);
        const acct = accountPnlPct(trade);
        return (
          <div className="flex items-center justify-between mt-1 pt-2 border-t border-white/[0.05]">
            <span className="text-text-m text-[11px] num">出場 {fmtPrice(trade.exitPrice)}</span>
            <span className="text-right">
              <span className={`text-[13px] num ${isWin ? 'text-accent' : 'text-down'}`}>
                {trade.pnlPercent !== undefined ? `${trade.pnlPercent >= 0 ? '+' : ''}${trade.pnlPercent}%` : '—'}
              </span>
              {r !== null && (
                <span className="block text-[10px] text-text-m num">
                  {r >= 0 ? '+' : ''}{r.toFixed(1)}R{acct !== null ? ` · 帳戶 ${acct >= 0 ? '+' : ''}${acct.toFixed(2)}%` : ''}
                </span>
              )}
            </span>
          </div>
        );
      })()}

      {/* Timestamp + actions */}
      <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/[0.06]">
        <span className="text-text-m text-[11px] num">{fmtDate(trade.openedAt)}</span>
        {!selectMode && <div className="flex gap-2 flex-wrap justify-end">
          <a
            href={`https://www.tradingview.com/chart/?symbol=BINANCE:${trade.symbol}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full text-accent border border-accent/25 active:opacity-70"
          >
            <LineChart className="w-3.5 h-3.5" />圖表
          </a>
          {isWaiting && (
            <button
              onClick={() => handleManualUnlock(trade.symbol)}
              title="手動取消掛單並解鎖推播"
              className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                unlocked
                  ? 'text-accent border-accent/30'
                  : 'text-[#E6AF5A] border-[#E6AF5A]/30 active:opacity-70'
              }`}
            >
              {unlocked ? '已取消' : '取消掛單'}
            </button>
          )}
          {(isPending || isWatchingTp2) && (
            <>
              <button
                onClick={() => handleManualUnlock(trade.symbol)}
                title="解除 LINE 推播鎖定"
                className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                  unlocked
                    ? 'text-accent border-accent/30'
                    : 'text-text-m border-white/[0.08] active:opacity-70'
                }`}
              >
                {unlocked ? '已解鎖' : '解鎖推播'}
              </button>
              <button
                onClick={() => setCloseModal({
                  id: trade.id, symbol: trade.symbol, direction: trade.direction,
                  entry: trade.entry, tp1: trade.tp1, tp2: trade.tp2, sl: trade.stopLoss,
                })}
                className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border border-white/[0.08] text-text-s active:opacity-70"
              >
                <FileText className="w-3.5 h-3.5" />手動記錄
              </button>
            </>
          )}
          <button
            onClick={() => {
              const label = trade.result ? `已結束的 ${trade.symbol.replace('USDT', '')} 紀錄` : `${trade.symbol.replace('USDT', '')} 持倉紀錄`;
              if (window.confirm(`確定永久刪除${label}？\n此操作無法復原，雲端同步後也會移除。`)) {
                deleteTradePermanently(trade.id);
              }
            }}
            className="text-[11px] px-2 py-1 rounded-full text-text-m active:opacity-70"
          >
            刪除
          </button>
        </div>}
      </div>
    </TradeCard>
  );
});

export default function TradesPage() {
  const trades          = useStore(s => s.trades);
  const accountSize     = useStore(s => s.settings.accountSize);
  const riskPct         = useStore(s => s.settings.riskPctPerTrade ?? 1);
  const closeTrade      = useStore(s => s.closeTrade);
  const updateTrade     = useStore(s => s.updateTrade);

  // Live prices come from <PriceFeed> (root layout, 3s). This page used to run
  // its own 30s poller, and that poller filtered out `status === 'waiting'` —
  // which is exactly why a fresh limit order's 現價/距進場 sat frozen at
  // whatever value happened to be in localStorage.
  //
  // 2026-08-07：這裡原本用 `usePriceStore(s => s.prices)` 訂閱整包價格物件——
  // 每次 PriceFeed 的 3 秒 tick，這個 selector 回傳一個新物件參考，讓「整個
  // 交易紀錄頁」（不只卡片，連分類按鈕列都在同一個 function component 裡）
  // 每 3 秒重新執行一次 render。TradeRow 在 7/29 已經改成各卡自己訂閱自己
  // 那個幣種的價格（見上面 needsLivePrice），但那次的修法沒有處理到頁面
  // 最外層——分類按鈕列不在 TradeRow 裡，完全沒被那次修法保護到。
  //
  // 實測重現：連續快速點擊分類按鈕時，部分點擊會被吃掉（畫面沒切換），且
  // console 沒有任何錯誤——不是例外中斷，是這種高頻率重繪造成的。改成
  // `getState()` 非響應式讀取，priceOf 呼叫當下永遠拿到最新價格，但不再
  // 讓價格變動觸發整頁重繪。浮盈/浮虧 chip 需要的即時計數改用下面的
  // LiveCountLabel，自己訂閱、自己重繪，不牽動這個頁面其他部分。
  const priceOf = useCallback((symbol: string) => usePriceStore.getState().prices[symbol]?.price ?? 0, []);

  const [closeModal, setCloseModal] = useState<{
    id: string; symbol: string; direction: 'LONG' | 'SHORT';
    entry: number; tp1: number; tp2: number; sl: number;
  } | null>(null);
  const [exitPrice,  setExitPrice]  = useState('');
  const [exitResult, setExitResult] = useState<TradeResult>('WIN_TP1');
  const [filter,     setFilter]     = useState<'ALL' | 'PENDING' | 'WAITING' | 'CLOSED' | 'PROFIT' | 'LOSS_LIVE'>('ALL');
  const [resultFilter, setResultFilter] = useState<'ALL' | 'WIN' | 'LOSS' | 'CANCELLED'>('ALL');
  const [dirFilter,  setDirFilter]  = useState<'ALL' | 'LONG' | 'SHORT'>('ALL');
  const [dateFilter, setDateFilter] = useState<'all' | 'week' | 'month'>('all');
  const [sortBy,     setSortBy]     = useState<'time' | 'pnl' | 'score'>('time');
  const [sortDir,    setSortDir]    = useState<'desc' | 'asc'>('desc');
  const [unlockMsg,  setUnlockMsg]  = useState<Record<string, boolean>>({});
  const [syncing,    setSyncing]    = useState(false);
  const [syncMsg,    setSyncMsg]    = useState('');
  const [showDetailStats, setShowDetailStats] = useState(false);
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [noteText,    setNoteText]    = useState('');
  const [actualEntry, setActualEntry] = useState('');
  const now = useMemo(() => Date.now(), [dateFilter]);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // 「真正結束」的判準（closedAt 或非 tp1-watching 的 result）抽到 @/lib/tradeSync 共用，
  // 與同步層 finalize 邏輯用同一套規則（見 tests/tradeSync.test.ts）。

  // Memoize derived arrays: prevents filtered from recomputing on every store update.
  const waiting       = useMemo(() => trades.filter(t => t.status === 'waiting'), [trades]);
  // 已結束＝真正終局（含 CANCELLED，讓「這張推薦單沒進場」也留得下紀錄可查）。
  const closed        = useMemo(() => trades.filter(isFinallyClosed), [trades]);
  // 但 CANCELLED 從沒變成過部位，不能算進勝率/損益統計的分母——否則會被稀釋成
  // 假的低勝率。所有數字類戰績統計改吃這桶，只有列表顯示與 CSV 匯出吃 closed。
  const closedResults = useMemo(() => closed.filter(t => t.result !== 'CANCELLED'), [closed]);
  const cancelledTrades = useMemo(() => closed.filter(t => t.result === 'CANCELLED'), [closed]);
  // 同步中 = 剛從訊號建立、尚未拿到伺服器權威 status（見 tradeSync.ts）——
  // 不能算「持倉中」（會捏造出不存在的曝險/PnL），要獨立一桶。
  const unconfirmed   = useMemo(() => trades.filter(isUnconfirmedSync), [trades]);
  // 持倉中 = 未真正結束、非等待進場、且非同步中（含 TP1 已達標、追蹤 TP2 中的單）
  const pending       = useMemo(
    () => trades.filter(t => !isFinallyClosed(t) && t.status !== 'waiting' && !isUnconfirmedSync(t)),
    [trades],
  );
  // 追蹤TP2 = TP1 hit, result locked as WIN_TP1, not yet finally closed
  const watchingTp2   = useMemo(() => trades.filter(t => t.status === 'tp1_hit' && t.result === 'WIN_TP1' && !t.closedAt), [trades]);
  // 浮盈/浮虧 chip 的即時計數改由 LiveCountLabel 元件自己訂閱價格計算
  // （見該元件定義處的說明），這裡不再需要。
  const wins    = closedResults.filter(isWinTrade);
  const losses  = closedResults.filter(isLossTrade);
  const winRate = closedResults.length > 0 ? Math.round((wins.length / closedResults.length) * 100) : null;
  const avgPnl  = closedResults.length > 0
    ? (closedResults.reduce((a, t) => a + (t.pnlPercent ?? 0), 0) / closedResults.length).toFixed(2)
    : null;
  const totalWin  = wins.reduce((a, t) => a + Math.max(t.pnlPercent ?? 0, 0), 0);
  const totalLoss = Math.abs(losses.reduce((a, t) => a + Math.min(t.pnlPercent ?? 0, 0), 0));
  const profitFactor = totalLoss > 0 ? (totalWin / totalLoss).toFixed(2) : null;
  // ── R-multiple stats (risk-normalized; the honest scorecard) ──
  const { totalR, avgR } = useMemo(() => {
    let rSum = 0, acctSum = 0, n = 0;
    closedResults.forEach(t => {
      const r = calcRMultiple(t);
      if (r === null) return;
      rSum += r;
      acctSum += r * (t.tier === 'B' ? 0.5 : 1.0);
      n++;
    });
    return {
      totalR:        n > 0 ? rSum : null,
      accountReturn: n > 0 ? acctSum : null,
      avgR:          n > 0 ? rSum / n : null,
    };
  }, [closedResults]);

  // ── Extended stats ───────────────────────────────────────────
  const avgWin  = wins.length   > 0 ? (wins.reduce((a, t)   => a + (t.pnlPercent ?? 0), 0) / wins.length).toFixed(2)   : null;
  const avgLoss = losses.length > 0 ? (losses.reduce((a, t) => a + (t.pnlPercent ?? 0), 0) / losses.length).toFixed(2) : null;

  // RR analysis
  const calcRR = (t: (typeof trades)[0]) => {
    const risk = Math.abs(t.entry - t.stopLoss);
    return risk > 0 ? Math.abs(t.tp2 - t.entry) / risk : 0;
  };
  const avgPlannedRR = useMemo(() => {
    const all = [...pending, ...closedResults].filter(t => t.status !== 'waiting');
    if (!all.length) return null;
    return (all.reduce((a, t) => a + calcRR(t), 0) / all.length).toFixed(2);
  }, [pending, closedResults]);
  const avgActualRR = useMemo(() => {
    if (!wins.length) return null;
    return (wins.reduce((a, t) => {
      const risk = Math.abs(t.entry - t.stopLoss);
      return a + (risk > 0 ? Math.abs((t.exitPrice ?? t.tp1) - t.entry) / risk : 0);
    }, 0) / wins.length).toFixed(2);
  }, [wins]);
  // Expected value per trade = winRate * avgWin + lossRate * avgLoss − trading cost (0.15% round-trip)
  const expectedValue = useMemo(() => {
    if (!closedResults.length || avgWin === null || avgLoss === null) return null;
    const wr = wins.length / closedResults.length;
    const COST_PCT = 0.15; // 0.15% round-trip (entry + exit taker fee)
    const ev = wr * parseFloat(avgWin) + (1 - wr) * parseFloat(avgLoss) - COST_PCT;
    return ev.toFixed(2);
  }, [closedResults.length, wins.length, avgWin, avgLoss]);

  const longClosed  = closedResults.filter(t => t.direction === 'LONG');
  const shortClosed = closedResults.filter(t => t.direction === 'SHORT');
  const longWins    = longClosed.filter(isWinTrade);
  const shortWins   = shortClosed.filter(isWinTrade);
  const longWinRate  = longClosed.length  > 0 ? Math.round(longWins.length  / longClosed.length  * 100) : null;
  const shortWinRate = shortClosed.length > 0 ? Math.round(shortWins.length / shortClosed.length * 100) : null;

  const maxConsecLoss = useMemo(() => {
    let best = 0; let cur = 0;
    [...trades]
      .filter(t => t.result && t.result !== 'CANCELLED')
      .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))
      .forEach(t => {
        if (isLossTrade(t)) { cur++; best = Math.max(best, cur); } else cur = 0;
      });
    return best;
  }, [trades]);

  const { bestCoin, worstCoin } = useMemo(() => {
    const map = new Map<string, { total: number; count: number }>();
    closedResults.forEach(t => {
      const c = map.get(t.symbol) ?? { total: 0, count: 0 };
      map.set(t.symbol, { total: c.total + (t.pnlPercent ?? 0), count: c.count + 1 });
    });
    const arr = Array.from(map.entries()).map(([s, v]) => ({ symbol: s, avg: +(v.total / v.count).toFixed(2) }));
    if (arr.length === 0) return { bestCoin: null, worstCoin: null };
    const sorted = [...arr].sort((a, b) => b.avg - a.avg);
    return { bestCoin: sorted[0], worstCoin: sorted[sorted.length - 1] };
  }, [closedResults]);

  // ── 策略分析模組 ─────────────────────────────────────────────

  // 累積資產曲線（按平倉時間排序）
  const equityCurve = useMemo(() => {
    let cum = 0;
    return [...closedResults]
      .filter(t => t.closedAt)
      .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))
      .map(t => { cum += t.pnlPercent ?? 0; return parseFloat(cum.toFixed(2)); });
  }, [closedResults]);

  // 近 7 日累積 R（戰績卡用）
  const weekR = useMemo(() => {
    const since = Date.now() - 7 * 86_400_000;
    let r = 0, n = 0;
    closedResults.forEach(t => {
      if ((t.closedAt ?? 0) < since) return;
      const v = calcRMultiple(t);
      if (v !== null) { r += v; n++; }
    });
    return n > 0 ? r : null;
  }, [closedResults]);

  // 資金曲線 R 化（sparkline 用）：以 R 累積，去掉原始 % 的量級誤導
  const equityR = useMemo(() => {
    let cum = 0;
    return [...closedResults]
      .filter(t => t.closedAt)
      .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))
      .map(t => { cum += calcRMultiple(t) ?? 0; return parseFloat(cum.toFixed(2)); });
  }, [closedResults]);

  // 最大回撤（從高峰到谷底的最大下跌）
  const maxDrawdown = useMemo(() => {
    if (equityCurve.length < 2) return null;
    let peak = 0, maxDD = 0;
    equityCurve.forEach(v => {
      if (v > peak) peak = v;
      const dd = peak - v;
      if (dd > maxDD) maxDD = dd;
    });
    return maxDD.toFixed(2);
  }, [equityCurve]);

  // 月度損益（最近 6 個月）
  const monthlyPnl = useMemo(() => {
    const map = new Map<string, { pnl: number; wins: number; total: number }>();
    closedResults.filter(t => t.closedAt).forEach(t => {
      const d = new Date(t.closedAt!);
      const key = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`;
      const e = map.get(key) ?? { pnl: 0, wins: 0, total: 0 };
      map.set(key, {
        pnl:   e.pnl + (t.pnlPercent ?? 0),
        wins:  e.wins + (isWinTrade(t) ? 1 : 0),
        total: e.total + 1,
      });
    });
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-6)
      .map(([key, v]) => ({ key, pnl: parseFloat(v.pnl.toFixed(2)), wins: v.wins, total: v.total }));
  }, [closedResults]);

  // 評分區間效益（哪個分數段勝率最高）— 對應 v2.1 分級（B級60-64 / A級65+）
  // 55–59 獨立成一段而非併入 B 級：2026-07-30 起 B 級底線從 55 升到 60，這段不再
  // 產生新單。留著是為了讓「當初為什麼要升門檻」的歷史證據看得見——併回 B 級會
  // 稀釋掉判斷依據，直接砍掉則會讓舊單從所有區間中消失（落在 min 之外）。
  const scoreRanges = useMemo(() => [
    { label: '55–59 (已停用)', min: 55, max: 59 },
    { label: '60–64 (B級)', min: 60, max: 64 },
    { label: '65–74 (A級)', min: 65, max: 74 },
    { label: '75+ (A級高分)', min: 75, max: 999 },
  ].map(r => {
    const inRange = closedResults.filter(t => (t.score ?? 0) >= r.min && (t.score ?? 0) <= r.max);
    const ws = inRange.filter(isWinTrade);
    return {
      label: r.label,
      total: inRange.length,
      wr: inRange.length ? Math.round(ws.length / inRange.length * 100) : null,
      avgPnl: inRange.length ? parseFloat((inRange.reduce((a, t) => a + (t.pnlPercent ?? 0), 0) / inRange.length).toFixed(2)) : null,
    };
  }).filter(r => r.total > 0), [closedResults]);

  // 信號因子效益（哪些技術條件勝率最高）
  const reasonStats = useMemo(() => {
    const KW = ['看漲 OB', '看跌 OB', 'FVG', 'ChoCH', 'BOS', 'RSI 超賣', 'RSI 超買', 'RSI 看漲背離', 'RSI 看跌背離', 'MACD 黃金交叉', 'MACD 死亡交叉', 'Fib 黃金口袋', 'EQL', 'EQH', '破壞塊'];
    return KW.map(kw => {
      const m = closedResults.filter(t => t.reasons?.some(r => r.includes(kw)));
      if (m.length < 2) return null;
      const ws = m.filter(isWinTrade);
      return { label: kw, total: m.length, wr: Math.round(ws.length / m.length * 100) };
    }).filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.wr - a.wr).slice(0, 8);
  }, [closedResults]);

  // 時框效益（哪個時間週期勝率最高）
  const tfStats = useMemo(() => {
    const map = new Map<string, { wins: number; total: number; pnl: number }>();
    closedResults.forEach(t => {
      const tf = t.timeframe ?? '?';
      const e = map.get(tf) ?? { wins: 0, total: 0, pnl: 0 };
      map.set(tf, {
        wins:  e.wins + (isWinTrade(t) ? 1 : 0),
        total: e.total + 1,
        pnl:   e.pnl + (t.pnlPercent ?? 0),
      });
    });
    return Array.from(map.entries())
      .map(([tf, v]) => ({ tf, wr: Math.round(v.wins / v.total * 100), total: v.total, avgPnl: parseFloat((v.pnl / v.total).toFixed(2)) }))
      .sort((a, b) => b.wr - a.wr);
  }, [closedResults]);

  // 平均持倉時間（CANCELLED 排除——它的 openedAt→closedAt 是「等成交多久後過期」，
  // 不是「部位抱了多久」，混進來會把平均持倉時間往下拉，失真）
  const avgHoldTime = useMemo(() => {
    const with2 = closedResults.filter(t => t.openedAt && t.closedAt);
    if (!with2.length) return null;
    const avgMs = with2.reduce((a, t) => a + ((t.closedAt ?? 0) - t.openedAt), 0) / with2.length;
    const h = Math.floor(avgMs / 3600000);
    return h < 24 ? `${h}小時` : `${Math.floor(h / 24)}天${h % 24}時`;
  }, [closedResults]);

  const filtered = useMemo(() => {
    // Base set
    const calcLivePnl = (t: (typeof trades)[0]) => {
      const livePx = priceOf(t.symbol);
      if (!livePx) return null;
      return t.direction === 'LONG'
        ? (livePx - t.entry) / t.entry * 100
        : (t.entry - livePx) / t.entry * 100;
    };
    // 2026-08-04：這幾支陣列都是 useMemo 快取值——PENDING/WAITING/CLOSED 三個分支
    // 之前直接拿參考（不是複製），下面的 base.sort() 是就地排序，會直接改動
    // pending/waiting/closed 本身。陣列 identity 沒變，依賴它們的其他 useMemo
    // （如 liveCounts）因此不會重算，卻拿到被改過順序的資料——一定要先複製一份。
    let base = filter === 'PENDING'   ? [...pending]
             : filter === 'WAITING'   ? [...waiting]
             : filter === 'CLOSED'    ? [...closed]
             : filter === 'PROFIT'    ? pending.filter(t => (calcLivePnl(t) ?? -1) > 0)
             : filter === 'LOSS_LIVE' ? pending.filter(t => (calcLivePnl(t) ?? 1) < 0)
             : [...waiting, ...pending, ...unconfirmed, ...closed];
    // Closed result sub-filter
    if (filter === 'CLOSED' && resultFilter !== 'ALL') {
      if (resultFilter === 'WIN')       base = base.filter(isWinTrade);
      if (resultFilter === 'LOSS')      base = base.filter(isLossTrade);
      if (resultFilter === 'CANCELLED') base = base.filter(t => t.result === 'CANCELLED');
    }
    // Direction filter
    if (dirFilter !== 'ALL') base = base.filter(t => t.direction === dirFilter);
    // Date filter
    if (dateFilter !== 'all') {
      const cutoff = dateFilter === 'week'
        ? now - 7  * 24 * 3600 * 1000
        : now - 30 * 24 * 3600 * 1000;
      base = base.filter(t => t.openedAt >= cutoff);
    }
    // Sort (waiting always on top, then by sort key)
    base.sort((a, b) => {
      if (a.status === 'waiting' && b.status !== 'waiting') return -1;
      if (b.status === 'waiting' && a.status !== 'waiting') return  1;
      let diff = 0;
      if (sortBy === 'pnl')   diff = (a.pnlPercent ?? 0) - (b.pnlPercent ?? 0);
      if (sortBy === 'score') diff = (a.score ?? 0) - (b.score ?? 0);
      if (sortBy === 'time')  diff = a.openedAt - b.openedAt;
      return sortDir === 'desc' ? -diff : diff;
    });
    return base;
  }, [filter, resultFilter, dirFilter, dateFilter, sortBy, sortDir, pending, closed, waiting, unconfirmed, now, priceOf]);

  const [exporting, setExporting] = useState(false);
  // 樣本外驗證用：只匯出這天之後開倉的交易，排除掉調參當時用來調門檻的舊資料
  // （見 2026-08-08 策略分析討論——門檻是用歷史資料調出來的，拿同一批資料
  // 回頭驗證會高估，要看「這之後」新產生的交易才乾淨）。空字串＝匯出全部，
  // 沿用原本行為。
  const [exportSince, setExportSince] = useState('');

  // 走 /api/trade-export（service role）而不是直接用記憶體裡的 closed 陣列：
  // 1. regime/confidence/funding_rate/suggested_risk_pct/suggested_leverage/
  //    close_reason 這些欄位，authenticated role 能不能讀回來沒有把握
  //    （/api/trade-status 已證實 status/signal_price 有這問題）——直接走
  //    service role 端點，不用逐欄位賭。
  // 2. 本機 Zustand 快取有 500 筆上限，直接查 Supabase 拿完整歷史。
  const exportCsv = async () => {
    setExporting(true);
    try {
      const { webhookSecret, userId } = useStore.getState();
      if (!userId) { setSyncMsg('請先登入'); return; }

      const res = await fetch('/api/trade-export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-webhook-secret': webhookSecret },
        body: JSON.stringify({ userId }),
      });
      const { trades: rawRows } = await res.json() as { trades: Record<string, unknown>[] };

      // 時間輸出 ISO（含年份）：舊格式「7/17 上午08:00」缺年份，
      // 匯回「績效體檢」或 Excel 排序都會出問題
      const isoDate = (ts: number) => {
        const d = new Date(ts);
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      };
      // R倍數＝損益% ÷ 止損距離%（規格慣例：損益一律用 R 衡量，原始價格 % 會因
      // 止損距離不同而失真——見 CLAUDE.md「調參紀律」）。CANCELLED/尚無 pnl 的列給空值。
      const calcR = (entry: number, stopLoss: number, pnlPercent: number | null) => {
        if (pnlPercent === null) return '';
        const riskPct = Math.abs(entry - stopLoss) / entry * 100;
        return riskPct > 0 ? (pnlPercent / riskPct).toFixed(2) : '';
      };
      // MFE/MAE 一律換算成 R（正 = 對我方向有利，負 = 不利），跟主要損益欄同一套
      // 慣例——2026-07-30 策略檢討加的：出場價相同的兩筆單，一筆可能中途衝到
      // +1.8R 才回落到 +0.2R 出場，一筆從沒超過 +0.3R，這是完全不同的兩個問題
      // （TP1 設太遠 vs. 進場論點根本不成立），只看出場價分不出來。
      const calcExcursionR = (entry: number, stopLoss: number, direction: string, price: number | null) => {
        if (price === null) return '';
        const riskDist = Math.abs(entry - stopLoss);
        if (riskDist <= 0) return '';
        const r = direction === 'LONG' ? (price - entry) / riskDist : (entry - price) / riskDist;
        return r.toFixed(2);
      };

      // 只匯出真正終局的列（closed_at 有值）——還開著的部位沒有結果可分析。
      const sinceTs = exportSince ? new Date(exportSince).getTime() : null;
      const rows = (rawRows ?? [])
        .filter(r => r.closed_at != null)
        .filter(r => sinceTs === null || (r.opened_at as number) >= sinceTs)
        .map(r => {
          const entry      = r.entry as number;
          const stopLoss   = r.stop_loss as number;
          const pnlPercent = (r.pnl_percent as number | null) ?? null;
          // 2026-08-06：舊資料列（v2.1 tier 欄位加入前）tier 是 NULL，原本這裡
          // `?? 'A'` 會把它們一律當成 A級匯出——不是「預設安全值」，是捏造一個
          // 不存在的分級標籤。這個匯出檔是策略分析的資料來源，捏造標籤會直接
          // 汙染任何依「級別」分組的統計結論（8/6 分析已查出 27 筆因此誤標，
          // 含兩筆最大贏家，見 docs/ANALYSIS-2026-08-06B）。改成不強制預設，
          // 「級別」欄位如實顯示「未知」，帳戶R 的加權邏輯（下面 acctR）維持
          // 原樣不變——`tier === 'B' ? 0.5 : 1.0` 對 tier=null 算出 1.0，這是
          // tier 系統加入前全站統一風險倍率的正確歷史還原，不是這次要修的問題。
          const tier       = (r.tier as string | null) ?? null;
          const rMultiple  = calcR(entry, stopLoss, pnlPercent);
          const acctR      = rMultiple === '' ? '' : (parseFloat(rMultiple) * (tier === 'B' ? 0.5 : 1.0)).toFixed(2);
          const closeReasonKey = (r.close_reason as string | null) ?? null;
          const resultKey  = (r.result as string | null) ?? 'MANUAL_CLOSE';
          const direction  = r.direction as string;
          const mfeR = calcExcursionR(entry, stopLoss, direction, (r.mfe_price as number | null) ?? null);
          const maeR = calcExcursionR(entry, stopLoss, direction, (r.mae_price as number | null) ?? null);
          // 2026-08-04：進場品質量測，塞在既有的 score_breakdown JSONB 裡
          // （不需要 ALTER TABLE）。舊資料列沒有這兩個 key，匯出成空字串。
          const sb = (r.score_breakdown ?? null) as { extensionAtr?: number; entryDistAtr?: number } | null;
          return [
            r.id, r.symbol, r.direction, r.timeframe, r.strength, r.score,
            entry, stopLoss, r.tp1, r.tp2,
            isoDate(r.opened_at as number),
            isoDate((r.closed_at as number | null) ?? (r.opened_at as number)),
            RESULT_LABEL[resultKey] ?? resultKey,
            closeReasonKey ? (CLOSE_REASON_LABEL[closeReasonKey] ?? closeReasonKey) : '',
            r.exit_price ?? '',
            pnlPercent ?? '',
            rMultiple,
            acctR,
            mfeR,
            maeR,
            sb?.extensionAtr ?? '',
            sb?.entryDistAtr ?? '',
            `${tier ? tier + '級' : '未知'}·${r.timeframe}`,
            r.strategy ?? '',
            r.regime ? (REGIME_LABEL[r.regime as string] ?? r.regime) : '',
            r.confidence ?? '',
            r.funding_rate != null ? ((r.funding_rate as number) * 100).toFixed(4) : '',
            r.suggested_risk_pct ?? '',
            r.suggested_leverage ?? '',
            `"${((r.reasons as string[]) ?? []).join(' | ').replace(/"/g, '""')}"`,
            `"${((r.entry_notes as string) ?? '').replace(/"/g, '""')}"`,
          ].join(',');
        });

      const header = [
        'ID', '幣種', '方向', '週期', '強度', '得分',
        '進場價', '止損', 'TP1', 'TP2', '開倉時間', '平倉時間',
        '結果', '出場原因', '出場價', '損益%', 'R倍數', '帳戶R', 'MFE(R)', 'MAE(R)',
        '延伸度(ATR)', '進場距離(ATR)',
        '級別', '進場策略', '盤勢regime', '信心分數confidence', '資金費率%funding',
        '建議風險%', '建議槓桿',
        '分析依據', '個人備註',
      ].join(',');
      const csv  = [header, ...rows].join('\n');
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `trades-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setSyncMsg('匯出失敗，請重試');
      setTimeout(() => setSyncMsg(''), 4000);
    } finally {
      setExporting(false);
    }
  };

  const handleClearClosed = useCallback(async () => {
    if (!window.confirm(`確定清除所有 ${closed.length} 筆已結束紀錄？\n此操作無法復原，雲端紀錄也會一併刪除。`)) return;
    const ids = closed.map(t => t.id);
    await Promise.all(ids.map(id => deleteTradePermanently(id)));
  }, [closed]);

  const handleClose = () => {
    if (!closeModal) return;
    const price = parseFloat(exitPrice);
    if (isNaN(price) || price <= 0) return;
    // Warn if exit price deviates >50% from entry (likely typo)
    const dev = Math.abs(price - closeModal.entry) / closeModal.entry;
    if (dev > 0.5 && !window.confirm(`出場價 $${price} 距進場 $${fmtPrice(closeModal.entry)} 偏離 ${(dev * 100).toFixed(1)}%，確定嗎？`)) return;
    // Apply corrected actual entry price BEFORE closing so PnL is accurate
    const parsedActualEntry = parseFloat(actualEntry);
    if (!isNaN(parsedActualEntry) && parsedActualEntry > 0 && parsedActualEntry !== closeModal.entry) {
      updateTrade(closeModal.id, { entry: parsedActualEntry });
    }
    closeTrade(closeModal.id, exitResult, price);
    unlockCoin(closeModal.symbol);
    setCloseModal(null);
    setExitPrice('');
    setActualEntry('');
  };

  const handleManualUnlock = useCallback((symbol: string) => {
    unlockCoin(symbol);
    setUnlockMsg(prev => ({ ...prev, [symbol]: true }));
    setTimeout(() => setUnlockMsg(prev => ({ ...prev, [symbol]: false })), 2500);
  }, []);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setSyncMsg('');
    try {
      const uid = useStore.getState().userId;
      if (!uid) { setSyncMsg('請先登入'); return; }
      // 完整雙向同步：先上傳本機 → 再以 Supabase 為主取代本機
      // 解決「手機電腦紀錄不一致」問題
      const changes = await fullSyncFromSupabase(uid);
      setSyncMsg(changes > 0 ? `完整同步完成，${changes > 0 ? `差異 ${changes} 筆` : ''}資料已一致` : '完整同步完成，資料已一致');
    } catch {
      setSyncMsg('同步失敗，請重試');
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(''), 4000);
    }
  }, []);

  const autoFill = (result: TradeResult) => {
    setExitResult(result);
    if (!closeModal) return;
    if (result === 'WIN_TP1')      setExitPrice(String(closeModal.tp1));
    else if (result === 'WIN_TP2') setExitPrice(String(closeModal.tp2));
    else if (result === 'LOSS')    setExitPrice(String(closeModal.sl));
  };

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleBulkDelete = useCallback(async () => {
    if (!selectedIds.size) return;
    const count = selectedIds.size;
    if (!window.confirm(`確定永久刪除選取的 ${count} 筆紀錄？\n此操作無法復原，雲端同步後也會移除。`)) return;
    await Promise.all(Array.from(selectedIds).map(id => deleteTradePermanently(id)));
    setSelectedIds(new Set());
    setSelectMode(false);
  }, [selectedIds]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 pt-14 pb-2.5 safe-top border-b border-[#1B222B] shrink-0">
        <div className="flex items-center mb-2.5">
          <div>
            <h1 className="text-[#E8ECF1] text-[15px] font-medium tracking-[0.05em]">交易紀錄</h1>
            <p className="text-[#565E6B] text-[10px] mt-0.5 num">
              {closed.length} 已結束 · {pending.length} 持倉
              {watchingTp2.length > 0 && <span className="text-[#0ECB81]"> · {watchingTp2.length} 追蹤TP2</span>}
              {waiting.length > 0 && <span className="text-[#C99A2E]"> · {waiting.length} 掛單中</span>}
              {unconfirmed.length > 0 && <span className="text-[#565E6B]"> · {unconfirmed.length} 同步中</span>}
            </p>
          </div>
          <span className="flex-1" />
          <div className="flex gap-1.5 items-center flex-wrap justify-end">
            <button
              onClick={handleSync}
              disabled={syncing}
              className="text-[#2DD4BF] text-[11px] px-2.5 py-1 border border-[#2DD4BF]/40 rounded disabled:opacity-40 active:bg-[#141A21]"
            >
              {syncing ? (
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 border-[1.5px] border-[#2DD4BF] border-t-transparent rounded-full animate-spin inline-block" />
                  同步中
                </span>
              ) : '同步紀錄'}
            </button>
            <input
              type="date"
              value={exportSince}
              onChange={e => setExportSince(e.target.value)}
              title="只匯出這天之後開倉的交易（樣本外驗證用，留空＝匯出全部）"
              className="text-[#8A94A2] text-[11px] px-1.5 py-1 border border-[#232B35] rounded bg-transparent"
            />
            <button
              onClick={exportCsv}
              disabled={exporting}
              className="text-[#8A94A2] text-[11px] px-2.5 py-1 border border-[#232B35] rounded disabled:opacity-40 active:bg-[#141A21]"
            >
              {exporting ? '匯出中…' : '匯出'}
            </button>
            <button
              onClick={() => { setSelectMode(v => !v); setSelectedIds(new Set()); setEditingNote(null); }}
              className={`text-[11px] px-2.5 py-1 border rounded active:bg-[#141A21] ${
                selectMode ? 'text-[#F6465D] border-[#F6465D]/40' : 'text-[#565E6B] border-[#1B222B]'
              }`}
            >
              {selectMode ? '取消' : '選取'}
            </button>
          </div>
        </div>
        {syncMsg && (
          <div className={`mb-2 px-3 py-2 rounded text-xs border ${
            syncMsg.includes('失敗') ? 'border-[#F6465D]/30 text-[#F6465D]' : 'border-[#2DD4BF]/30 text-[#2DD4BF]'
          }`}>
            {syncMsg}
          </div>
        )}

        {/* 戰績卡 — 累積 R / 每筆均 R / 近7日 / 勝率 / 每筆期望 + 資金曲線縮圖 */}
        <StatsHero
          totalR={totalR}
          avgR={avgR}
          weekR={weekR}
          winRate={winRate}
          expectedValue={expectedValue}
          equity={equityR}
          closedCount={closedResults.length}
          pendingCount={pending.length}
        />

        {/* Expandable detail stats */}
        {closed.length > 0 && (
          <div className="mb-2">
            <button
              onClick={() => setShowDetailStats(v => !v)}
              className="w-full flex items-center justify-between px-3 py-2 bg-[#0D0D16] rounded-xl border border-[#1B222B] text-xs text-[#565E6B] active:opacity-70"
            >
              <span className="font-semibold">詳細績效分析</span>
              <span>{showDetailStats ? '▲ 收起' : '▼ 展開'}</span>
            </button>
            {showDetailStats && (
              <div className="mt-1.5 bg-[#0D0D16] border border-[#1B222B] rounded-xl p-3 space-y-3">
                {/* Direction breakdown */}
                <div>
                  <p className="text-[#3A424E] text-[9px] uppercase font-bold tracking-widest mb-1.5">多/空勝率</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-[#0A1A10] rounded-lg px-3 py-2">
                      <p className="text-[#0ECB81] text-[9px] font-bold mb-0.5">▲ 做多 ({longClosed.length}筆)</p>
                      <p className={`text-base font-extrabold ${longWinRate !== null && longWinRate >= 50 ? 'text-[#0ECB81]' : 'text-[#F6465D]'}`}>
                        {longWinRate !== null ? `${longWinRate}%` : '—'}
                      </p>
                      <p className="text-[#3A424E] text-[9px]">{longWins.length}W {longClosed.length - longWins.length}L</p>
                    </div>
                    <div className="bg-[#1A0A0A] rounded-lg px-3 py-2">
                      <p className="text-[#F6465D] text-[9px] font-bold mb-0.5">▼ 做空 ({shortClosed.length}筆)</p>
                      <p className={`text-base font-extrabold ${shortWinRate !== null && shortWinRate >= 50 ? 'text-[#0ECB81]' : 'text-[#F6465D]'}`}>
                        {shortWinRate !== null ? `${shortWinRate}%` : '—'}
                      </p>
                      <p className="text-[#3A424E] text-[9px]">{shortWins.length}W {shortClosed.length - shortWins.length}L</p>
                    </div>
                  </div>
                </div>

                {/* Avg win / loss + consecutive + hold time */}
                <div>
                  <p className="text-[#3A424E] text-[9px] uppercase font-bold tracking-widest mb-1.5">損益分析</p>
                  <div className="grid grid-cols-4 gap-1.5">
                    <div className="bg-[#0F141A] rounded-lg px-2 py-1.5 text-center">
                      <p className="text-[#3A424E] text-[8px]">平均獲利</p>
                      <p className="text-[#0ECB81] text-xs font-bold">{avgWin ? `+${avgWin}%` : '—'}</p>
                    </div>
                    <div className="bg-[#0F141A] rounded-lg px-2 py-1.5 text-center">
                      <p className="text-[#3A424E] text-[8px]">平均虧損</p>
                      <p className="text-[#F6465D] text-xs font-bold">{avgLoss ? `${avgLoss}%` : '—'}</p>
                    </div>
                    <div className="bg-[#0F141A] rounded-lg px-2 py-1.5 text-center">
                      <p className="text-[#3A424E] text-[8px]">最大連虧</p>
                      <p className={`text-xs font-bold ${maxConsecLoss >= 3 ? 'text-red-400' : 'text-[#8A94A2]'}`}>{maxConsecLoss}筆</p>
                    </div>
                    <div className="bg-[#0F141A] rounded-lg px-2 py-1.5 text-center">
                      <p className="text-[#3A424E] text-[8px]">平均持倉</p>
                      <p className="text-[#8A94A2] text-xs font-bold">{avgHoldTime ?? '—'}</p>
                    </div>
                  </div>
                </div>

                {/* RR analysis */}
                <div>
                  <p className="text-[#3A424E] text-[9px] uppercase font-bold tracking-widest mb-1.5">風報比分析</p>
                  <div className="grid grid-cols-3 gap-1.5">
                    <div className="bg-[#0F141A] rounded-lg px-2 py-1.5 text-center">
                      <p className="text-[#3A424E] text-[8px]">計畫 RR（到 TP2）</p>
                      <p className="text-[#8A94A2] text-xs font-bold">{avgPlannedRR ? `1:${avgPlannedRR}` : '—'}</p>
                    </div>
                    <div className="bg-[#0F141A] rounded-lg px-2 py-1.5 text-center">
                      <p className="text-[#3A424E] text-[8px]">實際達成 RR</p>
                      <p className={`text-xs font-bold ${avgActualRR ? 'text-[#0ECB81]' : 'text-[#3A424E]'}`}>{avgActualRR ? `1:${avgActualRR}` : '—'}</p>
                    </div>
                    <div className="bg-[#0F141A] rounded-lg px-2 py-1.5 text-center">
                      <p className="text-[#3A424E] text-[8px]">每筆期望值</p>
                      <p className={`text-xs font-bold ${expectedValue ? (parseFloat(expectedValue) >= 0 ? 'text-[#0ECB81]' : 'text-red-400') : 'text-[#3A424E]'}`}>
                        {expectedValue ? `${parseFloat(expectedValue) >= 0 ? '+' : ''}${expectedValue}%` : '—'}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Equity curve + max drawdown */}
                {equityCurve.length >= 2 && (
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <p className="text-[#3A424E] text-[9px] uppercase font-bold tracking-widest">資產曲線</p>
                      <div className="flex gap-3 text-[9px]">
                        <span className="text-[#565E6B]">
                          累積 <span className={parseFloat((equityCurve[equityCurve.length - 1] ?? 0).toString()) >= 0 ? 'text-[#0ECB81] font-bold' : 'text-red-400 font-bold'}>
                            {(equityCurve[equityCurve.length - 1] ?? 0) >= 0 ? '+' : ''}{equityCurve[equityCurve.length - 1]}%
                          </span>
                        </span>
                        {maxDrawdown && parseFloat(maxDrawdown) > 0 && (
                          <span className="text-[#565E6B]">最大回撤 <span className="text-red-400 font-bold">-{maxDrawdown}%</span></span>
                        )}
                      </div>
                    </div>
                    <div className="bg-[#0A0D11] rounded-xl p-2">
                      <EquityCurve data={equityCurve} />
                    </div>
                  </div>
                )}

                {/* Monthly P&L */}
                {monthlyPnl.length > 0 && (
                  <div>
                    <p className="text-[#3A424E] text-[9px] uppercase font-bold tracking-widest mb-1.5">月度損益</p>
                    <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${monthlyPnl.length}, 1fr)` }}>
                      {monthlyPnl.map(m => (
                        <div key={m.key} className={`rounded-lg px-1.5 py-2 text-center border ${m.pnl >= 0 ? 'bg-green-400/5 border-green-400/20' : 'bg-red-400/5 border-red-400/20'}`}>
                          <p className="text-[#3A424E] text-[8px] mb-0.5">{m.key.slice(5)}</p>
                          <p className={`text-xs font-bold ${m.pnl >= 0 ? 'text-[#0ECB81]' : 'text-red-400'}`}>{m.pnl >= 0 ? '+' : ''}{m.pnl}%</p>
                          <p className="text-[#3A424E] text-[7px] mt-0.5">{m.wins}W/{m.total - m.wins}L</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* TF win rate */}
                {tfStats.length > 0 && (
                  <div>
                    <p className="text-[#3A424E] text-[9px] uppercase font-bold tracking-widest mb-1.5">時框效益</p>
                    <div className="space-y-1">
                      {tfStats.map(r => (
                        <div key={r.tf} className="flex items-center gap-2">
                          <span className="text-[#E8ECF1] text-[10px] font-mono w-8 shrink-0">{r.tf}</span>
                          <div className="flex-1 h-3 bg-[#141A21] rounded-full overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${r.wr}%`, background: r.wr >= 60 ? '#0ECB81' : r.wr >= 45 ? '#2DD4BF' : '#F6465D' }} />
                          </div>
                          <span className="text-[10px] font-bold w-8 text-right shrink-0" style={{ color: r.wr >= 60 ? '#0ECB81' : r.wr >= 45 ? '#2DD4BF' : '#F6465D' }}>{r.wr}%</span>
                          <span className="text-[#3A424E] text-[9px] w-8 text-right shrink-0">{r.total}筆</span>
                          <span className={`text-[9px] w-10 text-right shrink-0 ${r.avgPnl >= 0 ? 'text-[#0ECB81]' : 'text-red-400'}`}>{r.avgPnl >= 0 ? '+' : ''}{r.avgPnl}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Score range analysis */}
                {scoreRanges.length > 0 && (
                  <div>
                    <p className="text-[#3A424E] text-[9px] uppercase font-bold tracking-widest mb-1.5">評分效益（高分 = 高勝率？）</p>
                    <div className="space-y-1">
                      {scoreRanges.map(r => (
                        <div key={r.label} className="flex items-center gap-2">
                          <span className="text-[#2DD4BF] text-[10px] font-mono w-12 shrink-0">{r.label}分</span>
                          <div className="flex-1 h-3 bg-[#141A21] rounded-full overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${r.wr ?? 0}%`, background: (r.wr ?? 0) >= 60 ? '#0ECB81' : (r.wr ?? 0) >= 45 ? '#2DD4BF' : '#F6465D' }} />
                          </div>
                          <span className="text-[10px] font-bold w-8 text-right shrink-0" style={{ color: (r.wr ?? 0) >= 60 ? '#0ECB81' : (r.wr ?? 0) >= 45 ? '#2DD4BF' : '#F6465D' }}>{r.wr ?? '—'}%</span>
                          <span className="text-[#3A424E] text-[9px] w-8 text-right shrink-0">{r.total}筆</span>
                          {r.avgPnl !== null && (
                            <span className={`text-[9px] w-10 text-right shrink-0 ${r.avgPnl >= 0 ? 'text-[#0ECB81]' : 'text-red-400'}`}>{r.avgPnl >= 0 ? '+' : ''}{r.avgPnl}%</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Signal reason win rate */}
                {reasonStats.length > 0 && (
                  <div>
                    <p className="text-[#3A424E] text-[9px] uppercase font-bold tracking-widest mb-1.5">信號因子效益（哪個條件最準）</p>
                    <div className="space-y-1">
                      {reasonStats.map(r => (
                        <div key={r.label} className="flex items-center gap-2">
                          <span className="text-[#8A94A2] text-[9px] flex-1 truncate">{r.label}</span>
                          <div className="w-20 h-2.5 bg-[#141A21] rounded-full overflow-hidden shrink-0">
                            <div className="h-full rounded-full" style={{ width: `${r.wr}%`, background: r.wr >= 65 ? '#0ECB81' : r.wr >= 50 ? '#2DD4BF' : '#F6465D' }} />
                          </div>
                          <span className="text-[10px] font-bold w-7 text-right shrink-0" style={{ color: r.wr >= 65 ? '#0ECB81' : r.wr >= 50 ? '#2DD4BF' : '#F6465D' }}>{r.wr}%</span>
                          <span className="text-[#3A424E] text-[9px] w-6 text-right shrink-0">{r.total}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Best / worst coin */}
                {(bestCoin || worstCoin) && (
                  <div>
                    <p className="text-[#3A424E] text-[9px] uppercase font-bold tracking-widest mb-1.5">幣種表現</p>
                    <div className="grid grid-cols-2 gap-2">
                      {bestCoin && (
                        <div className="bg-[#0A1A10] rounded-lg px-3 py-2">
                          <p className="text-[#3A424E] text-[8px] mb-0.5">最佳幣種</p>
                          <p className="text-[#E8ECF1] text-xs font-bold">{bestCoin.symbol.replace('USDT', '')}</p>
                          <p className="text-[#0ECB81] text-xs">{bestCoin.avg >= 0 ? '+' : ''}{bestCoin.avg}%</p>
                        </div>
                      )}
                      {worstCoin && worstCoin.symbol !== bestCoin?.symbol && (
                        <div className="bg-[#1A0A0A] rounded-lg px-3 py-2">
                          <p className="text-[#3A424E] text-[8px] mb-0.5">最差幣種</p>
                          <p className="text-[#E8ECF1] text-xs font-bold">{worstCoin.symbol.replace('USDT', '')}</p>
                          <p className="text-[#F6465D] text-xs">{worstCoin.avg >= 0 ? '+' : ''}{worstCoin.avg}%</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Portfolio Heat */}
        {pending.length > 0 && (
          <div className={`rounded-md px-3.5 py-2.5 mb-3 border flex items-center justify-between ${
            pending.length >= 5 ? 'border-[#F6465D]/40'
            : pending.length >= 3 ? 'border-[#C99A2E]/40'
            : 'border-[#1B222B]'
          }`}>
            <div>
              <div className="tlabel">帳戶總曝險</div>
              <p className={`text-[15px] num mt-0.5 ${
                pending.length >= 5 ? 'text-[#F6465D]'
                : pending.length >= 3 ? 'text-[#C99A2E]' : 'text-[#E8ECF1]'
              }`}>{pending.length}%</p>
            </div>
            <div className="text-right">
              <p className="text-[#565E6B] text-[10px] num">{pending.length} 筆持倉 × 1% 風險</p>
              {pending.length >= 5
                ? <p className="text-[#F6465D] text-[10px]">高風險，建議暫停開新倉</p>
                : pending.length >= 3
                ? <p className="text-[#C99A2E] text-[10px]">注意：總曝險偏高</p>
                : <p className="text-[#3A424E] text-[9px]">風險在控制範圍內</p>
              }
            </div>
          </div>
        )}

        {/* Row 1: 狀態 filter */}
        <div className="flex gap-1.5 mb-2 flex-wrap">
          {([
            // 2026-08-04：全部 chip 數字要跟 filtered 實際列出的內容一致——
            // filter==='ALL' 的 base 是 [...waiting, ...pending, ...unconfirmed, ...closed]
            // （見上面 filtered 的 useMemo），漏算 unconfirmed 會讓有同步中的單時
            // 這個數字小於實際列出的筆數。
            ['ALL',       `全部 (${waiting.length + pending.length + unconfirmed.length + closed.length})`],
            ['PENDING',   `持倉 (${pending.length})`],
            ['WAITING',   waiting.length > 0 ? `等待進場 (${waiting.length})` : '等待進場'],
            ['CLOSED',    `結束 (${closed.length})`],
            ['PROFIT',    '浮盈'],
            ['LOSS_LIVE', '浮虧'],
          ] as const).map(([f, label]) => (
            <button key={f} onClick={() => { setFilter(f); if (f !== 'CLOSED') setResultFilter('ALL'); }}
              className={`text-[11px] px-2.5 py-1 rounded border transition-colors ${
                filter === f
                  ? f === 'PROFIT'    ? 'border-[#0ECB81] text-[#0ECB81]'
                  : f === 'LOSS_LIVE' ? 'border-[#F6465D] text-[#F6465D]'
                  : f === 'WAITING'   ? 'border-[#C99A2E] text-[#C99A2E]'
                  : 'bg-[#2DD4BF] border-[#2DD4BF] text-[#0A0D11]'
                  : f === 'PROFIT'    ? 'border-[#0ECB81]/25 text-[#0ECB81]/70'
                  : f === 'LOSS_LIVE' ? 'border-[#F6465D]/25 text-[#F6465D]/70'
                  : f === 'WAITING'   ? 'border-[#3A2F14] text-[#C99A2E]/70'
                  : 'border-[#1B222B] text-[#565E6B]'
              }`}>
              {f === 'PROFIT'    ? <LiveCountLabel trades={pending} dir="up"   fallback={label} />
               : f === 'LOSS_LIVE' ? <LiveCountLabel trades={pending} dir="down" fallback={label} />
               : label}
            </button>
          ))}
        </div>

        {/* Row 1b: 已結束 result sub-filter */}
        {filter === 'CLOSED' && (
          <div className="flex gap-1.5 mb-2">
            {([
              ['ALL',       '全部'],
              ['WIN',       `獲利 (${wins.length})`],
              ['LOSS',      `止損 (${losses.length})`],
              ['CANCELLED', `失效 (${cancelledTrades.length})`],
            ] as const).map(([f, label]) => (
              <button key={f} onClick={() => setResultFilter(f)}
                className={`text-[11px] px-2.5 py-1 rounded border transition-colors ${
                  resultFilter === f
                    ? f === 'WIN'       ? 'border-[#0ECB81] text-[#0ECB81]'
                    : f === 'LOSS'      ? 'border-[#F6465D] text-[#F6465D]'
                    : f === 'CANCELLED' ? 'border-[#565E6B] text-[#565E6B]'
                    : 'bg-[#2DD4BF] border-[#2DD4BF] text-[#0A0D11]'
                    : f === 'WIN'       ? 'border-[#0ECB81]/25 text-[#0ECB81]/70'
                    : f === 'LOSS'      ? 'border-[#F6465D]/25 text-[#F6465D]/70'
                    : f === 'CANCELLED' ? 'border-[#565E6B]/25 text-[#565E6B]/70'
                    : 'border-[#1B222B] text-[#565E6B]'
                }`}>
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Row 2: 方向 + 時間 + 排序 */}
        <div className="flex gap-1.5 flex-wrap items-center">
          {/* Direction */}
          {(['ALL', 'LONG', 'SHORT'] as const).map(d => (
            <button key={d} onClick={() => setDirFilter(d)}
              className={`text-[11px] px-2 py-1 rounded border transition-colors ${dirFilter === d
                ? d === 'LONG'  ? 'border-[#0ECB81]/50 text-[#0ECB81]'
                : d === 'SHORT' ? 'border-[#F6465D]/50 text-[#F6465D]'
                :                 'border-[#2DD4BF]/50 text-[#2DD4BF]'
                : 'border-[#1B222B] text-[#3A424E]'}`}>
              {d === 'ALL' ? '多/空' : d === 'LONG' ? 'LONG' : 'SHORT'}
            </button>
          ))}
          <div className="w-px h-4 bg-[#1B222B]" />
          {/* Date range */}
          {([['all', '全部'], ['week', '本週'], ['month', '本月']] as const).map(([d, label]) => (
            <button key={d} onClick={() => setDateFilter(d)}
              className={`text-[11px] px-2 py-1 rounded border transition-colors ${dateFilter === d ? 'border-[#2DD4BF]/50 text-[#2DD4BF]' : 'border-[#1B222B] text-[#3A424E]'}`}>
              {label}
            </button>
          ))}
          <div className="w-px h-4 bg-[#1B222B]" />
          {/* Sort */}
          <button
            onClick={() => {
              if (sortBy === 'time')  { setSortBy('pnl');  setSortDir('desc'); }
              else if (sortBy === 'pnl')   { setSortBy('score'); setSortDir('desc'); }
              else { setSortBy('time'); setSortDir('desc'); }
            }}
            className="text-[11px] px-2 py-1 rounded border border-[#1B222B] text-[#3A424E] num"
          >
            {sortBy === 'time' ? '時間' : sortBy === 'pnl' ? '損益' : '得分'}
            {sortDir === 'desc' ? '↓' : '↑'}
          </button>
          {closed.length > 0 && (
            <button
              onClick={handleClearClosed}
              className="ml-auto text-[11px] px-2 py-1 rounded border border-[#F6465D]/25 text-[#F6465D]/70 active:opacity-70"
            >
              清除已結束
            </button>
          )}
        </div>
      </div>

      {/* Trade list */}
      <div className="flex-1 overflow-y-auto px-3 pt-3 scroll-container">
        {filtered.length === 0 ? (
          trades.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-2 text-center">
              <p className="text-[#2A323D] text-2xl num">[ ]</p>
              <p className="text-[#8A94A2] font-medium">還沒有交易紀錄</p>
              <p className="text-[#565E6B] text-sm">伺服器每 5 分鐘自動分析，達到強訊號時自動建立並即時推播</p>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-48 gap-2 text-center">
              <p className="text-[#2A323D] text-2xl num">?</p>
              <p className="text-[#8A94A2] font-medium">此分類目前沒有紀錄</p>
              <p className="text-[#565E6B] text-sm num">
                目前共 {closed.length} 已結束 · {pending.length} 持倉 · {waiting.length} 掛單
              </p>
              <button
                onClick={() => { setFilter('ALL'); setResultFilter('ALL'); setDirFilter('ALL'); setDateFilter('all'); }}
                className="mt-1 text-xs px-4 py-2 rounded border border-[#2DD4BF]/40 text-[#2DD4BF] active:opacity-70"
              >
                顯示全部紀錄
              </button>
            </div>
          )
        ) : (
          filtered.map(trade => (
            <TradeRow
              key={trade.id}
              trade={trade}
              now={now}
              accountSize={accountSize}
              riskPct={riskPct}
              selectMode={selectMode}
              selected={selectedIds.has(trade.id)}
              unlocked={!!unlockMsg[trade.symbol]}
              editing={editingNote === trade.id}
              noteText={noteText}
              toggleSelect={toggleSelect}
              handleManualUnlock={handleManualUnlock}
              setCloseModal={setCloseModal}
              setEditingNote={setEditingNote}
              setNoteText={setNoteText}
              updateTrade={updateTrade}
            />
          ))
        )}
        <div className="h-4" />
      </div>

      {/* Multi-select delete bar */}
      {selectMode && (
        <div className="bg-[#0C1116] border-t border-[#1B222B] px-3 py-2.5 flex items-center gap-3 shrink-0">
          <span className="text-[#565E6B] text-sm">
            已選 <span className="text-[#E8ECF1] num">{selectedIds.size}</span> 筆
          </span>
          <div className="flex-1" />
          <button
            onClick={() => {
              const allIds = new Set(filtered.map(t => t.id));
              setSelectedIds(prev => prev.size === filtered.length ? new Set() : allIds);
            }}
            className="text-[11px] px-2.5 py-1 rounded border border-[#1B222B] text-[#8A94A2] active:opacity-70"
          >
            {selectedIds.size === filtered.length ? '取消全選' : '全選'}
          </button>
          <button
            onClick={handleBulkDelete}
            disabled={selectedIds.size === 0}
            className="text-[11px] px-3 py-1 rounded border border-[#F6465D]/40 text-[#F6465D] disabled:opacity-40 active:opacity-70"
          >
            刪除{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
          </button>
        </div>
      )}

      {/* Manual close modal */}
      {closeModal && (() => {
        const livePxClose = priceOf(closeModal.symbol);
        return (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-end" onClick={e => { if (e.target === e.currentTarget) { setCloseModal(null); setActualEntry(''); } }}>
          <div className="w-full max-w-xl mx-auto bg-[#0F141A] rounded-t-md p-6 pb-10 border-t border-[#1B222B]">
            <div className="w-12 h-1 bg-[#1B222B] rounded-full mx-auto mb-5" />
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-[#E8ECF1] text-base font-medium">手動記錄結果</h2>
              {livePxClose > 0 && (
                <div className="text-right">
                  <p className="text-[#565E6B] text-[10px]">即時價格</p>
                  <p className="text-[#E8ECF1] text-sm num">{fmtPrice(livePxClose)}</p>
                </div>
              )}
            </div>
            <p className="text-[#565E6B] text-xs mb-4">記錄後自動解除 LINE 推播鎖定</p>

            <p className="text-[#565E6B] text-xs mb-2">選擇結果（自動填入出場價）</p>
            <div className="grid grid-cols-2 gap-2 mb-4">
              {(['WIN_TP1', 'WIN_TP2', 'LOSS', 'MANUAL_CLOSE'] as TradeResult[]).map(r => (
                <button key={r} onClick={() => autoFill(r)}
                  className={`py-2.5 rounded-xl text-sm font-semibold border transition-colors ${exitResult === r ? 'border-transparent' : 'border-[#1B222B] text-[#565E6B]'}`}
                  style={exitResult === r ? { background: `${RESULT_COLOR[r]}20`, color: RESULT_COLOR[r], borderColor: RESULT_COLOR[r] } : {}}>
                  {RESULT_LABEL[r]}
                </button>
              ))}
            </div>

            {/* Actual entry correction — for limit orders that filled at a different price */}
            <div className="bg-[#0D1020] border border-[#2DD4BF]/15 rounded-xl px-3 py-2.5 mb-3">
              <p className="text-[#6B5A20] text-[9px] font-bold uppercase tracking-widest mb-1">實際成交進場價（限價單修正）</p>
              <p className="text-[#3A424E] text-[10px] mb-2">
                掛單設定價：<span className="text-[#E8ECF1] font-semibold">${closeModal ? fmtPrice(closeModal.entry) : ''}</span>
                {' '}— 若實際成交價不同，請填入以下欄位
              </p>
              <input
                value={actualEntry}
                onChange={e => setActualEntry(e.target.value)}
                placeholder={`留空 = 沿用掛單價 $${closeModal ? fmtPrice(closeModal.entry) : ''}`}
                type="number"
                className="input-field text-sm"
              />
            </div>

            <p className="text-[#565E6B] text-xs mb-1">出場價格</p>
            <input value={exitPrice} onChange={e => setExitPrice(e.target.value)}
              placeholder="輸入出場價" type="number" className="input-field mb-4" />

            <div className="flex gap-3">
              <button onClick={() => setCloseModal(null)} className="flex-1 py-3 rounded-xl bg-[#141A21] text-[#8A94A2] font-semibold border border-[#1B222B]">
                取消
              </button>
              <button onClick={handleClose} className="flex-1 py-3 rounded-xl btn-primary font-semibold">
                確認記錄
              </button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}

function EquityCurve({ data }: { data: number[] }) {
  if (data.length < 2) return null;
  const W = 300, H = 72, P = 8;
  const minV = Math.min(0, ...data);
  const maxV = Math.max(0, ...data);
  const range = maxV - minV || 1;
  const sy = (v: number) => H - P - ((v - minV) / range) * (H - P * 2);
  const sx = (i: number) => P + (i / (data.length - 1)) * (W - P * 2);
  const zero = sy(0);
  const path = data.map((v, i) => `${i === 0 ? 'M' : 'L'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');
  const area = `${path} L${sx(data.length - 1).toFixed(1)},${zero} L${P},${zero}Z`;
  const last = data[data.length - 1];
  const col  = last >= 0 ? '#0ECB81' : '#F6465D';
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 72 }}>
      <line x1={P} y1={zero} x2={W - P} y2={zero} stroke="#252535" strokeWidth="1" strokeDasharray="4,3" />
      <path d={area} fill={`${col}18`} />
      <path d={path} stroke={col} strokeWidth="2" fill="none" strokeLinejoin="round" />
      <circle cx={sx(data.length - 1)} cy={sy(last)} r="3.5" fill={col} />
    </svg>
  );
}

function Tag({ text }: { text: string }) {
  return <span className="text-[10px] px-1.5 py-0.5 rounded border border-[#232B35] text-[#8A94A2]">{text}</span>;
}
