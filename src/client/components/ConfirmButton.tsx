import { useEffect, useState, type ReactNode } from "react";

/** Two-step button for destructive actions: the first click arms it, the second confirms. Reverts after 3 s. */
export function ConfirmButton({ children, confirmLabel, onConfirm, className = "btn btn--secondary", disabled, title }: { children: ReactNode; confirmLabel: string; onConfirm: () => void; className?: string; disabled?: boolean; title?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className={`${className}${armed ? " btn--danger is-armed" : ""}`}
      disabled={disabled}
      title={title}
      aria-live="polite"
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
      onBlur={() => setArmed(false)}
    >
      {armed ? confirmLabel : children}
    </button>
  );
}
