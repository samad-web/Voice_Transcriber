"use client";

import { useState, useTransition } from "react";
import { Card, MonoLabel, StatusChip, useAlert, useToast } from "@aura/ui";
import { markAttendanceAction, type Booking } from "./actions";

/**
 * The calls that are actually booked.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM THE CALENDAR ──────────────────────────
 *
 * The month grid answers "when am I free". It cannot answer "who am I speaking
 * to today": a dot on a day means SLOTS EXIST there, so an empty Tuesday and a
 * fully-booked Tuesday look identical, and finding out costs a click per day.
 * That is fine for setting availability and useless for the thing an operator
 * does every morning.
 *
 * So this leads the page and the calendar follows it. Name, time, phone, email
 * - enough to pick up the phone without opening anything else.
 *
 * ── WHICH DAYS ────────────────────────────────────────────────────────────
 *
 * The page's date control (the one every report shares) picks them: the next
 * fortnight by default - "who am I speaking to" - or the last few days, where
 * the calls to mark as attended or missed are, or any From/To range. The
 * buttons only appear on calls that are actually markable, whichever days are
 * showing. The page keys this component on the range, so a new range starts
 * from the server's list rather than this one's edits.
 */
export function BookedCalls({ initial }: { initial: Booking[] }) {
  const [bookings, setBookings] = useState(initial);
  const [pending, start] = useTransition();
  const [marking, setMarking] = useState<string | null>(null);
  const alert = useAlert();
  const toast = useToast();

  function mark(booking: Booking, outcome: "attended" | "no_show") {
    setMarking(booking.id);
    start(async () => {
      const res = await markAttendanceAction(booking.id, outcome);
      setMarking(null);
      if (res.error) {
        await alert({
          title: outcome === "attended"
            ? "Couldn't mark the call as attended"
            : "Couldn't mark the call as missed",
          body: res.error,
          tone: "danger",
        });
        return;
      }
      // Update in place rather than relying on revalidatePath alone: this is a
      // client component holding its own array, and a server revalidation does
      // not reach into it. Without this the row keeps offering both buttons
      // until something else refetches.
      setBookings((bs) =>
        bs.map((b) => (b.id === booking.id ? { ...b, attendance: outcome } : b)),
      );
      toast(
        !res.hasEnquirer
          ? "Marked. No message was sent - this enquirer's details were erased."
          : outcome === "attended"
            ? "Marked as attended. A thank-you message is queued."
            : // Named precisely: the follow-up is queued but the nurture stages
              // ship switched off, and telling an operator three messages are
              // going out when they are not is the failure this whole codebase
              // avoids elsewhere.
              `Marked as missed. A "sorry we missed you" message is queued, and the ` +
              `three follow-ups are queued behind it - they only send if you have ` +
              `switched those templates on.`,
      );
    });
  }

  return (
    <Card>
      <div>
        <p className="font-semibold text-text">Booked calls</p>
        <p className="mt-0.5 text-xs text-text-muted">
          {bookings.length === 0
            ? "Nothing booked on these days."
            : `${bookings.length} ${bookings.length === 1 ? "call" : "calls"} on these days`}
        </p>
      </div>

      {pending ? <p className="mt-3 text-xs text-text-muted">Saving…</p> : null}

      {bookings.length === 0 ? (
        <p className="mt-4 text-sm text-text-muted">
          When someone books a slot from the website it appears here, with their number and email.
          Calls that have already happened show up under the last few days, so you can record
          whether they took place.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-2.5">
          {bookings.map((b) => {
            // A call is markable once it has started and nobody has marked it.
            // Time is compared here rather than trusted from the list, because
            // any range can include a call that has not begun yet.
            const started = new Date(b.starts_at).getTime() <= Date.now();
            const markable = started && !b.attendance && Boolean(b.submission_id);

            return (
              <li key={b.id} className="rounded-lg border border-border p-3.5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-text">
                        {b.day_label} · {b.time_label}
                      </span>
                      <span className="text-xs text-text-muted">
                        {Math.round(Number(b.duration_minutes))} min
                      </span>
                      {/* Only shown when something is wrong. A green "synced" chip
                          on every row would be noise; the absence of a warning is
                          already the good news. */}
                      {b.calendar_error ? (
                        <StatusChip tone="muted">Not in calendar</StatusChip>
                      ) : null}
                      {b.lead_status === "converted" ? (
                        <StatusChip tone="solid">Client</StatusChip>
                      ) : null}
                      {b.attendance === "attended" ? (
                        <StatusChip tone="solid">Attended</StatusChip>
                      ) : null}
                      {b.attendance === "no_show" ? (
                        <StatusChip tone="muted">No show</StatusChip>
                      ) : null}
                    </div>

                    {/* The enquirer's own name, not `booked_name`, when we have
                        it - booked_name is a snapshot taken at booking and the
                        submission is the record that gets corrected. */}
                    <p className="mt-1 text-sm font-medium text-text">
                      {b.enquirer_name ?? b.booked_name ?? "Name withheld"}
                    </p>

                    {b.enquirer_phone || b.enquirer_email ? (
                      <p className="mt-1 text-sm text-text-muted">
                        {/* Real links. On a phone this is the whole feature: the
                            operator taps the number instead of copying it. */}
                        {b.enquirer_phone ? (
                          <a href={`tel:${b.enquirer_phone}`} className="hover:text-text">
                            {b.enquirer_phone}
                          </a>
                        ) : null}
                        {b.enquirer_phone && b.enquirer_email ? " · " : ""}
                        {b.enquirer_email ? (
                          <a href={`mailto:${b.enquirer_email}`} className="hover:text-text">
                            {b.enquirer_email}
                          </a>
                        ) : null}
                      </p>
                    ) : (
                      // submission_id is ON DELETE SET NULL, so an erasure request
                      // detaches the person and leaves the appointment standing.
                      // Saying so beats rendering a blank row the operator cannot
                      // explain.
                      <p className="mt-1 text-sm text-text-muted">
                        Contact details were erased at the enquirer&rsquo;s request. The time is
                        still reserved.
                      </p>
                    )}

                    <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
                      {(
                        [
                          ["Business", b.business_type],
                          ["Team", b.team_size],
                          ["Budget", b.budget_inr],
                          ["CRM", b.crm_name],
                          ["Happy with CRM", b.crm_satisfied],
                        ] as const
                      )
                        .filter(([, v]) => v)
                        .map(([k, v]) => (
                          <div key={k} className="flex gap-1.5">
                            <dt className="font-medium">{k}:</dt>
                            <dd>{v}</dd>
                          </div>
                        ))}
                    </dl>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {/* Only on a call that has actually run and is unmarked.
                        Offering "Attended" on tomorrow's call invites a
                        mis-click that sends a thank-you for a conversation
                        nobody has had. */}
                    {markable ? (
                      <>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => mark(b, "attended")}
                          className="inline-flex h-9 items-center rounded-md border border-accent px-3 text-sm font-medium text-accent-text hover:bg-surface-hover disabled:opacity-60"
                        >
                          {marking === b.id ? "Saving…" : "Attended"}
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => mark(b, "no_show")}
                          className="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm font-medium text-text-muted hover:bg-surface-hover hover:text-text disabled:opacity-60"
                        >
                          Not attended
                        </button>
                      </>
                    ) : null}

                    {b.enquirer_phone ? (
                      <a
                        href={`https://wa.me/${b.enquirer_phone.replace(/\D/g, "")}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm font-medium text-text-muted hover:bg-surface-hover hover:text-text"
                      >
                        WhatsApp
                      </a>
                    ) : null}
                  </div>
                </div>

                {b.attendance && b.attendance_recorded_by ? (
                  <p className="mt-2.5 border-t border-border pt-2 text-xs text-text-muted">
                    Marked by {b.attendance_recorded_by}
                  </p>
                ) : null}

                {b.calendar_error ? (
                  <p className="mt-2.5 border-t border-border pt-2 text-xs text-text-muted">
                    <MonoLabel>Calendar</MonoLabel>{" "}
                    <span className="ml-1">{b.calendar_error}</span>
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
