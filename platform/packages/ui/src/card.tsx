import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * The standard surface: a 1px hairline and 24px of padding.
 *
 * `shadow` now means "raised" (`--shadow-md`) rather than the old offset hard
 * shadow; the prop is kept so no call site changes. In dark mode shadows barely
 * register, which is by design — hierarchy there comes from `--color-surface`
 * sitting one step lighter than `--color-bg`, not from elevation.
 */
export function Card({
  children,
  shadow = false,
  className = "",
}: {
  children: ReactNode;
  shadow?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "rounded-md border border-border bg-surface p-6",
        shadow ? "shadow-md" : "shadow-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}
