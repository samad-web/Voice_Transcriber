import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** Complete class strings, picked by index, so Tailwind can see every one. */
const TITLE_W = ["w-64", "w-48", "w-72", "w-56", "w-40", "w-60"] as const;
const DUE_W = ["w-28", "w-20", "w-24", "w-28", "w-20", "w-24"] as const;
const RECORD_W = ["w-24", "w-32", "w-20", "w-28", "w-24", "w-32"] as const;
const ASSIGNEE_W = ["w-20", "w-16", "w-24", "w-20", "w-16", "w-24"] as const;
const SELECT_W = ["w-36", "w-44", "w-36", "w-36", "w-40"] as const;
const LABEL_W = ["w-10", "w-20", "w-8", "w-12", "w-8"] as const;
const OVERDUE_TITLE_W = ["w-24", "flex-1", "w-20", "flex-1", "w-28", "w-24"] as const;

/**
 * SavedViewsBar for someone with no saved views of their own: the one "Open tasks"
 * tab, its 2px rule sitting over the strip's hairline. A `h-9` tab, not the
 * `h-10` of `TabsSkeleton`, because that is what the bar draws.
 */
function SavedViewsStripSkeleton() {
  return (
    <div className="flex flex-wrap items-end gap-x-3 gap-y-2 border-b border-border">
      <div className="-mb-px flex min-w-0 flex-1">
        <div className="flex h-9 items-center border-b-2 border-border-strong px-3">
          <Skeleton className="h-3.5 w-20" />
        </div>
      </div>
    </div>
  );
}

/** One filter field: a 16px label line, then a 38px control, as `FilterSearch` / `FilterSelect`. */
function FilterFieldSkeleton({ i, search = false }: { i: number; search?: boolean }) {
  return (
    <div className={search ? "min-w-[12rem] flex-1 sm:max-w-sm" : "min-w-[9rem]"}>
      <div className="flex h-4 items-center">
        <Skeleton className={`h-2.5 ${search ? "w-12" : LABEL_W[i % LABEL_W.length]}`} />
      </div>
      <Skeleton
        className={`mt-1.5 h-9.5 ${search ? "w-full" : SELECT_W[i % SELECT_W.length]} rounded-sm`}
      />
    </div>
  );
}

/**
 * One open task, as task-row.tsx draws it: an urgency rail, the Done checkbox, a
 * title over a due chip (some with a High priority chip), the linked record and the
 * assignee, and the Log call / Log message pair - to the right of the row from `sm`,
 * a full-width pair under it on a phone.
 */
function TaskRowSkeleton({ i }: { i: number }) {
  return (
    <li className="relative px-3 py-3 pl-4">
      <Skeleton className="absolute top-3 bottom-3 left-0 w-1 rounded-full" />
      <div className="flex items-start gap-3">
        <Skeleton className="mt-0.5 size-5 shrink-0 sm:size-4" />
        <div className="min-w-0 flex-1">
          <div className="flex h-5 items-center">
            <Skeleton className={`h-3.5 ${TITLE_W[i % TITLE_W.length]} max-w-full`} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <Skeleton className={`h-5.5 ${DUE_W[i % DUE_W.length]} rounded-full`} />
            {i % 4 === 1 ? <Skeleton className="h-5.5 w-28 rounded-full" /> : null}
            <div className="flex h-4 items-center">
              <Skeleton className={`h-3 ${RECORD_W[i % RECORD_W.length]}`} />
            </div>
            <div className="flex h-4 items-center">
              <Skeleton className={`h-3 ${ASSIGNEE_W[i % ASSIGNEE_W.length]}`} />
            </div>
          </div>
        </div>
        <div className="hidden shrink-0 gap-1.5 sm:flex">
          <Skeleton className="h-8 w-24 rounded-full" />
          <Skeleton className="h-8 w-28 rounded-full" />
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 pl-8 sm:hidden">
        <Skeleton className="h-10 rounded-full" />
        <Skeleton className="h-10 rounded-full" />
      </div>
    </li>
  );
}

/**
 * Mirrors tasks/page.tsx: the saved-views strip (only its "Open tasks" tab; a
 * user's own views join it after the fetch), then a grid from `xl` - one card
 * holding the filter form (a search box and five selects: Status, Assigned to, Due,
 * Priority, Sort), the new-task row, a task count beside the Select button and the bordered list of
 * task rows, beside a narrow Overdue card: its label, the big count, a caption and
 * the first few overdue dates with their titles.
 */
export default function TasksLoading() {
  return (
    <>
      <PageHeader title="Tasks" context="Your work" />
      <SavedViewsStripSkeleton />
      <div className="grid gap-6 xl:grid-cols-[1fr_18rem]">
        <Card className="space-y-4">
          <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
            <FilterFieldSkeleton i={0} search />
            {[0, 1, 2, 3, 4].map((i) => (
              <FilterFieldSkeleton key={i} i={i} />
            ))}
          </div>
          <div className="space-y-3">
            {/* Count on the left; Select and the New task button (which opens
                the task dialog) on the right. */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex h-4 items-center">
                <Skeleton className="h-3 w-16" />
              </div>
              <div className="flex items-center gap-2">
                <Skeleton className="h-10 w-20 rounded-full sm:h-8" />
                <Skeleton className="h-10 w-28 rounded-full" />
              </div>
            </div>
            <ul className="divide-y divide-border rounded-md border border-border">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <TaskRowSkeleton key={i} i={i} />
              ))}
            </ul>
          </div>
        </Card>

        <Card>
          <div className="flex h-4 items-center">
            <Skeleton className="h-2.5 w-14" />
          </div>
          <div className="mt-2 flex h-9 items-center">
            <Skeleton className="h-7 w-10" />
          </div>
          <div className="mt-1 flex h-4 items-center">
            <Skeleton className="h-2.5 w-44" />
          </div>
          <ul className="mt-3 space-y-1.5">
            {OVERDUE_TITLE_W.map((titleW, i) => (
              <li key={i}>
                <div className="flex h-4 items-center gap-1.5">
                  <Skeleton className="h-2.5 w-14 shrink-0" />
                  <Skeleton className={`h-2.5 ${titleW}`} />
                </div>
                {titleW === "flex-1" ? (
                  <div className="flex h-4 items-center">
                    <Skeleton className="h-2.5 w-1/2" />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
