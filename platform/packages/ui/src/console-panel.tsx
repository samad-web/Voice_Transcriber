import type { ReactNode } from "react";
import { cx } from "./cx";

const TONES = {
  log: "text-terminal-log",
  danger: "text-terminal-danger",
  neutral: "text-terminal-text",
} as const;

/**
 * Terminal-style panel for raw JSON, pipeline logs and destructive-op output.
 *
 * It stays dark in BOTH modes on purpose. The terminal look is the affordance -
 * it tells the operator "this is machine output, not prose", and inverting it in
 * light mode would lose that. What changes from v1 is that it is now built from
 * its own named tokens (`--color-terminal*`) instead of `bg-black` + `text-green-400`,
 * so in light mode it reads as a deliberate inverted surface rather than as an
 * un-migrated leftover, and in dark mode it sits one step *lighter* than the
 * page instead of disappearing into it.
 *
 * `role="log"` + `aria-live="polite"`: these panels stream (erasure runs, key
 * generation), and a sighted operator watching lines appear should not be the
 * only one who finds out what happened.
 */
export function ConsolePanel({
  lines,
  tone = "log",
  header,
  className = "",
}: {
  lines: string[];
  tone?: keyof typeof TONES;
  header?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="log"
      aria-live="polite"
      className={cx(
        "space-y-1.5 overflow-y-auto rounded-md border border-terminal-border bg-terminal p-4 font-mono text-xs tabular-nums",
        TONES[tone],
        className,
      )}
    >
      {header ? (
        <span className="mb-2 block text-xs font-medium text-terminal-muted">{header}</span>
      ) : null}
      {lines.map((line, i) => (
        <div key={i} className="leading-relaxed break-words whitespace-pre-wrap">
          {line}
        </div>
      ))}
    </div>
  );
}
