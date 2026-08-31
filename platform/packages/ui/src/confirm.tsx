"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "./button";
import { Dialog } from "./dialog";

export interface ConfirmOptions {
  title: string;
  /** The detail paragraph. Where a `window.confirm` used "\n\n", this is the half after it. */
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * `danger` styles the confirming button red AND stops a stray backdrop click
   * from dismissing - for irreversible actions the accidental outcome should be
   * "nothing happened", and a click landing outside the dialog is the most
   * common accident there is.
   */
  tone?: "default" | "danger";
}

type Resolver = (ok: boolean) => void;

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

/**
 * In-app confirmation dialogs, replacing `window.confirm`.
 *
 * ── WHY NOT window.confirm ────────────────────────────────────────────────
 *
 * It is a native modal the page does not control, and it costs four things
 * that matter here:
 *
 *  - It is UNSTYLED and unbranded. A console with its own design system asking
 *    "are you sure?" in a Chrome system box reads as a different application,
 *    and on the destructive actions it guards, that is exactly the moment
 *    someone needs to feel they are still where they think they are.
 *  - It BLOCKS THE MAIN THREAD synchronously. Nothing renders, no pending state
 *    updates flush, no timer runs until the person answers.
 *  - It cannot be dismissed by the app, cannot be tested without stubbing a
 *    global, and renders `\n\n` as a literal line break with no typographic
 *    hierarchy - every one of ours was already faking a title/body split that way.
 *  - Browsers are progressively restricting it: it is already suppressed in
 *    cross-origin iframes, and repeated calls let the user tick "prevent this
 *    page from creating more dialogues" - which silently turns every future
 *    confirm into `false`. A guard that can be switched off by the person it
 *    guards is not a guard.
 *
 * ── WHY A PROMISE, NOT A CONTROLLED COMPONENT ─────────────────────────────
 *
 * The obvious shape is `<ConfirmDialog open={...} onConfirm={...} />` at each
 * call site. That would mean rewriting eleven components to hoist "which action
 * is pending" into state, and every one of them would invent its own slightly
 * different version of it.
 *
 * `await confirm({...})` keeps the exact control flow `window.confirm` had -
 * one line, inline, returning a boolean - so each call site changes by a single
 * line and nothing else moves. The dialog itself lives once, at the layout root.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<Resolver | null>(null);

  /** Settle whatever is pending exactly once, then clear it. */
  const settle = useCallback((ok: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setOptions(null);
    resolve?.(ok);
  }, []);

  // An unmount mid-confirmation (a route change while the dialog is open) would
  // otherwise leave the caller awaiting a promise nobody will ever settle, and
  // its `finally`/`startTransition` would hang forever. Resolve false: the
  // person navigated away, which is not consent.
  useEffect(() => () => resolverRef.current?.(false), []);

  const confirm = useCallback(
    (next: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        // A second request while one is open (double-click on two different
        // destructive buttons) must not strand the first promise. The earlier
        // question is answered "no" - never "yes" - and replaced.
        resolverRef.current?.(false);
        resolverRef.current = resolve;
        setOptions(next);
      }),
    [],
  );

  const danger = options?.tone === "danger";

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={options !== null}
        onClose={() => settle(false)}
        title={options?.title ?? ""}
        dismissOnBackdrop={!danger}
        footer={
          <>
            <Button variant="secondary" onClick={() => settle(false)}>
              {options?.cancelLabel ?? "Cancel"}
            </Button>
            <Button variant={danger ? "danger" : "primary"} onClick={() => settle(true)}>
              {options?.confirmLabel ?? "Confirm"}
            </Button>
          </>
        }
      >
        {options?.body ? (
          // whitespace-pre-line so a caller can still pass "\n" and get the
          // paragraph break it expects, matching the old strings.
          <p className="whitespace-pre-line text-sm text-text-muted">{options.body}</p>
        ) : null}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

/**
 * `const confirm = useConfirm()` → `if (!(await confirm({ title: "…" }))) return;`
 *
 * Throws when used outside the provider rather than silently returning true.
 * A confirmation that quietly stops confirming is the worst possible failure
 * for the destructive actions this guards - better a loud error in development
 * than a wipe that never asked.
 */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used inside <ConfirmProvider>");
  return ctx;
}
