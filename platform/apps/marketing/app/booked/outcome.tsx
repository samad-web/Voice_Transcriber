import { Container } from "@/components/ui/layout";
import { ButtonLink } from "@/components/ui/button";
import { WhatsAppCta } from "@/components/ui/whatsapp-cta";
import { WA_MESSAGES } from "@/lib/site";
import { getScheduler, schedulerTimeZone, type Slot } from "@/lib/scheduler";

/* ════════════════════════════════════════════════════════════════════════════
   The funnel's outcome screens - `lead-funnel-spec.md` Step 3, doc 16 §0.4.

   Three screens, and which one a visitor sees is decided entirely on the
   server:

     ReachOutScreen      the disqualified path, AND the qualified path whenever
                         there is no real slot to offer.
     QualifiedOutcome    the booking UI - but only when real slots exist.
     BookingConfirmed    after a real event was written to a real calendar.

   These are exported for the funnel to compose (Dev C owns `/start` and
   `components/funnel`). They live under `app/booked/` because the booking
   confirmation is a route and the other two are its siblings; nothing here
   reads a route param or a searchParam, so they can be rendered inline in the
   two-step form just as well.

   ── The one rule ────────────────────────────────────────────────────────────

   No calendar, no slot picker and no booking confirmation of any kind reaches
   the disqualified path - the spec is explicit - and no *fake* slot reaches
   anybody. Note what that means for the qualified path when the scheduler is
   unconfigured or the calendar is full: it renders `ReachOutScreen`, the same
   component, with the same words. Not a variant of it. Making it literally the
   same component is what stops the two copies drifting apart, and it means the
   qualified-but-nothing-free path is exercised on every build rather than only
   after Google credentials land.
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * A server action that books the slot named in the submitted form.
 *
 * Dev C implements this, because booking needs the `funnel_submissions` row and
 * that is their table. Two things it MUST do, in this order:
 *
 *  1. **Re-derive the slot server-side.** The `slot` field is an ISO string that
 *     arrived from a browser. Call `scheduler.availableSlots()` again and accept
 *     the submission only if it matches one of the returned starts exactly.
 *     Without that check a crafted POST books any time it likes, at 3am, on a
 *     Sunday, for a visitor the qualification rule already turned away.
 *  2. **Confirm the submission is `qualified`** before touching the calendar.
 *     The form being rendered is not authorisation; the row's status is.
 *
 * It returns `void` because the success path is a `redirect("/booked")` - which
 * also means a refresh cannot re-post the booking.
 */
export type BookSlotAction = (formData: FormData) => Promise<void>;

/* ── The screen both paths share ─────────────────────────────────────────── */

/**
 * "Our team will reach out."
 *
 * The disqualified screen from the spec, word for word, and deliberately not
 * apologetic: it makes no reference to budget, to a rule, or to anything having
 * been declined. Doc 16 §3.2's business note is that at a ₹30,000/month
 * threshold this is likely to be the MAIN path, not the exception - so it is
 * written as a real destination, with something to do next, rather than as a
 * dead end.
 */
export function ReachOutScreen({
  name,
  heading = "Thanks for sharing your details",
}: {
  /** First name, when the caller has it. Purely a courtesy. */
  name?: string;
  heading?: string;
}) {
  return (
    <Container className="py-16 sm:py-24">
      <div className="max-w-2xl">
        <p className="text-base font-medium text-accent-text">All done</p>
        <h1 className="mt-3 text-3xl sm:text-4xl font-semibold tracking-tight text-text text-balance">
          {name ? `${heading}, ${name}` : heading}
        </h1>
        <p className="mt-4 text-lg text-text-muted text-pretty">
          Our team will reach out to you shortly.
        </p>
        <p className="mt-4 text-lg text-text-muted text-pretty">
          If it is easier, message us directly. You will get a straight answer on
          the first reply rather than a callback queue.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <WhatsAppCta message={WA_MESSAGES.footer} size="lg" />
          <ButtonLink href="/compatibility" variant="secondary" size="lg">
            Check your phones in the meantime
          </ButtonLink>
        </div>

        <p className="mt-8 text-base text-text-muted">
          Worth a look while you wait: what we do and do not record is on the{" "}
          <a
            href="/consent"
            className="text-accent underline underline-offset-4 decoration-1 hover:text-accent-hover transition-colors duration-150 ease-out"
          >
            consent page
          </a>
          .
        </p>
      </div>
    </Container>
  );
}

