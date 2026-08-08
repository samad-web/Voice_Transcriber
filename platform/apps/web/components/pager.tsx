import Link from "next/link";

/** Rows per page in the call explorers. Large enough that most tenants never
 *  page at all, small enough to stay a quick render. */
export const PAGE_SIZE = 100;

/**
 * Page controls for a server-rendered table.
 *
 * The explorers used to take a bare `LIMIT` with no total and no way forward,
 * so a tenant past the cap simply stopped having older calls as far as the
 * console was concerned — silently, which is the worst way for data to go
 * missing. Showing the range against the true total makes truncation visible
 * even on the first page.
 */
export function Pager({
  total,
  page,
  hrefFor,
  pageSize = PAGE_SIZE,
}: {
  total: number;
  page: number;
  /** Builds the URL for a page, preserving whatever filters the page carries. */
  hrefFor: (page: number) => string;
  pageSize?: number;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  const first = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const last = Math.min(current * pageSize, total);

  if (total <= pageSize) {
    return (
      <p className="text-xs text-text-muted tabular-nums">
        {total} call{total === 1 ? "" : "s"}
      </p>
    );
  }

  // Matches <Button variant="secondary" size="sm"> geometry. These are real
  // links (deep-linkable pages), so they cannot be the Button primitive, but a
  // pager that does not line up with the buttons beside it reads as a bug.
  const stepBase =
    "inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium transition-colors duration-150 ease-out";

  const step = (label: string, to: number, enabled: boolean) =>
    enabled ? (
      <Link
        href={hrefFor(to)}
        className={`${stepBase} border-border-strong bg-surface text-text hover:bg-surface-hover hover:border-text-subtle`}
      >
        {label}
      </Link>
    ) : (
      // aria-disabled rather than a bare <span>: the control still occupies its
      // place in the row, and its unavailability is announced rather than only
      // shown as a paler grey.
      <span aria-disabled="true" className={`${stepBase} border-border text-text-subtle`}>
        {label}
      </span>
    );

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-text-muted tabular-nums">
        {first}–{last} of {total} · page {current}/{pages}
      </p>
      <div className="flex items-center gap-2">
        {step("← Newer", current - 1, current > 1)}
        {step("Older →", current + 1, current < pages)}
      </div>
    </div>
  );
}
