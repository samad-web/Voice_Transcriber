import { Card, Skeleton } from "@aura/ui";

/**
 * Same markup as `PageHeader`, for the handful of routes whose title is only
 * known after the fetch (an account/contact's name, a dashboard's org name) —
 * a real `<PageHeader>` can't be used since there's no text to give it yet.
 * Keeping the wash/eyebrow classes identical means the swap-in is a text
 * change, not a layout jump.
 */
export function PageHeaderSkeleton({ context }: { context: string }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-bg-subtle px-5 py-5 sm:px-7 sm:py-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{ backgroundImage: "var(--brand-gradient)" }}
      />
      <div className="relative min-w-0">
        <p
          className="bg-clip-text text-xs font-semibold tracking-wider text-transparent uppercase"
          style={{ backgroundImage: "var(--brand-gradient)" }}
        >
          {context}
        </p>
        <Skeleton className="mt-2 h-8 w-48 sm:h-9" />
      </div>
    </div>
  );
}

/**
 * Per-screen loading shapes.
 *
 * Before this, every route under (owner) fell through to one generic
 * stat-cards-plus-list skeleton (app/(owner)/loading.tsx) regardless of
 * whether the real page was a table, a kanban board, a two-pane inbox or a
 * detail view — so the loading state never matched what actually rendered a
 * moment later. Each piece here mirrors one real page shape (see the
 * `page.tsx` it's paired with); route-level `loading.tsx` files compose them.
 */

/** A row of N stat cards — the dashboard's top row, and reports' summary row. */
export function StatGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} className="space-y-4">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-3 w-28" />
        </Card>
      ))}
    </div>
  );
}

