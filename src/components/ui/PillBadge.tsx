interface PillBadgeProps {
  label: string;
  color: string;
  pulse?: boolean;
}

export function PillBadge({ label, color, pulse = false }: PillBadgeProps) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full whitespace-nowrap"
      style={{ background: `${color}24`, color }}
    >
      {pulse && (
        <span
          className="w-1.5 h-1.5 rounded-full animate-pulse"
          style={{ background: color }}
        />
      )}
      {label}
    </span>
  );
}
