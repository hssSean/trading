'use client';
// S3 頁面共用的格式化與小元件（首頁、訊號、帳本、紀錄）。
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';

export const fmtR = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}R`);
export const fmtPct = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`);
export const fmtU = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}U`);
export const fmtPx = (p: number | null | undefined) => (p == null || !Number.isFinite(p) || p === 0 ? '—' : p >= 1000 ? p.toFixed(1) : p >= 1 ? p.toFixed(4) : p.toPrecision(4));
export const fmtD = (t: number | null | undefined) => (t ? `${new Date(t).getMonth() + 1}/${new Date(t).getDate()}` : '—');
export const fmtT = (t: number | null | undefined) => {
  if (!t) return '—';
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
/** 倒數：1:02:03 */
export const fmtCountdown = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
export const color = (x: number | null | undefined) => (x == null || !Number.isFinite(x) || x === 0 ? 'text-[#8A94A2]' : x > 0 ? 'text-up' : 'text-down');
export const coin = (s: string) => s.replace(/USDT$/, '');
export const EXIT_LABEL: Record<string, string> = { stop: '止損', breakeven: '保本', trail: '移動止損', ema: '跌破 EMA20' };

export function Card({ children, accent = false, className = '' }: { children: ReactNode; accent?: boolean; className?: string }) {
  return <div className={`bg-[#0D0D16] border ${accent ? 'border-accent/30' : 'border-[#1B222B]'} rounded-xl p-3 ${className}`}>{children}</div>;
}

export function CardTitle({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <p className="text-[#E8ECF1] text-xs leading-5">{title}</p>
      {right && <div className="text-[#565E6B] text-[10px] num whitespace-nowrap">{right}</div>}
    </div>
  );
}

/** 一排數字；c 給數值時依正負上色，undefined 則用一般字色 */
export function Stats({ items }: { items: [string, string, (number | null | undefined)?][] }) {
  return (
    <div className={`grid gap-2 mt-2.5 num ${items.length === 3 ? 'grid-cols-3' : 'grid-cols-4'}`}>
      {items.map(([k, v, c], i) => (
        <div key={`${k}-${i}`}>
          <p className="text-[#565E6B] text-[10px]">{k}</p>
          <p className={`text-sm ${c === undefined ? 'text-[#E8ECF1]' : color(c)}`}>{v}</p>
        </div>
      ))}
    </div>
  );
}

export function Row({ left, sub, right, rc, onClick }: { left: string; sub: string; right: string; rc?: number | null; onClick?: () => void }) {
  return (
    <div onClick={onClick} className={`flex items-center justify-between bg-[#0A0D11] rounded-lg px-2.5 py-2 num ${onClick ? 'active:bg-[#141A21]' : ''}`}>
      <div className="min-w-0">
        <p className="text-[11px] text-[#E8ECF1]">{left}</p>
        <p className="text-[10px] text-[#565E6B] truncate">{sub}</p>
      </div>
      <p className={`text-[11px] whitespace-nowrap pl-2 ${rc === undefined ? 'text-accent' : color(rc)}`}>{right}</p>
    </div>
  );
}

/** 進度條：value / limit，超過 70% 轉黃、達到轉紅 */
export function Meter({ label, value, limit, fmt }: { label: string; value: number; limit: number; fmt: (v: number) => string }) {
  const r = limit > 0 ? Math.min(1, Math.max(0, value / limit)) : 0;
  const bar = r >= 1 ? 'bg-down' : r >= 0.7 ? 'bg-[#F0B90B]' : 'bg-accent/60';
  return (
    <div>
      <div className="flex justify-between text-[10px] num">
        <span className="text-[#565E6B]">{label}</span>
        <span className="text-[#8A94A2]">{fmt(value)} / {fmt(limit)}</span>
      </div>
      <div className="h-1 bg-[#1B222B] rounded-full overflow-hidden mt-1">
        <div className={`h-full ${bar}`} style={{ width: `${r * 100}%` }} />
      </div>
    </div>
  );
}

export const Empty = ({ text }: { text: string }) => <p className="text-[#565E6B] text-[11px] text-center py-3 leading-5">{text}</p>;

export const ErrorBox = ({ text }: { text: string }) => (
  <div className="bg-[#0D0D16] border border-[#F6465D]/30 rounded-xl p-3">
    <p className="text-[#F6465D] text-xs">{text}</p>
  </div>
);

export function PageHeader({ title, sub, back, right }: { title: string; sub?: ReactNode; back?: string; right?: ReactNode }) {
  const router = useRouter();
  return (
    <div className="px-3 pt-14 pb-2.5 safe-top border-b border-[#1B222B]">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-[#E8ECF1] text-[15px] font-medium tracking-[0.05em]">{title}</h1>
          {sub && <div className="text-[#565E6B] text-[10px] mt-0.5 num">{sub}</div>}
        </div>
        {right}
        {back && (
          <button onClick={() => router.push(back)} className="text-[#8A94A2] text-[11px] px-2.5 py-1 border border-[#232B35] rounded active:bg-[#141A21] shrink-0">
            返回
          </button>
        )}
      </div>
    </div>
  );
}

/** 分段切換鈕 */
export function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-1 overflow-x-auto">
      {options.map(([k, label]) => (
        <button key={k} onClick={() => onChange(k)}
          className={`text-[11px] px-2.5 py-1 rounded-full border whitespace-nowrap ${value === k ? 'border-accent/50 text-accent bg-accent/10' : 'border-[#232B35] text-[#8A94A2]'}`}>
          {label}
        </button>
      ))}
    </div>
  );
}
