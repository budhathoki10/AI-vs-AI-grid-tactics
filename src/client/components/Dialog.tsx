import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";

/** Native <dialog>: focus trapping, Escape and inert background come from the browser. */
export function Dialog({ open, title, onClose, children, wide }: { open: boolean; title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? " dialog--wide" : ""}`}
      aria-labelledby="dialog-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dialog-inner">
        <header className="dialog-head">
          <h2 id="dialog-title">{title}</h2>
          <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="dialog-body">{open ? children : null}</div>
      </div>
    </dialog>
  );
}
