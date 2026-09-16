import type { ReactNode } from "react";

/**
 * What every review card is handed, whatever its source. A card owns its own
 * busy state and its own action; the queue only learns the outcome, so a new
 * source is one new card and one line in the queue's switch.
 */
export interface ReviewCardProps<T> {
  item: T;
  /** "12 min" - computed by the server so the first paint and hydration agree. */
  waiting: string;
  /** The item is decided (by this person or, just before, by somebody else). */
  onResolved: (id: string, message: string) => void;
  onFailed: (title: string, detail: string) => void;
}

/** The shared chrome: source, how long it has waited, a title line and actions. */
export function ReviewCardFrame({
  sourceLabel,
  waiting,
  title,
  meta,
  children,
}: {
  sourceLabel: string;
  waiting: string;
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <article className="rounded-lg border border-border bg-surface p-4">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-xs font-semibold tracking-wider text-text-muted uppercase">{sourceLabel}</span>
        <span className="text-xs text-text-muted">waiting {waiting}</span>
      </header>
      <h3 className="mt-1 text-base font-semibold break-words text-text">{title}</h3>
      {meta ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">{meta}</div>
      ) : null}
      <div className="mt-3">{children}</div>
    </article>
  );
}