/* ── The qualified path ──────────────────────────────────────────────────── */

/**
 * Booking UI, or the contact screen - decided by whether real slots exist.
 *
 * An async server component: it does the free/busy call during the render the
 * visitor is already waiting on, which is one round trip and no client JS.
 *
 * `slots.length === 0` covers three distinct situations - unconfigured, fully
 * booked, and Google unreachable - and all three get the same screen on
 * purpose. The visitor does not need to know which, and the alternative in the
 * third case is an error page shown to a lead who just qualified.
 */
export async function QualifiedOutcome({
  bookAction,
  name,
  /** How far ahead to offer. Two weeks is long enough to find a time and short
   *  enough that the free/busy answer is still true when they click. */
  daysAhead = 14,
}: {
  bookAction: BookSlotAction;
  name?: string;
  daysAhead?: number;
}) {
  const scheduler = getScheduler();

  let slots: Slot[] = [];
  if (scheduler.configured) {
    const from = new Date();
    const to = new Date(from.getTime() + daysAhead * 86_400_000);
    try {
      slots = await scheduler.availableSlots(from, to);
    } catch (err) {
      // Fail to the honest screen, never to a 500 and never to a made-up time.
      console.error("[scheduler] availableSlots failed, showing contact screen:", err);
      slots = [];
    }
  }

  if (slots.length === 0) return <ReachOutScreen name={name} />;

  return <SlotPicker slots={slots} bookAction={bookAction} name={name} />;
}

/**
 * The picker. A plain `<form>` with radio inputs and a server action - no
 * client component, no `onClick`, no JavaScript at all, which keeps this app's
 * 170 B-per-route footprint (doc 18 §5) and means the form still works on a
 * cheap phone with a broken bundle.
 *
 * Not exported: a picker can only ever be constructed from slots that came out
 * of `availableSlots`, and going through `QualifiedOutcome` is what guarantees
 * that. An exported picker is an invitation to hand it a literal.
 */
