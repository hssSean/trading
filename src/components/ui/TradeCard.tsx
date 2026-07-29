import { ReactNode } from 'react';

export type TradeCardVariant = 'active' | 'closed' | 'waiting';

interface TradeCardProps {
  variant: TradeCardVariant;
  className?: string;
  onClick?: () => void;
  children: ReactNode;
}

const VARIANT_CLASS: Record<TradeCardVariant, string> = {
  active:  'bg-card-2 border border-white/[0.06]',
  closed:  'bg-card-2-alt border border-white/[0.04]',
  waiting: 'bg-card-2 border border-dashed border-amber-500/30',
};

export function TradeCard({ variant, className = '', onClick, children }: TradeCardProps) {
  return (
    <div
      onClick={onClick}
      className={`relative rounded-card-lg p-4 mb-3 card-enter ${VARIANT_CLASS[variant]} ${className}`}
    >
      {children}
    </div>
  );
}
