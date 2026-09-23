import { todayIn } from "@aura/shared";
import { DateRangeBar, DateRangeNotice, DateRangeSummary } from "@/components/date-range-bar";
import { PageHeader } from "@/components/page-header";
import { listBookingsAction } from "./actions";
import { BookedCalls } from "./booked-calls";
import { bookingPresets, bookingRange, parseBookingWindow } from "./booking-range";
import { SlotCalendar } from "./slot-calendar";

/**
 * Booking slots - the sales team's diary, and the calls it has produced.
 *
 * This is the answer to "where is the calendar in the application". Before it,
 * availability was three environment variables intersected with a Google
 * Calendar, so changing which times were bookable meant editing an env file and
 * redeploying, and nothing was bookable at all until a Google Cloud project
 * existed. Slots are now rows an operator creates here.
 *
 * ── BOOKED CALLS COME FIRST, AND THAT ORDER IS THE POINT ──────────────────
 *
 * The page used to be the calendar alone, which answers "when am I free" and
 * silently fails to answer "who am I speaking to today" - a dot on the grid
 * means slots EXIST on that day, so an empty Tuesday and a fully-booked Tuesday
 * are indistinguishable and the only way to find out was a click per day.
 *
 * Setting availability is something you do occasionally. Checking who is coming
 * is something you do every morning. So the list leads and the grid follows.
 *
 * The zone is read from SCHEDULER_TIMEZONE, defaulting to Asia/Kolkata, and is
 * the SALES TEAM's zone rather than the visitor's - the operator is choosing
 * when they personally are free, so the grid has to be in their local time.
 */
/**
 * Never cached. The whole point of this page is that it is current: a booking
 * made a minute ago has to be on it, and a cached render would show an empty
 * diary to someone who has just been told a call is booked. `requireOperator()`
 * reads cookies and would opt this out of static rendering anyway, but that is
 * an implementation detail of the guard rather than a property of this page -
 * stating it here means a future refactor of the guard cannot silently start
 * serving stale bookings.
 */
export const dynamic = "force-dynamic";

export default async function SlotsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const timeZone = process.env.SCHEDULER_TIMEZONE?.trim() || "Asia/Kolkata";

  // The booked list's days: the shared date control, looking forward by
  // default (booking-range.ts), resolved to dates from the scheduler's today.
  const { window, invalid } = parseBookingWindow(await searchParams);
  const range = bookingRange(window, todayIn(timeZone));

  // Fetched server-side so the list is present in the first paint. A failure
  // here degrades to an empty list with the reason shown, rather than taking
  // the calendar down with it - the two halves of this page are independent
  // and an operator can still set availability while the join is misbehaving.
  const { bookings, error } = await listBookingsAction({ ...range, timeZone });

  return (
    <>
      <PageHeader title="Booking Slots" context="Platform" />

      <p className="max-w-xl font-sans text-xs font-medium text-neutral-500">
        Who is booked in, and when you are free. Open slots are offered to qualified leads; a
        booked one shows who took it.
      </p>

      {/* Scopes the booked calls below. The calendar under them keeps its own
          month-by-month navigation - it is for setting availability. */}
      <DateRangeBar path="/slots" presets={bookingPresets(window)} from={range.from} to={range.to} />
      {invalid ? <DateRangeNotice fallbackDays={14} fallback="the next 14 days" /> : null}
      <DateRangeSummary from={range.from} to={range.to} zone={timeZone} />

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger/30 bg-danger/5 p-4 text-sm text-danger-text"
        >
          <p className="font-semibold">Could not load booked calls</p>
          <p className="mt-1">{error}</p>
          <p className="mt-2 text-xs text-text-muted">
            The calendar below still works. Bookings are stored either way - this is a read
            failure, not a lost booking.
          </p>
        </div>
      ) : (
        // Keyed on the range: a new range is a new list, not an edit of this one.
        <BookedCalls key={`${range.from}:${range.to}`} initial={bookings ?? []} />
      )}

      <SlotCalendar timeZone={timeZone} />
    </>
  );
}
