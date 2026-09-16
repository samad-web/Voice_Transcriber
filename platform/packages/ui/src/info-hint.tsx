"use client";

import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";
import { cx } from "./cx";
import { Tooltip } from "./tooltip";

interface InfoHintsContextValue {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
}

const InfoHintsContext = createContext<InfoHintsContextValue | null>(null);

/**
 * One switch, read by every `<InfoHint>` in the tree, so a person's "explain
 * things to me" preference does not have to be threaded through every page
 * that uses one. Mirrors `ConfirmProvider`/`ThemeProvider`: mounted once, near
 * the root.
 *
 * `initialEnabled`/`onChange` rather than owning persistence itself - this
 * package has no server, no cookie jar, nothing but React. The consuming app
 * reads whatever it wants to seed the first render with, and is told about
 * every flip so it can save it (see apps/web/components/info-hints-provider.tsx).
 */
export function InfoHintsProvider({
  initialEnabled = true,
  onChange,
  children,
}: {
  initialEnabled?: boolean;
  onChange?: (next: boolean) => void;
  children: ReactNode;
}) {
  const [enabled, setEnabledState] = useState(initialEnabled);

  const setEnabled = (next: boolean) => {
    setEnabledState(next);
    onChange?.(next);
  };

  return <InfoHintsContext.Provider value={{ enabled, setEnabled }}>{children}</InfoHintsContext.Provider>;
}

/**
 * Throws outside the provider rather than defaulting to "on" - the same
 * failure mode `useConfirm`/`useTheme` chose, and for the same reason: a
 * preference that quietly stops being honoured is worse than a loud error
 * that gets the provider mounted.
 */
export function useInfoHints(): InfoHintsContextValue {
  const ctx = useContext(InfoHintsContext);
  if (!ctx) throw new Error("useInfoHints must be used inside <InfoHintsProvider>");
  return ctx;
}

export interface InfoHintProps {
  /** What the icon explains. Kept short - this is a hint, not the documentation. */
  content: ReactNode;
  /**
   * The thing being explained, e.g. "Lead assigned" - gives the icon-only
   * trigger an accessible name (`aria-describedby` supplements it, per
   * Tooltip's contract; it does not replace it).
   */
  label: string;
  side?: "top" | "bottom";
  className?: string;
}

/**
 * An inline (i) next to a label, for the explanation that is nice to have but
 * is not the thing a person needs in order to act - see `RowHint`'s doc
 * comment for the sibling case (a row that asks someone to DO something, or
 * is reporting it is MID-SOMETHING) where the text belongs on the row itself,
 * always visible, not behind a hover.
 *
 * Renders nothing when the person has turned hints off (`useInfoHints`), and
 * nothing at all outside a provider that has turned hints off - the surrounding
 * label and its own always-visible copy are expected to stand on their own
 * either way.
 */
export function InfoHint({ content, label, side, className = "" }: InfoHintProps) {
  const { enabled } = useInfoHints();
  if (!enabled) return null;

  return (
    <Tooltip content={content} side={side} className={className}>
      <button
        type="button"
        aria-label={`More about ${label}`}
        className="cursor-default rounded-full text-text-subtle transition-colors duration-150 ease-out hover:text-text"
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" className={cx("h-3.5 w-3.5")}>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 7.35v4.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="8" cy="4.85" r="0.9" fill="currentColor" />
        </svg>
      </button>
    </Tooltip>
  );
}
