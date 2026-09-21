import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** The line box a text size occupies: `text-xs` 16px, `text-sm` 20px. */
type LineBox = "h-4" | "h-5";

/**
 * Lines of text as the browser lays them out: one bar per line, each centred in
 * the line box the words would fill, so a paragraph is as tall as the real one.
 * `bars` are complete class strings; the last is short, the way a paragraph ends.
 */
function TextLines({
  line,
  bars,
  className = "",
}: {
  line: LineBox;
  bars: readonly string[];
  className?: string;
}) {
  return (
    <div className={className}>
      {bars.map((bar, i) => (
        <div key={i} className={`flex items-center ${line}`}>
          <Skeleton className={bar} />
        </div>
      ))}
    </div>
  );
}

/**
 * Complete class strings, picked by index, so the rows are not copies of one another.
 * Line counts and last-line lengths are measured from Inter's own advance widths.
 */
const INTRO = ["h-3.5 w-full", "h-3.5 w-full", "h-3.5 w-3/4"] as const;
const BACKLOG_BLURB = ["h-3.5 w-full"] as const;
const RULE_NAME = ["h-4 w-48", "h-4 w-40"] as const;
const RULE_STRATEGY_CHIP = ["h-6 w-28 rounded-full", "h-6 w-32 rounded-full"] as const;
const RULE_BLURB = ["h-3.5 w-4/5", "h-3.5 w-11/12"] as const;
const RULE_SCOPE = ["h-3 w-72", "h-3 w-64"] as const;
const UP_NEXT = ["h-3.5 w-96 max-w-full", "h-3.5 w-80 max-w-full"] as const;
const TELECALLER_NAME = ["h-3.5 w-24", "h-3.5 w-28", "h-3.5 w-20"] as const;
const DECISION_CHIP = [
  "h-[22px] w-24 rounded-full",
  "h-[22px] w-28 rounded-full",
  "h-[22px] w-20 rounded-full",
  "h-[22px] w-24 rounded-full",
  "h-[22px] w-28 rounded-full",
] as const;
const DECISION_LEAD = [
  "h-3.5 w-40",
  "h-3.5 w-32",
  "h-3.5 w-48",
  "h-3.5 w-36",
  "h-3.5 w-44",
] as const;
const DECISION_REASON = ["h-3 w-56", "h-3 w-44", "h-3 w-64", "h-3 w-52", "h-3 w-48"] as const;

/**
 * The "Unassigned backlog" card: a label over one line of copy, and "Distribute
 * now" beside them. The copy block is capped where the real one stops (its own
 * text width), so a wide screen does not stretch the bar past where words end.
 */
function BacklogCardSkeleton() {
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 max-w-5xl flex-1">
          <div className="flex h-4 items-center">
            <Skeleton className="h-3 w-32" />
          </div>
          <TextLines line="h-5" bars={BACKLOG_BLURB} className="mt-2" />
        </div>
        <Skeleton className="h-10 w-36 shrink-0 rounded-full" />
      </div>
    </Card>
  );
}

/**
 * One line-up row of a rule: a grip, the telecaller's name, a share input (a
 * percentage rule only), the daily-cap input, the Active toggle, the
 * delivered-versus-target meter with its figures, and a remove button.
 */
function TargetRowSkeleton({ split, index }: { split: boolean; index: number }) {
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2">
      <Skeleton className="size-4 shrink-0" />
      <div className="flex h-5 min-w-32 items-center">
        <Skeleton className={TELECALLER_NAME[index % TELECALLER_NAME.length]} />
      </div>
      {split ? (
        <div className="flex items-center gap-1">
          <Skeleton className="h-9.5 w-44 rounded-sm" />
          <Skeleton className="h-3 w-3" />
        </div>
      ) : null}
      <div className="flex items-center gap-1">
        <Skeleton className="h-3 w-14" />
        <Skeleton className="h-9.5 w-44 rounded-sm" />
      </div>
      <Skeleton className="h-10 w-16 rounded-full sm:h-8" />
      <div className="ml-auto flex min-w-40 items-center gap-2">
        <Skeleton className="h-2 w-full rounded-full" />
        <Skeleton className="h-3 w-32 shrink-0" />
      </div>
      <Skeleton className="h-10 w-10 rounded-full sm:h-8" />
    </li>
  );
}

