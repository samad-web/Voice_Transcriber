"use client";

import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { cx } from "./cx";

export interface TooltipProps {
  /** Short supplementary text. Never the only place information exists. */
  content: ReactNode;
  /** The trigger. Must itself be focusable - a button or a link. */
  children: ReactNode;
  side?: "top" | "bottom";
  className?: string;
}

/**
 * Hover/focus tooltip.
 *
 * The rules this exists to satisfy come from WCAG 1.4.13 (Content on Hover or
 * Focus), which is the one almost every tooltip fails:
 *
 * - **Dismissible.** Escape hides it without moving the pointer. That is the
 *   requirement that forces this to be a Client Component - CSS `:hover` alone
 *   cannot be dismissed, and a tooltip that permanently covers the control
 *   underneath it is a trap for a screen-magnifier user.
 * - **Hoverable.** The bubble sits inside the same wrapper and does not vanish
 *   when the pointer crosses onto it, so its text can be selected.
 * - **Persistent.** It stays until blur, Escape, or pointer-out - no timeout.
 *
 * It shows on `focus`, not `focus-visible`: a keyboard user reaching the trigger
 * must get the same information a mouse user gets on hover.
 *
 * `aria-describedby` rather than `aria-label`, so the tooltip *supplements* the
 * trigger's own name instead of replacing it. Consequence: the trigger must
 * already have an accessible name - an icon-only button still needs its
 * `aria-label`. A tooltip is not a substitute for a label, because it is not
 * announced at all on a touch device, where there is no hover.
 */
export function Tooltip({ content, children, side = "top", className = "" }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // Capture phase: a tooltip inside an open Dialog must swallow Escape before
    // the dialog does, otherwise dismissing the tooltip also closes the dialog.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  return (
    <span
      className={cx("relative inline-flex", className)}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span aria-describedby={open ? id : undefined} className="inline-flex">
        {children}
      </span>
      {/* role="tooltip" and always rendered-or-not rather than hidden: an
          aria-describedby pointing at a display:none node is not announced by
          every screen reader, so the association is made only while it exists. */}
      {open ? (
        <span
          id={id}
          role="tooltip"
          className={cx(
            "pointer-events-auto absolute left-1/2 z-50 w-max max-w-64 -translate-x-1/2 rounded-sm border border-border bg-surface px-2 py-1 text-xs text-text shadow-md",
            side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
          )}
        >
          {content}
        </span>
      ) : null}
    </span>
  );
}
