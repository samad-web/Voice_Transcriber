import { cx } from "./cx";

/**
 * Loading placeholder.
 *
 * `aria-hidden` + `role="presentation"`: a skeleton is a picture of content that
 * does not exist yet, and announcing a row of grey boxes is worse than
 * announcing nothing. The *container* is what should carry `aria-busy` while it
 * loads — this component cannot know where that boundary is.
 *
 * `animate-pulse` is flattened by the global `prefers-reduced-motion` rule in
 * theme.css, leaving a static block. That is the correct degradation: the
 * information is "content is coming", and the shape says that without moving.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      role="presentation"
      className={cx("animate-pulse rounded-sm bg-border", className)}
    />
  );
}

/** A stack of text-line skeletons, last line short, the way a paragraph ends. */
export function SkeletonText({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <div className={cx("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cx("h-4", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}
