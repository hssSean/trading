'use client';
// 首頁的四張卡：狀態列、今天、帳戶、持倉（docs/superpowers/specs/2026-10-07-s3-app-redesign-design.md「首頁」）。
import { useEffect, useState } from 'react';
import { usePrice } from '@/store/usePriceStore';
import { LEGS, LEG_KEYS, legMeta, legsOf, type LivePos } from '@/engine/s3aLive';
import { HEARTBEAT_STALE_MS, haltProgress, legUnrealizedR, nextDecisionAt, unrealizedR, type TodaySummary } from '@/lib/s3s1/view';
import { Card, CardTitle, Empty, Meter, Stats, coin, color, fmtCountdown, fmtPct, fmtPx, fmtR, fmtT, fmtU } from './ui';

/** 每秒更新的現在時間（倒數用） */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}

export function StatusStrip({ heartbeatAt, meta, now }: { heartbeatAt: number | null; meta: Record<string, unknown>; now: number }) {
  const alive = heartbeatAt != null && now - heartbeatAt < HEARTBEAT_STALE_MS;
  const mode = meta.mode === 'dry' ? 'DRY RUN（只印不下單）' : meta.mode === 'live' ? 'testnet 真下單' : '模式未知';
  const halted = LEG_KEYS.map(k => [k, legMeta(meta, k).halted] as const).filter(([, h]) => h);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] num px-1">
      <span className={alive ? 'text-up' : 'text-down'}>
        ● live-runner {alive ? '運作中' : heartbeatAt ? `沒在跑（最後 ${fmtT(heartbeatAt)}）` : '沒在跑'}
      </span>
      <span className={meta.mode === 'dry' ? 'text-[#F0B90B]' : 'text-[#8A94A2]'}>{mode}</span>
      {halted.map(([k, h]) => <span key={k} className="text-down">⛔ {LEGS[k].name} 已停用：{h}</span>)}
    </div>
  );
}

