import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { ReactElement, ReactNode } from "react";

export interface DetailModalProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

export function DetailModal(props: DetailModalProps): ReactElement | null {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!props.open) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      previousFocus.current?.focus?.();
    };
  }, [props.open, props.onClose]);

  if (!props.open) return null;

  return createPortal(
    <div
      className="lp-modal-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        className="lp-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lp-modal-title"
      >
        <div className="lp-modal-header">
          <h2 id="lp-modal-title" className="lp-modal-title">
            {props.title}
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="lp-modal-close"
            onClick={props.onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="lp-modal-body">{props.children}</div>
      </div>
    </div>,
    document.body,
  );
}
