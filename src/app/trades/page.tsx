'use client';
import { useState, useCallback } from 'react';
import { useStore } from '@/store/useStore';
import { TradeResult } from '@/types';

const RESULT_LABEL: Record<string, string> = {
  WIN_TP1:      'TP1 達標',
  WIN_TP2:      'TP2 達標',
  LOSS:         '止損出場',
  MANUAL_CLOSE: '手動平倉',
};

const RESULT_COLOR: Record<string, string> = {
  WIN_TP1:      '#00C851',
  WIN_TP2:      '#00A040',
  LOSS:         '#FF4444',
  MANUAL_CLOSE: '#F0B90B',
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
  fetch(`/api/analyze?secret=${encodeURIComponent(secret)}&symbol=${symbol}`, { method: 'DELETE' }).catch(() => {});
}

export default function TradesPage() {
  const trades      = useStore(s => s.trades);
  const coins       = useStore(s => s.coins);
  const closeTrade  = useStore(s => s.closeTrade);
  const deleteTrade = useStore(s => s.deleteTrade);

  const [closeModal, setCloseModal] = useState<{
    id: string; symbol: string; direction: 'LONG' | 'SHORT';
    entry: number; tp1: number; tp2: number; sl: number;
  } | null>(null);
  const [exitPrice,  setExitPrice]  = useState('');
  const [exitResult, setExitResult] = useState<TradeResult>('WIN_TP1');
  const [filter,     setFilter]     = useState<'ALL' | 'PENDING' | 'CLOSED'>('ALL');
  const [unlockMsg,  setUnlockMsg]  = useState<Record<string, boolean>>({});
  const now = Date.now();

  const closed  = trades.filter(t => !!t.result);
  const pending = trades.filter(t => !t.result);
  const wins    = closed.filter(t => t.result === 'WIN_TP1' || t.result === 'WIN_TP2');
  const losses  = closed.filter(t => t.result === 'LOSS');
  const winRate = closed.length > 0 ? Math.round((wins.length / closed.length) * 100) : null;
  const avgPnl  = closed.length > 0
    ? (closed.reduce((a, t) => a + (t.pnlPercent ?? 0), 0) / closed.length).toFixed(2)
    : null;
  // Profit factor = sum(profit) / abs(sum(loss))
  const totalWin  = wins.reduce((a, t) => a + Math.max(t.pnlPercent ?? 0, 0), 0);
  const totalLoss = Math.abs(losses.reduce((a, t) => a + Math.min(t.pnlPercent ?? 0, 0), 0));
  const profitFactor = totalLoss > 0 ? (totalWin / totalLoss).toFixed(2) : null;

  const filtered = filter === 'PENDING' ? pending : filter === 'CLOSED' ? closed : trades;

  const exportCsv = () => {
    const header = 'ID,幣種,方向,週期,強度,得分,進場價,止損,TP1,TP2,開倉時間,平倉時間,結果,出場價,損益%';
    const rows = trades.map(t =>
      [
        t.id, t.symbol, t.direction, t.timeframe, t.strength, t.score,
        t.entry, t.stopLoss, t.tp1, t.tp2,
        fmtDate(t.openedAt),
        t.closedAt ? fmtDate(t.closedAt) : '',
        t.result ? RESULT_LABEL[t.result] : '持倉中',
        t.exitPrice ?? '',
        t.pnlPercent ?? '',
      ].join(',')
    );
    const csv  = [header, ...rows].join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `trades-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClose = () => {
    if (!closeModal) return;
    const price = parseFloat(exitPrice);
    if (isNaN(price) || price <= 0) return;
    closeTrade(closeModal.id, exitResult, price);
    unlockCoin(closeModal.symbol);
    setCloseModal(null);
    setExitPrice('');
  };

  const handleManualUnlock = useCallback((symbol: string) => {
    unlockCoin(symbol);
    setUnlockMsg(prev => ({ ...prev, [symbol]: true }));
    setTimeout(() => setUnlockMsg(prev => ({ ...prev, [symbol]: false })), 2500);
  }, []);

  const autoFill = (result: TradeResult) => {
    setExitResult(result);
    if (!closeModal) return;
    if (result === 'WIN_TP1')      setExitPrice(String(closeModal.tp1));
    else if (result === 'WIN_TP2') setExitPrice(String(closeModal.tp2));
    else if (result === 'LOSS')    setExitPrice(String(closeModal.sl));
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 pt-14 pb-3 safe-top border-b border-[#1E1E2E]">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-[#EAEAF4] text-xl font-extrabold tracking-tight">交易紀錄</h1>
            <p className="text-[#606080] text-xs mt-0.5">{trades.length} 筆 · 自動偵測止盈止損</p>
          </div>
          <button onClick={exportCsv} className="text-[#F0B90B] text-xs font-semibold px-3 py-1.5 border border-[#F0B90B]/40 rounded-full active:opacity-70">
            匯出 CSV
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-1.5 mb-3">
          <StatCard label="總交易" value={String(closed.length)} sub={`${pending.length} 持倉`} />
          <StatCard
            label="勝率"
            value={winRate !== null ? `${winRate}%` : '—'}
            sub={`${wins.length}W ${closed.length - wins.length}L`}
            color={winRate !== null ? (winRate >= 50 ? '#00C851' : '#FF4444') : undefined}
          />
          <StatCard
            label="平均損益"
            value={avgPnl !== null ? `${parseFloat(avgPnl) >= 0 ? '+' : ''}${avgPnl}%` : '—'}
            sub="每筆"
            color={avgPnl !== null ? (parseFloat(avgPnl) >= 0 ? '#00C851' : '#FF4444') : undefined}
          />
          <StatCard
            label="獲利因子"
            value={profitFactor ?? '—'}
            sub="利/損比"
            color={profitFactor ? (parseFloat(profitFactor) >= 1 ? '#00C851' : '#FF4444') : undefined}
          />
        </div>

        {/* Filter tabs */}
        <div className="flex gap-2">
          {(['ALL', 'PENDING', 'CLOSED'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`text-xs px-3 py-1 rounded-full font-semibold border transition-colors ${filter === f ? 'bg-[#F0B90B] border-[#F0B90B] text-[#0A0A0F]' : 'border-[#1E1E2E] text-[#606080]'}`}>
              {f === 'ALL' ? '全部' : f === 'PENDING' ? `持倉中 (${pending.length})` : `已結束 (${closed.length})`}
            </button>
          ))}
        </div>
      </div>

      {/* Trade list */}
      <div className="flex-1 overflow-y-auto px-4 pt-3 scroll-container">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-2 text-center">
            <p className="text-5xl">📋</p>
            <p className="text-[#A0A0C0] font-semibold">還沒有交易紀錄</p>
            <p className="text-[#606080] text-sm">收到 LINE 推薦時自動新增，並自動偵測止盈止損</p>
          </div>
        ) : (
          filtered.map(trade => {
            const isPending = !trade.result;
            const isWin     = trade.result === 'WIN_TP1' || trade.result === 'WIN_TP2';
            const coinData  = coins.find(c => c.symbol === trade.symbol);
            const livePx    = coinData?.currentPrice ?? 0;

            // Live PnL and distances (only for pending trades with live price)
            let livePnl    = 0;
            let distTP1    = 0;
            let distSL     = 0;
            let nearSL     = false;
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
              nearSL = distSL < 1.5; // within 1.5% of SL
            }

            return (
              <div key={trade.id} className={`bg-[#12121A] rounded-2xl p-4 mb-3 border ${
                isPending && nearSL ? 'border-red-500/50' : 'border-[#1E1E2E]'
              }`}>
                {/* Top row */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-sm font-extrabold ${trade.direction === 'LONG' ? 'text-[#00C851]' : 'text-[#FF4444]'}`}>
                      {trade.direction === 'LONG' ? '▲ 做多' : '▼ 做空'}
                    </span>
                    <span className="text-[#EAEAF4] font-bold">{trade.symbol.replace('USDT', '/USDT')}</span>
                    <span className="text-[#606080] text-xs">{trade.timeframe}</span>
                    {isPending && (
                      <span className="text-xs text-[#404060]">{fmtDuration(now - trade.openedAt)}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {isPending ? (
                      <>
                        {livePx > 0 && (
                          <span className={`text-xs font-bold ${livePnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {livePnl >= 0 ? '+' : ''}{livePnl.toFixed(2)}%
                          </span>
                        )}
                        <span className="text-xs bg-[#F0B90B]/20 text-[#F0B90B] px-2 py-0.5 rounded-full font-semibold">持倉中</span>
                      </>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
                        style={{ background: `${RESULT_COLOR[trade.result!]}20`, color: RESULT_COLOR[trade.result!] }}>
                        {RESULT_LABEL[trade.result!]}
                      </span>
                    )}
                    <span className="text-[#F0B90B] text-xs font-bold">{trade.score}分</span>
                  </div>
                </div>

                {/* Price grid */}
                <div className="grid grid-cols-4 gap-1 mb-2">
                  <PriceCell label="進場" value={`$${fmtPrice(trade.entry)}`} />
                  <PriceCell label="TP1"  value={`$${fmtPrice(trade.tp1)}`}      color="#00C851" />
                  <PriceCell label="TP2"  value={`$${fmtPrice(trade.tp2)}`}      color="#00A040" />
                  <PriceCell label="止損" value={`$${fmtPrice(trade.stopLoss)}`} color="#FF4444" />
                </div>

                {/* Distance bars for pending trades */}
                {isPending && livePx > 0 && (
                  <div className="grid grid-cols-2 gap-1.5 mb-2">
                    <div className={`rounded-xl p-2 text-center ${distTP1 > 0 ? 'bg-green-400/5' : 'bg-green-400/15'}`}>
                      <p className="text-[#606080] text-[9px]">距 TP1</p>
                      <p className={`text-xs font-bold ${distTP1 > 0 ? 'text-green-400' : 'text-[#00C851]'}`}>
                        {distTP1 > 0 ? `還差 ${distTP1.toFixed(2)}%` : `超過 ${Math.abs(distTP1).toFixed(2)}%`}
                      </p>
                    </div>
                    <div className={`rounded-xl p-2 text-center ${nearSL ? 'bg-red-500/15' : 'bg-red-400/5'}`}>
                      <p className="text-[#606080] text-[9px]">{nearSL ? '⚠ 接近止損' : '距 SL'}</p>
                      <p className={`text-xs font-bold ${nearSL ? 'text-red-400' : 'text-[#A0A0C0]'}`}>
                        {distSL >= 0 ? `緩衝 ${distSL.toFixed(2)}%` : `穿越 ${Math.abs(distSL).toFixed(2)}%`}
                      </p>
                    </div>
                  </div>
                )}

                {/* Result row for closed trades */}
                {!isPending && trade.exitPrice !== undefined && (
                  <div className="flex items-center justify-between mt-1 pt-2 border-t border-[#1E1E2E]">
                    <span className="text-[#606080] text-xs">出場 ${fmtPrice(trade.exitPrice)}</span>
                    <span className={`text-sm font-extrabold ${isWin ? 'text-[#00C851]' : 'text-[#FF4444]'}`}>
                      {trade.pnlPercent !== undefined ? `${trade.pnlPercent >= 0 ? '+' : ''}${trade.pnlPercent}%` : '—'}
                    </span>
                  </div>
                )}

                {/* Timestamp + actions */}
                <div className="flex items-center justify-between mt-2 pt-2 border-t border-[#1E1E2E]">
                  <span className="text-[#404060] text-xs">{fmtDate(trade.openedAt)}</span>
                  <div className="flex gap-2 flex-wrap justify-end">
                    {isPending && (
                      <>
                        <button
                          onClick={() => handleManualUnlock(trade.symbol)}
                          title="解除 LINE 推播鎖定"
                          className={`text-xs px-2 py-1 rounded-xl border transition-colors ${
                            unlockMsg[trade.symbol]
                              ? 'bg-green-400/10 text-green-400 border-green-400/30'
                              : 'text-[#404060] border-[#1E1E2E] active:opacity-70'
                          }`}
                        >
                          {unlockMsg[trade.symbol] ? '✓ 已解鎖' : '解鎖推播'}
                        </button>
                        <button
                          onClick={() => setCloseModal({
                            id: trade.id, symbol: trade.symbol, direction: trade.direction,
                            entry: trade.entry, tp1: trade.tp1, tp2: trade.tp2, sl: trade.stopLoss,
                          })}
                          className="text-xs px-3 py-1 rounded-xl bg-[#1A1A26] border border-[#1E1E2E] text-[#A0A0C0] font-semibold active:opacity-70"
                        >
                          手動記錄
                        </button>
                      </>
                    )}
                    <button onClick={() => deleteTrade(trade.id)} className="text-xs px-2 py-1 rounded-xl text-[#404060] active:opacity-70">
                      刪除
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div className="h-4" />
      </div>

      {/* Manual close modal */}
      {closeModal && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-end" onClick={e => e.target === e.currentTarget && setCloseModal(null)}>
          <div className="w-full max-w-xl mx-auto bg-[#12121A] rounded-t-3xl p-6 pb-10 border-t border-[#1E1E2E]">
            <div className="w-12 h-1 bg-[#1E1E2E] rounded-full mx-auto mb-5" />
            <h2 className="text-[#EAEAF4] text-lg font-extrabold mb-1">手動記錄結果</h2>
            <p className="text-[#606080] text-xs mb-4">記錄後自動解除 LINE 推播鎖定</p>

            <p className="text-[#606080] text-xs mb-2">選擇結果（自動填入出場價）</p>
            <div className="grid grid-cols-2 gap-2 mb-4">
              {(['WIN_TP1', 'WIN_TP2', 'LOSS', 'MANUAL_CLOSE'] as TradeResult[]).map(r => (
                <button key={r} onClick={() => autoFill(r)}
                  className={`py-2.5 rounded-xl text-sm font-semibold border transition-colors ${exitResult === r ? 'border-transparent' : 'border-[#1E1E2E] text-[#606080]'}`}
                  style={exitResult === r ? { background: `${RESULT_COLOR[r]}20`, color: RESULT_COLOR[r], borderColor: RESULT_COLOR[r] } : {}}>
                  {RESULT_LABEL[r]}
                </button>
              ))}
            </div>

            <p className="text-[#606080] text-xs mb-1">出場價格</p>
            <input value={exitPrice} onChange={e => setExitPrice(e.target.value)}
              placeholder="輸入出場價" type="number" className="input-field mb-4" />

            <div className="flex gap-3">
              <button onClick={() => setCloseModal(null)} className="flex-1 py-3 rounded-xl bg-[#1A1A26] text-[#A0A0C0] font-semibold border border-[#1E1E2E]">
                取消
              </button>
              <button onClick={handleClose} className="flex-1 py-3 rounded-xl btn-primary font-semibold">
                確認記錄
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub: string; color?: string }) {
  return (
    <div className="bg-[#12121A] border border-[#1E1E2E] rounded-2xl p-2.5 text-center">
      <p className="text-[#606080] text-[9px] mb-0.5">{label}</p>
      <p className="font-extrabold text-base" style={{ color: color ?? '#EAEAF4' }}>{value}</p>
      <p className="text-[#404060] text-[9px]">{sub}</p>
    </div>
  );
}

function PriceCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-[#0A0A0F] rounded-xl p-2 text-center">
      <p className="text-[#606080] text-xs">{label}</p>
      <p className="font-bold text-xs mt-0.5" style={{ color: color ?? '#EAEAF4' }}>{value}</p>
    </div>
  );
}
