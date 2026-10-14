import { ORG_MODULES } from "@aura/shared";
import { Card, MonoLabel, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** A `StatCard`'s shape: the label line, the big value, the context line. */
function TileSkeleton() {
  return (
    <Card className="space-y-2">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-7 w-12" />
      <Skeleton className="h-3 w-32" />
    </Card>
  );
}

/**
 * Mirrors (platform)/adoption/page.tsx: four tiles, the tenant × module grid,
 * then the two explanatory cards.
 *
 * The header is REAL, and repeated verbatim rather than skeletoned:
 * `console-loading.test.ts` compares a loader's `PageHeader` with its page's in
 * full, so a loader that drops the eyebrow or the description makes the heading
 * jump when the real page arrives. The window is hard-coded here because the
 * loader has no data to read it from - and 30 is `ADOPTION_WINDOW_DAYS`, which
 * the page's own test pins, so the two cannot drift silently.
 *
 * The column count comes from `ORG_MODULES` rather than a literal, so adding a
 * seventh module widens the skeleton and the table together.
 */
export default function AdoptionLoading() {
  const columns = ORG_MODULES.length;
  // Fixed widths picked by index, never random: a server and a client that
  // disagree about a skeleton's width is a hydration mismatch.
  const nameWidths = ["w-36", "w-44", "w-32", "w-40"] as const;

  return (
    <>
      <PageHeader
        title="Module adoption"
        context="Platform"
        description="What was switched on, against what has been used in the last 30 days."
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <TileSkeleton />
        <TileSkeleton />
        <TileSkeleton />
        <TileSkeleton />
      </div>

      <Card className="mt-4 overflow-x-auto">
        <div className="min-w-[640px]">
          {/* Header row: the Client column, then one per module. */}
          <div
            className="grid gap-4 border-b border-border px-2 py-2"
            style={{ gridTemplateColumns: `minmax(0,1.4fr) repeat(${columns}, minmax(0,1fr))` }}
          >
            <Skeleton className="h-2.5 w-14" />
            {Array.from({ length: columns }, (_, i) => (
              <Skeleton key={i} className="h-2.5 w-16" />
            ))}
          </div>
          {/* Four tenants - the production estate's own size, so the skeleton
              is the length of the thing it stands in for rather than a guess. */}
          {Array.from({ length: 4 }, (_, r) => (
            <div
              key={r}
              className="grid items-start gap-4 border-b border-border px-2 py-2.5 last:border-0"
              style={{ gridTemplateColumns: `minmax(0,1.4fr) repeat(${columns}, minmax(0,1fr))` }}
            >
              <Skeleton className={`h-3.5 ${nameWidths[r % nameWidths.length]}`} />
              {Array.from({ length: columns }, (_, c) => (
                <div key={c} className="space-y-1.5">
                  <Skeleton className="h-6 w-20 rounded-full" />
                  {/* Not every cell carries a date - a module nobody has used
                      shows only the chip, so every other one is left blank. */}
                  {(r + c) % 2 === 0 ? <Skeleton className="h-2.5 w-24" /> : null}
                </div>
              ))}
            </div>
          ))}
        </div>
      </Card>

      {/* "What counts as used": one definition per module. */}
      <Card className="mt-4">
        <MonoLabel>What counts as used</MonoLabel>
        <div className="mt-2 space-y-2">
          {Array.from({ length: columns }, (_, i) => (
            <div key={i} className="space-y-1">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-2.5 w-64" />
            </div>
          ))}
        </div>
      </Card>

      <Card className="mt-4">
        <MonoLabel>Why this screen</MonoLabel>
        <div className="mt-2 space-y-1.5">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </Card>
    </>
  );
}
