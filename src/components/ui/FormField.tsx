interface FormFieldProps {
  label: string;
  type?: 'text' | 'number' | 'password' | 'email';
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}

export function FormField({ label, type = 'text', value, onChange, placeholder }: FormFieldProps) {
  return (
    <label className="block">
      <span className="block text-[11px] text-text-s mb-1.5">{label}</span>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-card-2 border border-white/[0.06] rounded-[10px] px-3 py-2.5 text-[13px] text-text-p outline-none focus:border-accent focus:ring-1 focus:ring-accent/40 transition-colors placeholder:text-text-m"
      />
    </label>
  );
}
