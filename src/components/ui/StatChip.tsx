import { ReactNode } from 'react';

interface StatChipProps {
  icon: ReactNode;
  label: string;
  value: string;
  valueClassName?: string;
}

export function StatChip({ icon, label, value, valueClassName = 'text-text-p' }: StatChipProps) {
  return (
    <div className="flex-1 flex items-center gap-2.5 rounded-[10px] bg-white/[0.04] px-3 py-2.5 min-w-0">
      <span className="text-text-s shrink-0">{icon}</span>
      <div className="min-w-0">
        <div className="text-[10px] text-text-s truncate">{label}</div>
        <div className={`text-[12px] num mt-0.5 truncate ${valueClassName}`}>{value}</div>
      </div>
    </div>
  );
}
