import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/**
 * Line boxes, from the theme's 1.5 line-height (theme.css): `text-sm` 21px,
 * `text-xs` 18px, and `text-xs leading-snug` 16.5px. A bare bar is shorter than the
 * line it stands in for, and a dozen of them add up to a visible jump.
 */
const BOX = { sm: "h-[21px]", xs: "h-[18px]", snug: "h-[16.5px]" } as const;

/** One line of text: `bar` (a literal `h-* w-*` pair) centred in that line's box. */
function Line({ box, bar }: { box: keyof typeof BOX; bar: string }) {
  return (
    <div className={`flex items-center ${BOX[box]}`}>
      <Skeleton className={bar} />
    </div>
  );
}

/** Template-card names and role chips ("Leads", "Campaign spend"), cycled by index. */
const NAME_W = ["w-24", "w-32", "w-28", "w-36"] as const;
const ROLE_W = ["w-16", "w-20", "w-24", "w-16"] as const;

/**
 * The gallery as the stock templates fill it, in the page's order: Call floor,
 * Pipeline, Marketing, Finance, then the lone Blank card ("Start from scratch"),
 * which is the one card with no role chips. `head` is the group heading's width;
 * `lines` has one entry per card, the lines its description wraps to at four across.
 */
const GROUPS = [
  { head: "w-20", lines: [3, 2] },
  { head: "w-16", lines: [2, 3, 2, 3] },
  { head: "w-20", lines: [2, 3] },
  { head: "w-16", lines: [4] },
  { head: "w-28", lines: [2] },
] as const;

/** One template button: an icon and a name, the description, then the roles it wants as chips. */
function TemplateCardSkeleton({ i, lines, chips }: { i: number; lines: number; chips: number }) {
  return (
    <div className="flex h-full flex-col rounded-md border border-border bg-surface p-3">
      <div className="flex items-center gap-2">
        <Skeleton className="size-4 shrink-0" />
        <Line box="sm" bar={`h-3.5 ${NAME_W[i % NAME_W.length]}`} />
      </div>
      <div className="mt-1 flex-1">
        {Array.from({ length: lines }, (_, l) => (
          <Line key={l} box="snug" bar={l === lines - 1 ? "h-2.5 w-2/3" : "h-2.5 w-full"} />
        ))}
      </div>
      {chips > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {Array.from({ length: chips }, (_, c) => (
            <Skeleton key={c} className={`h-6 rounded-full ${ROLE_W[(i + c) % ROLE_W.length]}`} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Report-row names, and each row's chips: published, schedules, link on, a role. */
const REPORT_NAME_W = ["w-52", "w-44", "w-60", "w-40"] as const;
const REPORT_CHIPS = [
  ["w-28", "w-24", "w-20"],
  ["w-28", "w-20"],
  ["w-16"],
  ["w-28", "w-24"],
] as const;
/** The "who . edited when" line, cycled. */
const META_W = ["w-56", "w-60", "w-52", "w-64"] as const;

/**
 * Mirrors reports/builder/page.tsx: the intro paragraph tucked under the header;
 * the "Start from a template" card - a caption, a note, then the templates in
 * their groups (a heading over a row of bordered cards, each an icon and name, a
 * few lines of description and its role chips); and the "Your reports" card with
 * its "Manage data sources" link over a divided list - each report a name with
 * its status chips, an occasional description, and who edited it when.
 */
export default function ReportBuilderLoading() {
  return (
    <>
      <PageHeader title="Report builder" context="Pipeline" />

      <div className="-mt-2 max-w-3xl">
        <Line box="sm" bar="h-3.5 w-full" />
        <Line box="sm" bar="h-3.5 w-full" />
        <Line box="sm" bar="h-3.5 w-1/4" />
      </div>

      <Card>
        <Line box="xs" bar="h-3 w-36" />
        <div className="mt-1">
          <Line box="xs" bar="h-2.5 w-11/12" />
        </div>

        <div className="mt-4 space-y-5">
          {GROUPS.map((group, g) => (
            <div key={g}>
              <Line box="snug" bar={`h-2.5 ${group.head}`} />
              <div className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {group.lines.map((lines, i) => (
                  <TemplateCardSkeleton
                    key={i}
                    i={i + g}
                    lines={lines}
                    chips={g === GROUPS.length - 1 ? 0 : 1 + ((i + g) % 2)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Line box="xs" bar="h-3 w-24" />
          <Line box="xs" bar="h-3 w-32" />
        </div>

        <div className="mt-3 divide-y divide-border">
          {REPORT_CHIPS.map((chips, i) => (
            <div key={i} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Line box="sm" bar={`h-3.5 ${REPORT_NAME_W[i]}`} />
                <div className="flex flex-wrap items-center gap-2">
                  {chips.map((w, c) => (
                    <Skeleton key={c} className={`h-6 rounded-full ${w}`} />
                  ))}
                </div>
              </div>
              {i % 2 === 1 ? (
                <div className="mt-1">
                  <Line box="xs" bar="h-2.5 w-3/5" />
                </div>
              ) : null}
              <div className="mt-1">
                <Line box="xs" bar={`h-2.5 ${META_W[i]}`} />
              </div>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
