import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** Complete class strings, one per row, so the rows are not copies of one another. */
const KIND_BAR = [
  "h-3.5 w-32",
  "h-3.5 w-24",
  "h-3.5 w-40",
  "h-3.5 w-28",
  "h-3.5 w-36",
  "h-3.5 w-32",
  "h-3.5 w-28",
] as const;
const DESC_BAR = [
  "h-3 w-72 max-w-full",
  "h-3 w-80 max-w-full",
  "h-3 w-64 max-w-full",
  "h-3 w-96 max-w-full",
  "h-3 w-72 max-w-full",
  "h-3 w-60 max-w-full",
  "h-3 w-80 max-w-full",
] as const;

/**
 * A labelled select with its two-line hint, and the save button that sits beside
 * it (under it on a phone) - the shape of both settings forms on this page.
 * `button` is the button's complete class string, since the two save buttons
 * differ in width.
 */
function SelectAndSaveSkeleton({ button }: { button: string }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
      <div className="space-y-1.5 sm:w-72">
        <Skeleton className="h-3.5 w-36" />
        <Skeleton className="h-9.5 w-full" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </div>
      <Skeleton className={button} />
    </div>
  );
}

/**
 * Mirrors notifications/page.tsx (an owner or manager, who sees both cards): the
 * "How you hear about things" card - an intro, a bordered list of notification
 * kinds each with an Instant / Digest switch, the "Digest arrives at" select with
 * its save button and a footnote - then the "Response time" card, an intro over a
 * select and its save button. The real list runs to twelve kinds; seven are drawn.
 */
export default function NotificationsLoading() {
  return (
    <>
      <PageHeader title="Notifications" context="Your account" />

      <Card>
        <Skeleton className="h-3 w-44" />
        <div className="mt-2 mb-4 space-y-2">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-1/3" />
        </div>
        <div className="space-y-5">
          <div className="divide-y divide-border rounded-lg border border-border">
            {KIND_BAR.map((kind, i) => (
              <div
                key={i}
                className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 space-y-1.5">
                  <Skeleton className={kind} />
                  <Skeleton className={DESC_BAR[i]} />
                </div>
                <Skeleton className="h-7.5 w-32 shrink-0 rounded-full" />
              </div>
            ))}
          </div>
          <SelectAndSaveSkeleton button="h-10 w-full rounded-full sm:mb-6 sm:w-52" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      </Card>

      <Card>
        <Skeleton className="h-3 w-28" />
        <div className="mt-2 mb-4 space-y-2">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
        <SelectAndSaveSkeleton button="h-10 w-full rounded-full sm:mb-6 sm:w-40" />
      </Card>
    </>
  );
}
