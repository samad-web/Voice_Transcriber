"use client";

import { useEffect, useId, useRef } from "react";
import type { ReactNode, SyntheticEvent } from "react";
import { cx } from "./cx";

export interface DialogProps {
  open: boolean;
  /** Called for every dismissal route: Escape, the close button, the backdrop. */
  onClose: () => void;
  /** The dialog's accessible name. Required. */
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  /** Action row. Put the confirming `Button` last, the way the OS does. */
  footer?: ReactNode;
  /** Clicking the backdrop dismisses. Turn OFF for destructive confirmations. */
  dismissOnBackdrop?: boolean;
  className?: string;
}

/**
 * Modal dialog built on the native `<dialog>` element.
 *
 * This is the whole reason it is short. `showModal()` gives us, from the
 * browser, every one of the things a hand-rolled modal gets wrong:
 *
 * - **Focus trap.** Tab cannot leave the dialog. No focus-sentinel divs, no
 *   querySelectorAll of focusable elements that goes stale the moment the
 *   content is dynamic.
 * - **Escape to close** (fires `cancel`), which WCAG 2.1.2 requires.
 * - **The rest of the page becomes inert** — background content is not
 *   reachable by tab, by screen-reader virtual cursor, or by click.
 * - **Focus returns** to whatever opened it on close.
 * - Top-layer rendering, so no z-index war with a sticky sidebar.
 *
 * `open` stays a React prop rather than the element's `open` attribute: setting
 * `open` directly renders a *non-modal* dialog with none of the above, which is
 * a silent and very easy mistake. The effect below is the only thing that opens
 * it, and it always goes through `showModal()`.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  dismissOnBackdrop = true,
  className = "",
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Guard on el.open both ways: calling showModal() on an already-open dialog
    // throws InvalidStateError, and close() on a closed one fires a spurious
    // `close` event that would loop back into onClose.
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      // Escape fires `cancel` first. preventDefault stops the browser closing
      // the element behind React's back — otherwise the DOM is closed while
      // `open` is still true, and the next open() is a no-op.
      onCancel={(e: SyntheticEvent<HTMLDialogElement>) => {
        e.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (open) onClose();
      }}
      onClick={(e) => {
        // A click on the backdrop has the <dialog> itself as its target; a click
        // on anything inside targets that child. This is the standard way to
        // tell them apart without an extra overlay div.
        if (dismissOnBackdrop && e.target === ref.current) onClose();
      }}
      className={cx(
        "m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface p-0 text-text shadow-lg",
        "backdrop:bg-black/50",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div className="min-w-0">
          <h2 id={titleId} className="text-lg font-semibold text-text">
            {title}
          </h2>
          {description ? (
            <p id={descId} className="mt-1 text-sm text-text-muted">
              {description}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          // Icon-only: without this label a screen reader announces "button".
          aria-label="Close dialog"
          className="-mr-1 shrink-0 cursor-pointer rounded-sm p-1 text-text-muted transition-colors duration-150 ease-out hover:bg-surface-hover hover:text-text"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none">
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {children ? <div className="px-6 py-5">{children}</div> : null}

      {footer ? (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-bg-subtle px-6 py-4">
          {footer}
        </div>
      ) : null}
    </dialog>
  );
}
