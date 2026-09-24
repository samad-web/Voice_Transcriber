import { Card, Skeleton } from "@aura/ui";
import { DateRangeBarSkeleton, DateRangeSummarySkeleton } from "@/components/date-range-bar";
import { PageHeader } from "@/components/page-header";
import { IntroSkeleton } from "@/components/skeletons";

/** Complete class strings, picked by index, so Tailwind can see every one. */
const BOOKING_NAME = ["w-40", "w-32", "w-44"] as const;
const BOOKING_CONTACT = ["w-64", "w-56", "w-72"] as const;
const SLOT_TIME = ["w-28", "w-24", "w-32"] as const;

/** One upcoming booking: when, who, how to reach them, what they said, and a WhatsApp button. */
function BookingRow({ i }: { i: number }) {
  return (
    <div className="rounded-lg border border-border p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex h-6 items-center gap-2">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-12" />
          </div>
          <div className="mt-1 flex h-5 items-center">
            <Skeleton className={`h-3.5 ${BOOKING_NAME[i % BOOKING_NAME.length]}`} />
          </div>
          <div className="mt-1 flex h-5 items-center">
            <Skeleton
              className={`h-3.5 ${BOOKING_CONTACT[i % BOOKING_CONTACT.length]} max-w-full`}
            />
          </div>
          <div className="mt-2 flex h-4 items-center gap-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
        <Skeleton className="h-9 w-24 shrink-0 rounded-md" />
      </div>
    </div>
  );
}

/** The card that leads the page: a title and count, two toggle groups, then the booking list. */
function BookedCallsSkeleton() {
  return (
    <Card>
      <div>
        <div className="flex h-6 items-center">
          <Skeleton className="h-4 w-28" />
        </div>
        <div className="mt-0.5 flex h-4 items-center">
          <Skeleton className="h-3 w-40 max-w-full" />
        </div>
      </div>
      <div className="mt-4 flex flex-col gap-2.5">
        {[0, 1, 2].map((i) => (
          <BookingRow key={i} i={i} />
        ))}
      </div>
    </Card>
  );
}

/** The month grid: prev/next around a month name, a weekday row, five weeks of day cells, then the time-zone note and the generator link. */
function MonthGridSkeleton() {
  return (
    <Card>
      <div className="mb-5 flex items-center justify-between">
        <Skeleton className="size-9 rounded-full" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="size-9 rounded-full" />
      </div>
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={`w${i}`} className="flex h-6 items-start justify-center">
            <Skeleton className="h-3 w-8" />
          </div>
        ))}
        {Array.from({ length: 35 }, (_, i) => (
          <div key={`d${i}`} className="grid h-11 place-items-center">
            <Skeleton className="h-3.5 w-5" />
          </div>
        ))}
      </div>
      <div className="mt-5 flex h-4 items-center">
        <Skeleton className="h-3 w-full max-w-md" />
      </div>
      <div className="mt-4 flex h-4 items-center">
        <Skeleton className="h-3 w-56" />
      </div>
    </Card>
  );
}

/** The selected day: its date, a few slot rows, then the add-a-slot form. */
function DaySlotsSkeleton() {
  return (
    <Card>
      <div className="flex h-4 items-center">
        <Skeleton className="h-3 w-24" />
      </div>
      <div className="mt-4 flex flex-col gap-2">
        {SLOT_TIME.map((w, i) => (
          <div
            key={i}
            className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5"
          >
            <div className="min-w-0">
              <div className="flex h-5 items-center">
                <Skeleton className={`h-3.5 ${w}`} />
              </div>
              {i === 1 ? (
                <div className="flex h-4 items-center">
                  <Skeleton className="h-3 w-28" />
                </div>
              ) : null}
            </div>
            <Skeleton className="h-3 w-10 shrink-0" />
          </div>
        ))}
      </div>
      <div className="mt-5 border-t border-border pt-4">
        <div className="mb-2 flex h-4 items-center">
          <Skeleton className="h-3 w-20" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9.5 min-w-0 flex-1 rounded-sm" />
          <Skeleton className="h-9.5 w-24 shrink-0 rounded-sm" />
        </div>
        <Skeleton className="mt-2 h-10 w-full rounded-full" />
      </div>
    </Card>
  );
}

/**
 * Mirrors slots/page.tsx: intro copy, the shared date control and its line of
 * dates, then the booked-calls card (title, count, three bookings), then the
 * diary - a month grid on the left beside the selected day's slots and the
 * add-a-slot form. The slot generator is a collapsed link under the grid until
 * it is opened.
 */
export default function SlotsLoading() {
  return (
    <>
      <PageHeader title="Booking Slots" context="Platform" />
      <IntroSkeleton lines={2} />
      <DateRangeBarSkeleton />
      <DateRangeSummarySkeleton />
      <BookedCallsSkeleton />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <MonthGridSkeleton />
        <DaySlotsSkeleton />
      </div>
    </>
  );
}
