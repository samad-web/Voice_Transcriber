"use client";

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "./button";
import { Dialog } from "./dialog";
import { Input } from "./input";

/**
 * The word a destructive confirmation asks for by default.
 *
 * ONE word for every destructive action in both consoles, rather than each
 * dialog asking for the name of the thing it is about to destroy. Retyping a
 * name is the more common pattern and it is worse here: an operator's muscle
 * memory learns "copy the name from the heading above and paste it", which is
 * a reflex that can be performed without reading anything. "DELETE" cannot be
 * copied from anywhere on the page, has to be typed in caps on purpose, and
 * means the same thing on every dialog - so the habit it builds is "I am about
 * to destroy something", which is the habit worth building.
 */
export const CONFIRM_WORD = "DELETE";

export interface ConfirmOptions {
  title: string;
  /** The detail paragraph. Where a `window.confirm` used "\n\n", this is the half after it. */
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * `danger` styles the confirming button red, stops a stray backdrop click
   * from dismissing - for irreversible actions the accidental outcome should be
   * "nothing happened", and a click landing outside the dialog is the most
   * common accident there is - and, unless `requireTyped` says otherwise,
   * makes the person type CONFIRM_WORD before the button will fire.
   */
  tone?: "default" | "danger";
  /**
   * The type-to-confirm gate.
   *
   * DEFAULTS TO `CONFIRM_WORD` FOR EVERY `tone: "danger"` DIALOG, which is the
   * whole design: the gate is on unless a call site deliberately turns it off,
   * so a new destructive action gets it by forgetting rather than by
   * remembering. Pass `false` to opt out, or a different string to ask for a
   * different word.
   *
   * Opting out is for destructive-but-recoverable actions where the friction
   * would train people to type DELETE without reading it - archiving a record
   * that can be unarchived, dismissing a flag. If the data is gone afterwards,
   * it keeps the gate.
   */
  requireTyped?: string | false;
}

/** What a given dialog actually demands - the defaulting rule in one place. */
export function typedWordFor(options: ConfirmOptions | null): string | null {
  if (!options) return null;
  if (options.requireTyped === false) return null;
  if (typeof options.requireTyped === "string") return options.requireTyped;
  return options.tone === "danger" ? CONFIRM_WORD : null;
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
  const [typed, setTyped] = useState("");
  const resolverRef = useRef<Resolver | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fieldId = useId();

  /** Settle whatever is pending exactly once, then clear it. */
  const settle = useCallback((ok: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setOptions(null);
    // Cleared on settle, not on open: a dialog that reopened still holding the
    // last "DELETE" would let a double-press destroy a second thing with no
    // gate at all, which is precisely the accident this exists to stop.
    setTyped("");
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
        setTyped("");
        setOptions(next);
      }),
    [],
  );

  const danger = options?.tone === "danger";
  const word = typedWordFor(options);
  // Case-sensitive, whitespace-trimmed. Trimmed because a trailing space from a
  // paste or a phone keyboard is not a different intent; case-sensitive because
  // holding shift for six characters is the deliberate act being asked for, and
  // accepting "delete" would let the whole gate be satisfied by a reflex.
  const unlocked = word === null || typed.trim() === word;

  // Focus the gate, not the button. The person has to type something before the
  // dialog can do anything, so landing the caret where the typing goes saves a
  // Tab and - more to the point - makes it obvious at a glance that this dialog
  // is asking for something rather than offering a button to press.
  useEffect(() => {
    if (word === null) return;
    // One frame after <dialog>.showModal(), which moves focus itself.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [word, options]);

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
            <Button
              variant={danger ? "danger" : "primary"}
              disabled={!unlocked}
              onClick={() => settle(true)}
            >
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

        {word !== null ? (
          <div className="mt-4 space-y-1.5">
            <label htmlFor={fieldId} className="block text-sm text-text">
              Type{" "}
              {/* Not selectable: `user-select: none` means a double-click or a
                  drag cannot lift the word off the page and drop it into the
                  field below, which would turn a deliberate act back into a
                  reflex. Typing it is the point. */}
              <span className="font-mono font-semibold text-text select-none">{word}</span> to
              confirm
            </label>
            <Input
              id={fieldId}
              ref={inputRef}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                // Enter submits once the gate is open, matching what the button
                // would do - but never before, or holding Enter from the last
                // field would sail straight through it.
                if (e.key === "Enter" && unlocked) {
                  e.preventDefault();
                  settle(true);
                }
              }}
              placeholder={word}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-describedby={`${fieldId}-hint`}
            />
            <p id={`${fieldId}-hint`} className="text-xs text-text-muted">
              {unlocked
                ? "Confirmed - the button below is now active."
                : `This cannot be undone. The button stays disabled until the box reads exactly ${word}.`}
            </p>
          </div>
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
