import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/**
 * The to-call list's own loader.
 *
 * Every console page has one: `console-loading.test.ts` fails the build for a
 * page that falls through to an ancestor's skeleton, because a shared skeleton
 * renders the WRONG heading for a moment and then swaps, which reads as a
 * mis-navigation rather than as loading.
 *
 * Shaped from the real page: a section heading with a count, then cards each
 * holding a name row with two or three chips, a due line, a quoted request, and
 * the action strip. Two sections, because a floor mid-morning has Overdue and
 * Due now - and a skeleton that drew four would make the page appear to shrink.
 */

/** Complete class strings, picked by index, so Tailwind can see every one. */
const NAME_W = ["w-40", "w-32", "w-48", "w-36"] as const;
const QUOTE_W = ["w-80", "w-64", "w-72", "w-56"] as const;

function CallbackCardSkeleton({ i }: { i: number }) {
  return (
    <li>
      <Card>
        <div className="flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              {/* Name, last-3, and the "they gave this time" chip. */}
              <div className="flex flex-wrap items-center gap-2">
                <Skeleton className={`h-4 ${NAME_W[i % NAME_W.length]}`} />
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-5 w-32 rounded-full" />
                {i % 3 === 0 ? <Skeleton className="h-5 w-20 rounded-full" /> : null}
              </div>
              {/* The due line. */}
              <div className="mt-2 flex items-center gap-1.5">
                <Skeleton className="size-3.5 rounded-sm" />
                <Skeleton className="h-3.5 w-52" />
              </div>
              {/* The customer's own words - the most important thing on the row. */}
              <div className="mt-2 flex items-start gap-1.5">
                <Skeleton className="mt-0.5 size-3.5 rounded-sm" />
                <Skeleton className={`h-3.5 ${QUOTE_W[i % QUOTE_W.length]} max-w-full`} />
              </div>
            </div>
            <Skeleton className="h-3.5 w-24 shrink-0" />
          </div>
          {/* Call now, Snooze, Outcome, Done, No answer. */}
          <div className="flex flex-wrap items-center gap-2">
            <Skeleton className="h-8 w-28 rounded-md" />
            <Skeleton className="h-9.5 w-28 rounded-sm" />
            <Skeleton className="h-9.5 w-36 rounded-sm" />
            <Skeleton className="h-8 w-16 rounded-md" />
            <Skeleton className="h-8 w-28 rounded-md" />
          </div>
        </div>
      </Card>
    </li>
  );
}

export default function CallbacksLoading() {
  return (
    <>
      <PageHeader title="Call-backs" context="Conversations" />
      <div className="flex flex-col gap-6">
        {[0, 1].map((section) => (
          <section key={section}>
            <div className="mb-2 flex items-center gap-2">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3.5 w-8" />
            </div>
            <ul className="flex flex-col gap-2">
              {(section === 0 ? [0, 1] : [2, 3, 4]).map((i) => (
                <CallbackCardSkeleton key={i} i={i} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