function SlotPicker({
  slots,
  bookAction,
  name,
}: {
  slots: Slot[];
  bookAction: BookSlotAction;
  name?: string;
}) {
  const tz = schedulerTimeZone();
  const days = groupByDay(slots, tz);

  return (
    <Container className="py-16 sm:py-24">
      <div className="max-w-2xl">
        <p className="text-base font-medium text-accent-text">You&rsquo;re through</p>
        <h1 className="mt-3 text-3xl sm:text-4xl font-semibold tracking-tight text-text text-balance">
          {name ? `Thanks, ${name}. Pick a time that works for you` : "Thanks. Pick a time that works for you"}
        </h1>
        <p className="mt-4 text-lg text-text-muted text-pretty">
          Every time below is genuinely free on our calendar right now. Times are
          shown in {zoneLabel(tz)}.
        </p>

        <form action={bookAction} className="mt-8">
          <fieldset>
            <legend className="sr-only">Available times</legend>
            <div className="space-y-6">
              {days.map((day) => (
                <div key={day.label}>
                  <h2 className="text-base font-semibold text-text">{day.label}</h2>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {day.slots.map((slot) => {
                      const iso = slot.start.toISOString();
                      return (
                        <label
                          key={iso}
                          className={
                            "cursor-pointer rounded-md border border-border-strong bg-surface px-4 py-2.5 " +
                            "text-base text-text transition-colors duration-150 ease-out " +
                            "hover:bg-surface-hover " +
                            // The radio itself is visually hidden but focusable,
                            // so the ring has to be drawn on the label. Doc 16
                            // §1.5: never an outline-none without a replacement.
                            "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 " +
                            "has-[:focus-visible]:outline-accent " +
                            // Selection is a border + fill change, not colour
                            // alone - checked state has to survive a greyscale
                            // print and a colour-blind reader.
                            "has-[:checked]:border-accent has-[:checked]:bg-accent-subtle " +
                            "has-[:checked]:font-medium has-[:checked]:text-accent-text"
                          }
                        >
                          <input
                            type="radio"
                            name="slot"
                            value={iso}
                            required
                            className="sr-only"
                          />
                          <time dateTime={iso}>{formatTime(slot.start, tz)}</time>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </fieldset>

          <button
            type="submit"
            className={
              "mt-8 inline-flex h-12 items-center justify-center rounded-md bg-accent px-6 " +
              "text-lg font-medium text-accent-fg transition-colors duration-150 ease-out " +
              "hover:bg-accent-hover " +
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            }
          >
            Confirm this time
          </button>
        </form>

        <p className="mt-6 text-base text-text-muted">
          A calendar invite goes to the email address you gave us. If none of these
          suit, message us and we will find one that does.
        </p>
      </div>
    </Container>
  );
}

/* ── After a real booking ────────────────────────────────────────────────── */

/**
 * The confirmation. Rendered only after `Scheduler.book()` resolved with a real
 * event id.
 *
 * It states no time. That is not an oversight: this component is reached by a
 * redirect, so it has no submission in scope, and the honest options were "no
 * time" or "a time taken from the URL" - the second is a confirmation a visitor
 * could write themselves, which is the exact class of thing the no-fake-booking
 * rule exists to forbid. When Dev C's submission store lands, pass the stored
 * `booking_slot` in and print it. Tracked in followUps.
 */
export function BookingConfirmed({ at }: { at?: Date }) {
  const tz = schedulerTimeZone();
  return (
    <Container className="py-16 sm:py-24">
      <div className="max-w-2xl">
        <p className="text-base font-medium text-success-text">Confirmed</p>
        <h1 className="mt-3 text-3xl sm:text-4xl font-semibold tracking-tight text-text text-balance">
          Your call is booked
        </h1>
        {at ? (
          <p className="mt-4 text-lg text-text">
            <time dateTime={at.toISOString()}>
              {formatDay(at, tz)}, {formatTime(at, tz)} {zoneLabel(tz)}
            </time>
          </p>
        ) : null}
        <p className="mt-4 text-lg text-text-muted text-pretty">
          The invite is on its way to the email address you gave us, with the
          details of the call. If you need to move it, reply to that invite or
          message us.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <WhatsAppCta message={WA_MESSAGES.footer} size="lg" variant="secondary" />
          <ButtonLink href="/compatibility" variant="secondary" size="lg">
            Check your phones before the call
          </ButtonLink>
        </div>
      </div>
    </Container>
  );
}

/* ── Formatting ──────────────────────────────────────────────────────────── */

function groupByDay(slots: Slot[], tz: string): Array<{ label: string; slots: Slot[] }> {
  const days: Array<{ label: string; slots: Slot[] }> = [];
  for (const slot of slots) {
    const label = formatDay(slot.start, tz);
    const last = days[days.length - 1];
    if (last && last.label === label) last.slots.push(slot);
    else days.push({ label, slots: [slot] });
  }
  return days;
}

/** en-IN: the audience is Indian SMBs, so "Mon, 11 Aug" not "Mon, Aug 11". */
function formatDay(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(d);
}

function formatTime(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

/** "IST" where the platform knows a short name, the IANA id otherwise. Never a
 *  bare number: "10:00" with no zone is how someone misses a call. */
function zoneLabel(tz: string): string {
  const part = new Intl.DateTimeFormat("en-IN", { timeZone: tz, timeZoneName: "short" })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? tz;
}
