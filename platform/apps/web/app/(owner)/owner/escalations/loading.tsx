import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { TabsSkeleton } from "@/components/skeletons";

/** Row widths, so the list does not read as one block repeated. */
const ROWS = [
  { name: "w-28", reason: "w-44", note: "w-3/4" },
  { name: "w-24", reason: "w-36", note: "w-1/2" },
  { name: "w-32", reason: "w-48", note: null },
  { name: "w-20", reason: "w-40", note: "w-2/3" },
] as const;

/**
 * Mirrors escalations/page.tsx: the header (with its description, word for
 * word), the Waiting / Answered / All pills, then escalations-queue.tsx's card
 * of rows - who raised it, the reason, a status chip and the age on the first
 * line, the note, then the call and who has it.
 */
export default function EscalationsLoading() {
  return (
    <>
      <PageHeader
        title="Escalations"
        context="Conversations"
        description="Calls a telecaller handed up for help. Pick one up, answer it or pass it on - the answer goes back to their phone."
      />

      <TabsSkeleton tabs={3} variant="pill" />

      <Card className="overflow-hidden p-0">
        <div className="divide-y divide-border">
          {ROWS.map((row, i) => (
            <div key={i} className="space-y-2 px-4 py-3">
              <div className="flex items-center gap-2">
                <Skeleton className={`h-4 ${row.name}`} />
                <Skeleton className={`h-3.5 ${row.reason}`} />
                <Skeleton className="h-5 w-16 rounded-full" />
                <span className="flex-1" />
                <Skeleton className="h-3 w-12" />
              </div>
              {row.note ? <Skeleton className={`h-3.5 ${row.note}`} /> : null}
              <Skeleton className="h-3 w-72 max-w-full" />
              <Skeleton className="h-3 w-40" />
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