/** A bare `<Table>`-shaped block: header cells, then N body rows. */
export function TableBlockSkeleton({ columns = 4, rows = 6 }: { columns?: number; rows?: number }) {
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex gap-6 border-b border-border bg-bg-subtle px-4 py-3">
        {Array.from({ length: columns }, (_, i) => (
          <Skeleton key={i} className="h-3 w-16" />
        ))}
      </div>
      <div className="divide-y divide-border">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-6 px-4 py-3.5">
            {Array.from({ length: columns }, (_, j) => (
              <Skeleton key={j} className={j === 0 ? "h-3.5 w-28" : "h-3.5 w-14"} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Search-box-then-table pages: accounts, contacts, products. */
export function SearchTableSkeleton({ columns = 4 }: { columns?: number }) {
  return (
    <>
      <Skeleton className="h-9 w-full max-w-sm rounded-md" />
      <TableBlockSkeleton columns={columns} />
    </>
  );
}

/** Status-pill-filter-then-table pages: invoices, quotations. */
export function FilterTableSkeleton({
  pills = 5,
  columns = 4,
  withAction = false,
}: {
  pills?: number;
  columns?: number;
  withAction?: boolean;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: pills }, (_, i) => (
            <Skeleton key={i} className="h-8 w-16 rounded-md" />
          ))}
        </div>
        {withAction ? <Skeleton className="h-8 w-32 rounded-full" /> : null}
      </div>
      <TableBlockSkeleton columns={columns} />
    </>
  );
}

/** The lead/deal pipeline boards — N columns of stacked drag-cards. */
export function KanbanSkeleton({ columns = 5 }: { columns?: number }) {
  return (
    <div className="flex gap-4 overflow-x-auto pb-2">
      {Array.from({ length: columns }, (_, col) => (
        <div key={col} className="w-72 shrink-0 space-y-3">
          <div className="flex items-center justify-between px-1">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-3.5 w-8" />
          </div>
          <div className="space-y-2.5">
            {Array.from({ length: col === 0 ? 3 : 2 }, (_, card) => (
              <Card key={card} className="space-y-2.5 p-3.5">
                <Skeleton className="h-3.5 w-4/5" />
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </Card>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A `dl`-style details card: label/value pairs stacked. */
export function DetailListCardSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <Card className="space-y-3">
      <Skeleton className="h-3 w-16" />
      <div className="space-y-2.5">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="space-y-1">
            <Skeleton className="h-2.5 w-14" />
            <Skeleton className="h-3.5 w-24" />
          </div>
        ))}
      </div>
    </Card>
  );
}

/** A generic content card — a label plus a few lines, for timelines/tasklists/composers. */
export function ContentCardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <Card className="space-y-3">
      <Skeleton className="h-3 w-24" />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </Card>
  );
}

/**
 * The record-detail layout used by accounts/[id] and contacts/[id]: a back
 * link, then a wide main column of activity cards beside a narrow side column
 * of detail/related cards.
 */
export function RecordDetailSkeleton() {
  return (
    <>
      <Skeleton className="h-3 w-24" />
      <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          <ContentCardSkeleton lines={2} />
          <ContentCardSkeleton lines={3} />
          <ContentCardSkeleton lines={4} />
        </div>
        <div className="space-y-4">
          <DetailListCardSkeleton rows={4} />
          <ContentCardSkeleton lines={2} />
          <ContentCardSkeleton lines={2} />
        </div>
      </div>
    </>
  );
}

/**
 * The quotation/invoice detail layout: a back link, a header strip (status +
 * a couple of fields), the line-item table, and a totals/payment block.
 */
export function DocumentDetailSkeleton() {
  return (
    <>
      <Skeleton className="h-3 w-24" />
      <Card className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <Skeleton className="h-6 w-20 rounded-full" />
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3.5 w-28" />
        </div>
        <TableBlockSkeleton columns={5} rows={3} />
        <div className="flex justify-end">
          <div className="w-56 space-y-2">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-4 w-full" />
          </div>
        </div>
      </Card>
    </>
  );
}

/** A settings/connect form: intro copy already renders from the shell, this is the card(s) below it. */
export function FormCardSkeleton({ fields = 3 }: { fields?: number }) {
  return (
    <Card className="max-w-2xl space-y-4">
      {Array.from({ length: fields }, (_, i) => (
        <div key={i} className="space-y-1.5">
          <Skeleton className="h-2.5 w-24" />
          <Skeleton className="h-9 w-full rounded-md" />
        </div>
      ))}
      <Skeleton className="h-9 w-28 rounded-full" />
    </Card>
  );
}

/**
 * A stat card plus a list card — outreach (stacked, stat card on top) and
 * tasks (side-by-side grid, list on the left) order these differently, so
 * `statFirst` picks the DOM order to match whichever page is rendering.
 */
export function StatPlusListSkeleton({
  side = false,
  statFirst = false,
}: {
  side?: boolean;
  statFirst?: boolean;
}) {
  const stat = (
    <Card key="stat" className="space-y-2">
      <Skeleton className="h-3 w-16" />
      <Skeleton className="h-8 w-12" />
      <Skeleton className="h-3 w-36" />
    </Card>
  );
  const list = <ContentCardSkeleton key="list" lines={5} />;

  return (
    <div className={side ? "grid gap-6 xl:grid-cols-[1fr_18rem]" : "space-y-4"}>
      {statFirst ? [stat, list] : [list, stat]}
    </div>
  );
}

/** The inbox: a thread list pane beside a conversation pane. */
export function TwoPaneSkeleton() {
  return (
    <Card className="overflow-hidden p-0">
      <div className="grid md:grid-cols-[20rem_1fr]">
        <div className="space-y-0 divide-y divide-border border-b border-border md:border-b-0 md:border-r">
          <div className="flex gap-1.5 p-3">
            <Skeleton className="h-7 w-16 rounded-full" />
            <Skeleton className="h-7 w-20 rounded-full" />
            <Skeleton className="h-7 w-16 rounded-full" />
          </div>
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="space-y-1.5 p-3">
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="h-3 w-full" />
            </div>
          ))}
        </div>
        <div className="hidden flex-col gap-3 p-4 md:flex">
          <Skeleton className="h-3.5 w-1/3" />
          <Skeleton className="h-16 w-3/4 rounded-lg" />
          <Skeleton className="ml-auto h-12 w-2/3 rounded-lg" />
          <Skeleton className="h-16 w-3/4 rounded-lg" />
        </div>
      </div>
    </Card>
  );
}

/** The bulk-import wizard's opening step: three pickable entity cards. */
export function EntityPickerSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {Array.from({ length: 3 }, (_, i) => (
        <Card key={i} className="space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
        </Card>
      ))}
    </div>
  );
}

/** The duplicates queue: a scan action row, then a few match cards. */
export function MatchListSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Skeleton className="h-9 w-40 rounded-full" />
        <Skeleton className="h-9 w-40 rounded-full" />
      </div>
      {Array.from({ length: 3 }, (_, i) => (
        <Card key={i} className="space-y-3">
          <Skeleton className="h-3.5 w-1/3" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        </Card>
      ))}
    </div>
  );
}
