import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * The small caption above a value: field names, stat labels, section eyebrows.
 *
 * v2 drops the uppercase + 0.2em tracking. That convention goes with the
 * brutalist system: it hurts scanning at 10px and is actively hostile to Tamil,
 * Hindi and Telugu, which have no case distinction — so uppercasing does nothing
 * but break the shaping the reader relies on. This is a product whose headline
 * claim is native support for those scripts.
 *
 * `tabular-nums` stays, because the same component labels ids and counts and
 * those should not jitter between renders.
 */
export function MonoLabel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <p className={cx("text-xs text-text-muted tabular-nums", className)}>{children}</p>;
}