/**
 * One rule as `RuleCard` draws it: "#N", the name and two chips over a blurb and
 * a scope line, Pause / Edit / delete at the right; the shaded "Up next" box;
 * then the telecaller line-up - a bordered row per person, an add-a-telecaller
 * select, "Restart counting" and the counting-since line. `split` is a
 * percentage rule (a share input per row); otherwise a rotation, which also
 * carries the rotation-order hint and a "then ..." line under Up next.
 */
function RuleCardSkeleton({
  split,
  targets,
  index,
}: {
  split: boolean;
  targets: number;
  index: number;
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Skeleton className="h-3 w-5" />
            <Skeleton className={RULE_NAME[index]} />
            <Skeleton className="h-6 w-16 rounded-full" />
            <Skeleton className={RULE_STRATEGY_CHIP[index]} />
          </div>
          <TextLines line="h-5" bars={[RULE_BLURB[index]]} className="mt-2 max-w-2xl" />
          <TextLines line="h-4" bars={[RULE_SCOPE[index]]} className="mt-1" />
        </div>
        <div className="flex shrink-0 gap-2">
          <Skeleton className="h-10 w-14 rounded-full sm:h-8" />
          <Skeleton className="h-10 w-12 rounded-full sm:h-8" />
          <Skeleton className="h-10 w-10 rounded-full sm:h-8" />
        </div>
      </div>

      <div className="mt-4 rounded-md border border-border bg-surface-hover px-4 py-3">
        <div className="flex h-4 items-center">
          <Skeleton className="h-3 w-14" />
        </div>
        <TextLines line="h-5" bars={[UP_NEXT[index]]} className="mt-1" />
        {split ? null : <TextLines line="h-4" bars={["h-3 w-48"]} className="mt-1" />}
      </div>

      <div className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex h-4 items-center">
            <Skeleton className="h-3 w-40" />
          </div>
          {split ? null : (
            <div className="flex h-4 items-center">
              <Skeleton className="h-3 w-80 max-w-full" />
            </div>
          )}
        </div>
        <ul className="mt-3 space-y-2">
          {Array.from({ length: targets }, (_, i) => (
            <TargetRowSkeleton key={i} split={split} index={i + index} />
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Skeleton className="h-9.5 w-52 rounded-sm" />
          <Skeleton className="h-10 w-32 rounded-full sm:h-8" />
        </div>
        <div className="mt-2 flex h-4 items-center">
          <Skeleton className="h-3 w-40" />
        </div>
      </div>
    </Card>
  );
}

/** The "Recent decisions" card: a label and one line of explanation over a divided log. */
function DecisionLogSkeleton() {
  return (
    <Card>
      <div className="flex h-4 items-center">
        <Skeleton className="h-3 w-32" />
      </div>
      <TextLines line="h-4" bars={["h-3 w-1/2"]} className="mt-2" />
      <ul className="mt-4 divide-y divide-border">
        {DECISION_CHIP.map((chip, i) => (
          <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
            <Skeleton className={chip} />
            <div className="flex h-5 items-center">
              <Skeleton className={DECISION_LEAD[i]} />
            </div>
            <div className="flex h-4 items-center">
              <Skeleton className={DECISION_REASON[i]} />
            </div>
            <div className="ml-auto flex h-4 items-center">
              <Skeleton className="h-3 w-32" />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * Mirrors lead-routing/page.tsx: a three-line intro under the header, then the
 * client's own `mt-6 space-y-6` column - the unassigned-backlog card, a "Rules,
 * in order" row with "New rule", one card per rule (a rotation, then a
 * percentage split, each with its Up next box and telecaller line-up) and the
 * recent-decisions log.
 */
export default function LeadRoutingLoading() {
  return (
    <>
      <PageHeader title="Lead routing" context="Settings" />
      <TextLines line="h-5" bars={INTRO} className="-mt-2 max-w-2xl" />
      <div className="mt-6 space-y-6">
        <BacklogCardSkeleton />
        <div className="flex items-center justify-between">
          <div className="flex h-4 items-center">
            <Skeleton className="h-3 w-28" />
          </div>
          <Skeleton className="h-10 w-28 rounded-full sm:h-8" />
        </div>
        <RuleCardSkeleton split={false} targets={3} index={0} />
        <RuleCardSkeleton split targets={3} index={1} />
        <DecisionLogSkeleton />
      </div>
    </>
  );
}
