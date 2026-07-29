interface ToggleChipProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

export function ToggleChip({ label, active, onClick }: ToggleChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-[12px] px-3 py-1.5 rounded-full border transition-colors ${
        active ? 'bg-accent/20 border-accent/40 text-accent' : 'border-white/[0.08] text-text-s'
      }`}
    >
      {label}
    </button>
  );
}
