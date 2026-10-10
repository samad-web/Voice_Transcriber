import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/**
 * The wizard's loader.
 *
 * Measured against the real first step: a scrollable rail of ten chips, a
 * heading with a state chip, a blurb, a two-column field grid and the
 * Back/Next footer. The rail is the piece worth getting right - it is the
 * tallest thing above the fields, and a loader without it makes the step
 * heading jump upward the moment the policy arrives.
 */

const CHIP_W = [
  "w-24",
  "w-28",
  "w-26",
  "w-24",
  "w-36",
  "w-20",
  "w-32",
  "w-34",
  "w-16",
  "w-20",
] as const;

export default function CallbackRulesLoading() {
  return (
    <>
      <PageHeader title="Call-back rules" context="Settings" />
      <div className="flex flex-col gap-4">
        {/* The step rail. */}
        <div className="-mx-1 overflow-hidden px-1">
          <div className="flex min-w-max items-center gap-1">
            {CHIP_W.map((w, i) => (
              <Skeleton key={i} className={`h-6 ${w} rounded-md`} />
            ))}
          </div>
        </div>

        <Card>
          <div className="flex flex-col gap-4 p-4 sm:p-6">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-5 w-40 rounded-full" />
              </div>
              <Skeleton className="mt-2 h-3.5 w-9/12 max-w-prose" />
            </div>

            {/* The field grid: label, control, hint - twice over, two columns. */}
            <div className="grid gap-4 sm:grid-cols-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i}>
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="mt-1.5 h-9.5 w-full rounded-sm" />
                  <Skeleton className="mt-1 h-3 w-10/12" />
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
              <Skeleton className="h-8 w-20 rounded-full" />
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-8 w-20 rounded-full" />
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
