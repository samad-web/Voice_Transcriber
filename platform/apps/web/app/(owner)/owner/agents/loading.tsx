import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** Complete class strings, picked by index, so the cards do not read as one repeated bar. */
const NAME_BAR = ["h-4 w-40", "h-4 w-32", "h-4 w-44", "h-4 w-36"] as const;
const CHIP_BAR = [
  "h-6 w-24 rounded-full",
  "h-6 w-12 rounded-full",
  "h-6 w-24 rounded-full",
  "h-6 w-24 rounded-full",
] as const;
const PURPOSE_BAR = ["h-3.5 w-3/5", "h-3.5 w-2/3", "h-3.5 w-1/2", "h-3.5 w-3/4"] as const;

/**
 * One agent kind, as agents/page.tsx draws it: a heading with its blurb and
 * "runs" line beside a "New ..." button, over a two-column grid of agent cards
 * (a name and its Running/Off chip, the purpose, and the "details - versions -
 * edited" line).
 */
function AgentSectionSkeleton({ cards, start }: { cards: number; start: number }) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 max-w-prose flex-1 basis-64 space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3 w-3/4" />
        </div>
        <Skeleton className="h-8 w-40 rounded-md" />
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {Array.from({ length: cards }, (_, i) => (
          <div key={i} className="space-y-2 rounded-md border border-border bg-surface p-4">
            <div className="flex items-center justify-between gap-2">
              <Skeleton className={NAME_BAR[(start + i) % NAME_BAR.length]} />
              <Skeleton className={CHIP_BAR[(start + i) % CHIP_BAR.length]} />
            </div>
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className={PURPOSE_BAR[(start + i) % PURPOSE_BAR.length]} />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Mirrors agents/page.tsx (the owner/manager view, with agents on file): the
 * "What agents do" intro card, then one section for each of the three agent
 * kinds - call extractors, chat qualifiers, reply drafters - each a heading and
 * "New ..." button over a grid of agent cards.
 */
export default function AgentsLoading() {
  return (
    <>
      <PageHeader title="AI assistants" context="Settings" />

      <Card className="space-y-2">
        <Skeleton className="h-3 w-28" />
        <div className="max-w-prose space-y-2.5">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-1/3" />
        </div>
        <Skeleton className="h-3 w-3/5 max-w-prose" />
      </Card>

      <AgentSectionSkeleton cards={2} start={0} />
      <AgentSectionSkeleton cards={2} start={2} />
      <AgentSectionSkeleton cards={2} start={1} />
    </>
  );
}
