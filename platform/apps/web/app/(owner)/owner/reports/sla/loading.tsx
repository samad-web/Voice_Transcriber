import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { TableBlockSkeleton, type Col } from "@/components/skeletons";

/** Label and hint lengths for the KPI cards, cycled so a row does not read as one card copied. */
const STAT_LABEL_W = ["w-36", "w-32", "w-28", "w-40", "w-24"] as const;
const STAT_HINT_W = ["w-40", "w-28", "w-36", "w-24", "w-32"] as const;

/** A section heading as the page draws it: `mt-2`, an `h2` line, then a one-line note. */
function SectionHeading({ noteW }: { noteW: string }) {
  return (
    <div className="mt-2">
      <div className="flex h-7 items-center">
        <Skeleton className="h-5 w-52" />
      </div>
      <div className="mt-0.5 flex h-4 items-center">
        <Skeleton className={`h-2.5 ${noteW}`} />
      </div>
    </div>
  );
}

/**
 * The page's own `Stat`: a plain card with a label, a 2xl figure and a hint. It
 * is not the dashboard's solid StatCard, and its grid is tighter (`gap-3`, four
 * across only from `xl`), so the shared StatGridSkeleton would not land on it.
 * `grid` is a complete literal class string from the call site.
 */
function StatCards({ count, grid }: { count: number; grid: string }) {
  return (
    <div className={`grid gap-3 ${grid}`}>
      {Array.from({ length: count }, (_, i) => (
        <Card key={i}>
          <div className="flex h-4 items-center">
            <Skeleton className={`h-3 ${STAT_LABEL_W[i % STAT_LABEL_W.length]}`} />
          </div>
          <div className="mt-1 flex h-8 items-center">
            <Skeleton className="h-6 w-16" />
          </div>
          <div className="mt-1 flex h-4 items-center">
            <Skeleton className={`h-2.5 ${STAT_HINT_W[i % STAT_HINT_W.length]}`} />
          </div>
        </Card>
      ))}
    </div>
  );
}

/** A card of the page's shape: a label, up to two lines of hint, then a table. */
function ReportCard({
  labelW,
  hint = 0,
  columns,
  rows = 4,
}: {
  labelW: string;
  hint?: 0 | 1 | 2;
  columns: Col[];
  rows?: number;
}) {
  return (
    <Card>
      <div className="flex h-4 items-center">
        <Skeleton className={`h-3 ${labelW}`} />
      </div>
      {hint > 0 ? (
        <div className="mt-1">
          {Array.from({ length: hint }, (_, i) => (
            <div key={i} className="flex h-4 items-center">
              <Skeleton
                className={i === hint - 1 && hint > 1 ? "h-2.5 w-2/3" : "h-2.5 w-full max-w-2xl"}
              />
            </div>
          ))}
        </div>
      ) : null}
      <div className="mt-3">
        <TableBlockSkeleton columns={columns} rows={rows} />
      </div>
    </Card>
  );
}

/**
 * Mirrors reports/sla/page.tsx: three stacked sections under one header.
 * Lead response time (4 KPI cards, the speed-bands table, by-telecaller, and
 * the leads waiting for a first response), Follow-up compliance (4 KPI cards,
 * by-assignee, overdue now) and Lead aging (5 age-bucket cards, the oldest open
 * leads with an answered chip). Every section ends in a list of the records
 * behind its worst number, so each is drawn as a card holding a table.
 */
export default function SlaReportsLoading() {
  return (
    <>
      <PageHeader title="Response & Follow-ups" context="Pipeline" />

      <SectionHeading noteW="w-80" />
      <StatCards count={4} grid="sm:grid-cols-2 xl:grid-cols-4" />
      <ReportCard labelW="w-32" columns={["text", "num", "num"]} rows={5} />
      <ReportCard labelW="w-28" hint={2} columns={["primary", "num", "num", "num", "num", "num"]} />
      <ReportCard labelW="w-44" hint={2} columns={["primary", "text", "text", "num"]} />

      <SectionHeading noteW="w-64" />
      <StatCards count={4} grid="sm:grid-cols-2 xl:grid-cols-4" />
      <ReportCard labelW="w-24" hint={1} columns={["primary", "num", "num", "num", "num"]} />
      <ReportCard labelW="w-24" columns={["primary", "text", "date", "num", "num"]} />

      <SectionHeading noteW="w-72" />
      <StatCards count={5} grid="sm:grid-cols-3 xl:grid-cols-5" />
      <ReportCard labelW="w-36" hint={1} columns={["primary", "text", "text", "num", "chip"]} />
    </>
  );
}
