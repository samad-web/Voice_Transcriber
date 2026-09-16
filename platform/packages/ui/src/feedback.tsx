"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "./button";
import { Dialog } from "./dialog";

/**
 * Telling somebody how an action went.
 *
 * ── WHY TWO MECHANISMS AND NOT ONE ────────────────────────────────────────
 *
 * A failure and a success are not the same event and must not look the same.
 *
 *  - A FAILURE is a dead end: the thing the person asked for did not happen,
 *    and they have to decide what to do instead. It gets a modal, because the
 *    one guarantee a modal buys is that the message was not missed - which is
 *    the entire bug this replaces, where a save error wrote red text below the
 *    fold and the console appeared to have done nothing.
 *  - A SUCCESS is a receipt. Nothing is required of the reader, so blocking
 *    them to collect an acknowledgement is a tax. It gets a toast that clears
 *    itself. This is not a stylistic preference: the report builder autosaves
 *    on a debounce, and a dialog per save would make the editor unusable.
 *
 * ── WHY THE PROVIDER OWNS THE TIMERS ──────────────────────────────────────
 *
 * The console previously hand-rolled auto-dismissal as `setTimeout(() =>
 * setSaved(false), 2000)` at four call sites, three of which never cleared it
 * - a state update fired at a component that had since unmounted. Centralising
 * it means one timer map, cleared on unmount, and no call site has to remember.
 */

export interface AlertOptions {
  title: string;
  /** The detail paragraph - typically the API's own message. */
  body?: ReactNode;
  dismissLabel?: string;
  /** `danger` reddens the dismiss button. Failures should pass it. */
  tone?: "default" | "danger";
}

export interface ToastOptions {
  /** Milliseconds before it clears itself. */
  duration?: number;
}

interface ToastEntry {
  id: number;
  message: string;
}

const DEFAULT_TOAST_MS = 4000;

const AlertContext = createContext<((options: AlertOptions) => Promise<void>) | null>(null);
const ToastContext = createContext<((message: string, options?: ToastOptions) => void) | null>(null);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  // ── the failure modal ────────────────────────────────────────────────────
  const [alertOptions, setAlertOptions] = useState<AlertOptions | null>(null);
  const resolverRef = useRef<(() => void) | null>(null);

  /** Settle whatever is pending exactly once, then clear it. */
  const settle = useCallback(() => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setAlertOptions(null);
    resolve?.();
  }, []);

  // An unmount with a dialog open (a route change) would otherwise leave the
  // caller awaiting a promise nobody settles, hanging its `finally`. Same
  // reasoning as ConfirmProvider's, which resolves `false` there; an alert has
  // no answer to give, so it simply completes.
  useEffect(() => () => resolverRef.current?.(), []);

  const alert = useCallback(
    (next: AlertOptions) =>
      new Promise<void>((resolve) => {
        // Two failures in flight (a bulk action reporting twice) must not
        // strand the first promise. The earlier one completes and is replaced.
        resolverRef.current?.();
        resolverRef.current = resolve;
        setAlertOptions(next);
      }),
    [],
  );

  // ── the success toasts ───────────────────────────────────────────────────
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((list) => list.filter((toast) => toast.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, options?: ToastOptions) => {
      const id = nextId.current++;
      setToasts((list) => [...list, { id, message }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), options?.duration ?? DEFAULT_TOAST_MS),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    };
  }, []);

  const danger = alertOptions?.tone === "danger";

  return (
    <AlertContext.Provider value={alert}>
      <ToastContext.Provider value={toast}>
        {children}

        <Dialog
          open={alertOptions !== null}
          onClose={settle}
          title={alertOptions?.title ?? ""}
          footer={
            <Button variant={danger ? "danger" : "primary"} onClick={settle}>
              {alertOptions?.dismissLabel ?? "OK"}
            </Button>
          }
        >
          {alertOptions?.body ? (
            // whitespace-pre-line so a multi-line API message keeps its breaks.
            <p className="whitespace-pre-line text-sm text-text-muted">{alertOptions.body}</p>
          ) : null}
        </Dialog>

        {/* The live region is always mounted, empty or not: a screen reader
            only announces insertions into a region that already existed, so
            creating this div at the same moment as the message would announce
            nothing at all. Polite, never assertive - a success has no business
            interrupting whatever is being read, and failures are announced by
            the dialog above instead. */}
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed right-0 bottom-0 z-50 flex w-full flex-col items-end gap-2 p-4 sm:w-auto"
        >
          {toasts.map((entry) => (
            <div
              key={entry.id}
              className="pointer-events-auto flex max-w-sm items-start gap-3 rounded-lg border border-border bg-surface px-4 py-3 shadow-lg"
            >
              <span className="text-sm text-text">{entry.message}</span>
              <button
                type="button"
                onClick={() => dismiss(entry.id)}
                aria-label="Dismiss"
                className="-mr-1 shrink-0 cursor-pointer rounded-sm p-0.5 text-text-muted transition-colors duration-150 ease-out hover:bg-surface-hover hover:text-text"
              >
                <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          ))}
        </div>
      </ToastContext.Provider>
    </AlertContext.Provider>
  );
}

/**
 * `const alert = useAlert()` → `await alert({ title: "Couldn't save", body: res.error })`.
 *
 * Promise-shaped like `useConfirm` for the same reason its docblock gives: a
 * call site converts by one line, with no "which message is showing" state
 * hoisted into a component that has no other use for it.
 */
export function useAlert(): (options: AlertOptions) => Promise<void> {
  const ctx = useContext(AlertContext);
  if (!ctx) throw new Error("useAlert must be used inside <FeedbackProvider>");
  return ctx;
}

/** `const toast = useToast()` → `toast("Saved")`. */
export function useToast(): (message: string, options?: ToastOptions) => void {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <FeedbackProvider>");
  return ctx;
}
