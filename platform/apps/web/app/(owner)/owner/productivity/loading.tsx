import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { TableBlockSkeleton } from "@/components/skeletons";

/**
 * Widths of the two link rows, in the order the page lists them (7/30/90 days;
 * Calls, Talk time, Idle gap, SOP adherence, Name). Whole literal classes, so
 * Tailwind v4 can see them.
 */
const RANGE = { label: "w-8", options: ["w-16", "w-18", "w-18"] } as const;
const SORT = { label: "w-6", options: ["w-14", "w-20", "w-18", "w-28", "w-12"] } as const;

/** A label, then its row of option links (`rounded-md px-2.5 py-1`, 28px tall). */
function OptionRow({ label, options }: { label: string; options: readonly string[] }) {
  return (
    <div className="flex items-center gap-2">
      <Skeleton className={`h-3 ${label}`} />
      {options.map((w, i) => (
        <Skeleton key={i} className={`h-7 rounded-md ${w}`} />
      ))}
    </div>
  );
}

/**
 * Mirrors productivity/page.tsx: the Range and Sort link rows, one 9-column
 * telecaller table (a name, then eight right-hand figures) and the "How to read
 * this" notes card. The optional notices (talk time not measured, no SOP
 * scoring, own numbers only) are left out: they only appear for some orgs.
 */
export default function ProductivityLoading() {
  return (
    <>
      <PageHeader title="Productivity" context="Team" />

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <OptionRow {...RANGE} />
        <OptionRow {...SORT} />
      </div>

      <TableBlockSkeleton
        columns={["primary", "num", "num", "num", "num", "num", "num", "num", "num"]}
        rows={6}
      />

      <Card className="space-y-1.5">
        <div className="flex h-4 items-center">
          <Skeleton className="h-3 w-28" />
        </div>
        <div className="space-y-1.5">
          {["w-2/3", "w-3/4", "w-1/2", "w-3/5"].map((last, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className={`h-3.5 ${last}`} />
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
