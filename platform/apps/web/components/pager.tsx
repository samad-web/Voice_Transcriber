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
      <p className="text-[10px] font-mono font-bold uppercase tracking-wider text-neutral-400">
        {total} call{total === 1 ? "" : "s"}
      </p>
    );
  }

  const step = (label: string, to: number, enabled: boolean) =>
    enabled ? (
      <Link
        href={hrefFor(to)}
        className="px-3 py-1.5 border-2 border-black bg-white text-black hover:bg-neutral-100 text-[10px] font-mono font-bold uppercase tracking-wider"
      >
        {label}
      </Link>
    ) : (
      <span className="px-3 py-1.5 border-2 border-neutral-200 text-neutral-300 text-[10px] font-mono font-bold uppercase tracking-wider">
        {label}
      </span>
    );

  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <p className="text-[10px] font-mono font-bold uppercase tracking-wider text-neutral-500">
        {first}–{last} of {total} · page {current}/{pages}
      </p>
      <div className="flex items-center gap-2">
        {step("← Newer", current - 1, current > 1)}
        {step("Older →", current + 1, current < pages)}
      </div>
    </div>
  );
}
