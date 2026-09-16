"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * A monospace identifier with a one-click copy.
 *
 * Org ids and instance ids on this page exist to be pasted somewhere else - an
 * API call, a psql `where org_id =`, a support thread. They were plain text
 * before, so getting one meant a careful triple-click on a 36-character UUID
 * that wraps mid-string.
 *
 * The whole chip is the button, not a separate icon beside the text: a 12px
 * icon is a poor target, and the text is the thing an operator aims at anyway.
 */
export function CopyValue({
  value,
  label,
  className = "",
}: {
  value: string;
  /** What is being copied, for the accessible name ("Copy org ID"). */
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Clear on unmount: this sits in a tab panel that can be hidden (and in
  // React 18 strict mode, mounted twice) while the timeout is still pending.
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      // Sync, not `async` - see owner-accounts.tsx: React discards a handler's
      // return value, so an async onClick turns a rejected clipboard write
      // (insecure origin, denied permission) into an unhandled rejection.
      onClick={() => {
        void navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1600);
          })
          .catch(() => setCopied(false));
      }}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      // Deliberately sets no text colour: two colour utilities of equal
      // specificity are resolved by stylesheet order, not by the order they
      // appear in this string, so a caller passing `text-text-muted` could not
      // reliably override a `text-text` baked in here. The caller owns the
      // colour; this owns the shape.
      className={
        "group inline-flex max-w-full items-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 font-mono text-xs transition-colors duration-150 ease-out hover:border-border hover:bg-surface-hover " +
        className
      }
    >
      <span className="truncate">{value}</span>
      {copied ? (
        <Check aria-hidden="true" className="h-3 w-3 shrink-0 text-accent-text" />
      ) : (
        <Copy
          aria-hidden="true"
          className="h-3 w-3 shrink-0 text-text-subtle transition-opacity duration-150 group-hover:text-text-muted"
        />
      )}
      {/* Announced on copy - the icon swap is silent to a screen reader, and
          aria-label changes on a focused button are not reliably re-read. */}
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}
