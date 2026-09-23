"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { cx } from "./cx";

export type PopoverAlign = "start" | "end" | "stretch";
export type PopoverSide = "bottom" | "top";

export interface PopoverProps {
  open: boolean;
  /** Called for every dismissal route: Escape, an outside click. */
  onDismiss: () => void;
  /** The control that opens it. Rendered inside the anchor, always visible. */
  trigger: ReactNode;
  children: ReactNode;
  /**
   * Which edge the panel is pinned to. `stretch` spans the anchor's full width -
   * what a search box's results want, so the panel and the field line up.
   */
  align?: PopoverAlign;
  /**
   * Which way it opens. `bottom` (the default, and every caller before doc 27)
   * hangs below the trigger; `top` sits above it - for a trigger pinned to the
   * bottom of the viewport, like the account menu at the foot of the sidebar,
   * where a downward panel would open off-screen.
   *
   * A prop rather than positioning classes at the call site on purpose: a
   * caller's className cannot reliably override this file's base classes (cx
   * is a plain join and Tailwind breaks the tie by stylesheet order), so
   * `className="bottom-full"` beside a base `mt-2` would be a coin toss.
   */
  side?: PopoverSide;
  /** Panel width / max-height / padding. The chrome itself is not overridable. */
  className?: string;
  /** Positioning context. Width and `min-w-0` for the anchor, not the panel. */
  anchorClassName?: string;
  /**
   * Return focus to whatever had it when the popover opened. Suppressed when
   * focus has already moved somewhere outside - see the note below.
   */
  restoreFocus?: boolean;
}

/**
 * A panel anchored to a trigger: the workspace switcher, the notification bell,
 * the global-search results, the record picker.
 *
 * ── WHY IT EXISTS ──────────────────────────────────────────────────────────
 *
 * Those four were written separately and had converged on the same chrome by
 * copying - `rounded-md border border-border bg-surface shadow-lg`, identical
 * in all four - while diverging on everything that is not visible in a
 * screenshot:
 *
 *   - `z-50`, `z-50`, `z-50`, `z-40`
 *   - `mt-2`, `mt-2`, `mt-2`, `mt-1`
 *   - Escape on a document listener (x3) vs. only on the input's own onKeyDown
 *   - `aria-haspopup` on one of four
 *   - and none of the four returned focus to its trigger on close
 *
 * That last one is the one a user feels: dismiss the bell with Escape and focus
 * was on `<body>`, so the next Tab started from the top of the document. WCAG
 * 2.4.3 is about exactly that. A rule kept by copying is a rule that drifts on
 * the fifth copy, which is the argument this file is - the same argument
 * state.tsx makes for colour.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────
 *
 * No listbox semantics, no roving tabindex, no arrow keys. The four panels hold
 * genuinely different content - a list of workspaces, a tablist over
 * notifications, grouped search hits, search results - and the correct ARIA for
 * each is a property of that content, not of the box around it. Baking a
 * listbox in here would force three of the four to fight it, and select.tsx's
 * own docblock is already on record that a hand-rolled listbox is the single
 * most common source of keyboard and screen-reader regressions. The call site
 * keeps `role`, `aria-*` and key handling; this owns position, chrome and
 * dismissal.
 *
 * It is also NOT a modal. No focus trap, no inert background, no top layer -
 * that is `Dialog`, and the distinction is deliberate: a popover is a
 * non-blocking accessory to the control it hangs off, and trapping focus in one
 * is how you get a bell icon nobody can tab past.
 *
 * ── WHY MOUSEDOWN AND NOT CLICK ────────────────────────────────────────────
 *
 * On `click` the panel is still open through the whole press, so a mousedown
 * inside it followed by a mouseup outside (a drag to select text) would dismiss
 * it. `mousedown` also beats the browser's focus change, so the panel is gone
 * before the next control takes focus rather than after.
 */
export function Popover({
  open,
  onDismiss,
  trigger,
  children,
  align = "start",
  side = "bottom",
  className = "",
  anchorClassName = "",
  restoreFocus = true,
}: PopoverProps) {
  const anchor = useRef<HTMLDivElement>(null);
  /** What had focus at the moment it opened, to hand back on close. */
  const opener = useRef<Element | null>(null);

  /*
   * `onDismiss` is an inline arrow at every call site, so it is a new function
   * on every render. Held in a ref and kept out of the effect's deps below:
   * otherwise the effect re-runs on each render while open, which would tear
   * down and re-add the listeners needlessly and - the actual bug - recapture
   * `opener` from whatever has focus *now*, which by then is inside the panel.
   * Focus restoration would then hand focus back to the panel it just closed.
   */
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  });

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;

    const onDown = (event: MouseEvent) => {
      if (anchor.current && !anchor.current.contains(event.target as Node)) dismiss.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Capture phase, same as Tooltip's: a popover inside a Dialog must
      // swallow Escape before the dialog sees it, or dismissing the popover
      // closes the whole dialog underneath it.
      event.stopPropagation();
      dismiss.current();
    };

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // Hand focus back, but only if it is still inside the popover (or nowhere).
  // Dismissing by clicking another control means focus has already, correctly,
  // gone there - stealing it back would make that click do nothing visible.
  // Navigation is the other case this protects: global search dismisses itself
  // on the way to another route, and pulling focus back to the search box after
  // the new page mounts would be actively wrong.
  useEffect(() => {
    if (open || !restoreFocus) return;
    const previous = opener.current;
    opener.current = null;
    if (!previous || !(previous instanceof HTMLElement)) return;
    const active = document.activeElement;
    const focusIsLoose = active === null || active === document.body;
    const focusIsInside = active instanceof Node && anchor.current?.contains(active) === true;
    if (focusIsLoose || focusIsInside) previous.focus();
  }, [open, restoreFocus]);

  return (
    <div ref={anchor} className={cx("relative", anchorClassName)}>
      {trigger}
      {open ? (
        <div
          className={cx(
            // One 8px gap and `z-50` for every popover in the product, rather
            // than three values of each. The panel sits above sticky chrome
            // but below Dialog, which is in the browser's top layer and
            // outside the z-index system entirely.
            "absolute z-50 rounded-md border border-border bg-surface shadow-lg",
            side === "top" ? "bottom-full mb-2" : "mt-2",
            // Never wider than the viewport on a phone, whatever width the
            // caller asked for. Three of the four had grown this by hand.
            "max-w-[calc(100vw-2rem)]",
            align === "start" && "left-0",
            align === "end" && "right-0",
            align === "stretch" && "right-0 left-0",
            className,
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
