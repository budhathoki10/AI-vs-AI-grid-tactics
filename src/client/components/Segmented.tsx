import { useId } from "react";

export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  hideLabel,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
  hideLabel?: boolean;
}) {
  const id = useId();
  return (
    <div className="seg-field">
      <span id={id} className={hideLabel ? "sr-only" : "seg-label"}>
        {label}
      </span>
      <div className="segmented" role="radiogroup" aria-labelledby={id}>
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            title={o.title}
            className="segmented-item"
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
