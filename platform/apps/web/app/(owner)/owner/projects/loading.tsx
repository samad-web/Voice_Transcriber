import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** The line box a text size occupies: `text-xs` 16px, `text-sm` 20px, `text-xs` relaxed 19.5px. */
type LineBox = "h-4" | "h-5" | "h-[19.5px]";

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
 * Complete class strings, picked by index, so the cards are not copies of one another.
 * The intro's line count and last-line length are measured from Inter's own advance widths.
 */
const INTRO = ["h-3.5 w-full", "h-3.5 w-full", "h-3.5 w-full", "h-3.5 w-1/5"] as const;
const PROJECT_CHIP = [
  "h-[22px] w-32 rounded-full",
  "h-[22px] w-40 rounded-full",
  "h-[22px] w-28 rounded-full",
  "h-[22px] w-36 rounded-full",
  "h-[22px] w-44 rounded-full",
  "h-[22px] w-24 rounded-full",
] as const;
const DESCRIPTION_TAIL = ["h-3 w-2/3", "h-3 w-1/2", "h-3 w-3/4", "h-3 w-3/5"] as const;
const ALIASES = ["h-3 w-3/4", "h-3 w-3/5", "h-3 w-4/5", "h-3 w-2/3"] as const;
const STAT_LABEL = ["h-2.5 w-8", "h-2.5 w-7", "h-2.5 w-6"] as const;
const STAT_VALUE = ["h-3 w-6", "h-3 w-5", "h-3 w-10", "h-3 w-8"] as const;

/**
 * One project card as projects-client.tsx draws it: its coloured name chip and
 * an Active chip, a two-line description, the "Also heard as" line, a rule over
 * Leads / Open / Won figures, then Edit, "View leads" and Archive.
 */
function ProjectCardSkeleton({ index }: { index: number }) {
  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <Skeleton className={PROJECT_CHIP[index % PROJECT_CHIP.length]} />
        <Skeleton className="h-[22px] w-18 rounded-full" />
      </div>

      <TextLines
        line="h-[19.5px]"
        bars={["h-3 w-full", DESCRIPTION_TAIL[index % DESCRIPTION_TAIL.length]]}
      />

      <TextLines line="h-4" bars={[ALIASES[index % ALIASES.length]]} />

      <div className="grid grid-cols-3 gap-2 border-t border-border pt-3">
        {STAT_LABEL.map((label, c) => (
          <div key={c}>
            <div className="flex h-4 items-center">
              <Skeleton className={label} />
            </div>
            <div className="mt-0.5 flex h-4 items-center">
              <Skeleton className={STAT_VALUE[(index + c) % STAT_VALUE.length]} />
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-10 w-12 rounded-full sm:h-8" />
        <div className="flex h-4 items-center">
          <Skeleton className="h-3 w-16" />
        </div>
        <Skeleton className="ml-auto h-10 w-18 rounded-full sm:h-8" />
      </div>
    </Card>
  );
}

/**
 * Mirrors projects/page.tsx: a four-line intro under the header, then the
 * client's own fragment - a "N projects" count beside "New project", and a
 * grid of project cards (two across from `sm`, three from `xl`), each a
 * coloured chip, a description, aliases, a Leads / Open / Won strip and actions.
 */
export default function ProjectsLoading() {
  return (
    <>
      <PageHeader title="Projects" context="Pipeline" />
      <TextLines line="h-5" bars={INTRO} className="-mt-2 max-w-2xl" />
      <div className="flex items-center justify-between gap-3">
        <div className="flex h-4 items-center">
          <Skeleton className="h-3 w-20" />
        </div>
        <Skeleton className="h-10 w-36 rounded-full" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <ProjectCardSkeleton key={i} index={i} />
        ))}
      </div>
    </>
  );
}