export function TodayCard({ today, now }: { today: TodaySummary; now: number }) {
  const next = nextDecisionAt(now);
  const inWindow = now - today.X < 2 * 3_600_000;
  return (
    <Card>
      <CardTitle title="今天" right={<>下次決策 {fmtCountdown(next - now)}（台灣 08:00）</>} />
      {!today.ready ? (
        <Empty text="今天的市場資料在 UTC 00:05（台灣 08:05）後產生" />
      ) : (
        <>
          <Stats items={[
            ['BTC 條件', today.btcOk ? '✓ 站上 EMA50' : '✗ 不成立', today.btcOk ? 1 : -1],
            ['市場廣度', today.breadth == null ? '—' : `${(today.breadth * 100).toFixed(0)}% / 93%`, today.breadth != null && today.breadth < 0.93 ? 1 : -1],
            ['候選', `${today.candidates} 個`],
          ]} />
          <div className="mt-2.5 space-y-1 text-[11px] leading-5">
            {today.opened.length > 0 && <p className="text-up">開倉：{today.opened.map(coin).join('、')}</p>}
            {today.blocked.map(b => (
              <p key={b.symbol} className="text-[#8A94A2]">擋掉 {coin(b.symbol)}：<span className="text-[#565E6B]">{b.reason}</span></p>
            ))}
            {today.candidates === 0 && <p className="text-[#565E6B]">今天沒有突破訊號</p>}
            {today.candidates > 0 && !today.opened.length && !today.blocked.length && (
              <p className="text-[#565E6B]">{inWindow ? '等待 live-runner 處理…' : 'live-runner 沒有在進場時間內處理今天的訊號'}</p>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

export function LiveAccountCard({ meta }: { meta: Record<string, unknown> }) {
  const wallet = Number(meta.wallet);
  return (
    <Card accent>
      <CardTitle title="testnet 帳戶（S3-A＋S3-B 同帳戶分帳）" right={meta.walletAt ? <>更新 {fmtT(Number(meta.walletAt))}</> : undefined} />
      <p className="text-[#565E6B] text-[10px] mt-2 num">錢包權益 <span className="text-[#E8ECF1] text-sm">{Number.isFinite(wallet) && wallet > 0 ? `${wallet.toFixed(0)} USDT` : '—'}</span></p>
      {LEG_KEYS.map(k => {
        const m = legMeta(meta, k);
        const h = haltProgress(meta, k);
        return (
          <div key={k} className="mt-3 pt-2.5 border-t border-[#1B222B]">
            <p className="text-[11px] text-[#E8ECF1]">{LEGS[k].name}<span className="text-[#565E6B]">・每筆 {LEGS[k].F * 100}%{k === 'B' ? '・+1R 加碼' : ''}</span></p>
            <Stats items={[
              ['權益', m.base > 0 ? `${m.equity.toFixed(0)}U` : '—'],
              ['已實現', fmtU(m.realized, 1), m.realized],
              ['報酬', m.base > 0 ? fmtPct(m.realized / m.base * 100, 2) : '—', m.base > 0 ? m.realized : undefined],
            ]} />
            <div className="mt-2 space-y-2">
              <Meter label="回撤（停用條件）" value={h.ddPct} limit={h.ddLimit} fmt={v => `${v.toFixed(1)}%`} />
              <Meter label="連續虧損（停用條件）" value={h.streak} limit={h.streakLimit} fmt={v => `${v} 筆`} />
            </div>
          </div>
        );
      })}
      <p className="text-[#3A424E] text-[9px] mt-2 leading-4">兩個策略的起始權益各算錢包的一半；同一個幣只開一個部位、共用止損，出場時依成交紀錄分帳。達到停用條件會自動停止那個策略開新倉。</p>
    </Card>
  );
}

export function LivePositionCard({ p }: { p: LivePos }) {
  const price = usePrice(p.symbol);
  const ur = unrealizedR(p, price);
  const legs = legsOf(p);
  const R1 = p.entry - p.stop0;
  const tp = p.entry + (p.entry - p.stop0);
  const [open, setOpen] = useState(false);
  const moves = (p.events ?? []).filter(e => e.kind !== 'entry');
  return (
    <Card>
      <CardTitle title={`${coin(p.symbol)}・做多${p.partial ? '・已平 1/3' : ''}${p.addFilled ? '・已加碼' : ''}`} right={<>進場 {fmtT(p.entryAt)}</>} />
      <div className="flex items-end justify-between mt-2 num">
        <div>
          <p className="text-[#565E6B] text-[10px]">現價</p>
          <p className="text-[#E8ECF1] text-lg">{fmtPx(price)}</p>
        </div>
        <p className={`text-xl ${color(ur)}`}>{fmtR(ur)}</p>
      </div>
      <Stats items={[
        ['進場', fmtPx(p.entry)],
        ['止損', fmtPx(p.stop), p.stop >= p.entry ? 1 : undefined],
        [p.partial ? '+1R（已成交）' : '+1R 平 1/3', fmtPx(tp)],
        ['數量', String(p.qty0)],
      ]} />
      <div className="mt-2 space-y-0.5 text-[10px] num">
        {LEG_KEYS.filter(k => legs[k]).map(k => {
          const r = legUnrealizedR(p, price, k);
          return (
            <p key={k} className="flex justify-between">
              <span className="text-[#8A94A2]">{LEGS[k].name} {legs[k]!.qty0}{k === 'B' && (p.addQty ?? 0) > 0 ? `＋加碼 ${p.addQty}（${p.addFilled ? '已成交' : `待觸發 @ ${fmtPx(p.entry + R1)}`}）` : ''}</span>
              <span className={color(r)}>{fmtR(r)}</span>
            </p>
          );
        })}
      </div>
      {moves.length > 0 && (
        <button onClick={() => setOpen(v => !v)} className="w-full mt-2 text-[10px] text-[#8A94A2] py-1 border-t border-[#1B222B]">
          {open ? '收起' : `止損移動與事件（${moves.length}）`}
        </button>
      )}
      {open && (
        <div className="mt-1 space-y-0.5 text-[10px] num">
          {moves.map((e, i) => (
            <p key={i} className="text-[#8A94A2]">{fmtT(e.t)}　{EVENT_LABEL[e.kind] ?? e.kind}{e.px != null ? ` ${fmtPx(e.px)}` : ''}{e.note ? `（${e.note}）` : ''}</p>
          ))}
        </div>
      )}
    </Card>
  );
}

export const EVENT_LABEL: Record<string, string> = {
  entry: '進場', tp1: '止盈 1/3 成交', stop: '止損移到', stop_replace: '補掛止損', tp_replace: '補掛止盈',
  tp_market: '市價平 1/3', close_market: '市價平倉',
  addon: 'B 加碼成交', add_replace: '補掛加碼單', add_market: '市價加碼', stop_resize: '止損改數量',
};
