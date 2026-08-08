import { cx } from "./cx";

/**
 * Usage/quota meter.
 *
 * `role="progressbar"` + the value attributes are new (the DOM changed; the
 * props did not). Without them the bar was pure decoration and a screen-reader
 * user got no number at all, because the percentage exists only as a width.
 * There is intentionally no `aria-label` prop — adding props is out of scope for
 * this pass, and every current call site already renders a `MonoLabel` next to
 * the bar saying what it measures.
 */
export function ProgressBar({
  percent,
  tone = "solid",
  className = "",
}: {
  percent: number;
  tone?: "solid" | "danger";
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  // Track is --color-border, not --color-surface-hover: on a white card the
  // hover surface (#F5F5F5) is a 1.05:1 track and the empty portion of the meter
  // simply vanishes. The border token gives the fill something to read against in
  // both modes.
  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cx("h-2 w-full overflow-hidden rounded-full bg-border", className)}
    >
      <div
        className={cx(
          "h-full rounded-full transition-[width] duration-200 ease-out",
          tone === "danger" ? "bg-danger" : "bg-accent",
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
