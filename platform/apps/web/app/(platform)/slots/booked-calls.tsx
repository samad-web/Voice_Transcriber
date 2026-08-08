"use client";

import { useEffect, useState, useTransition } from "react";
import { Card, MonoLabel, StatusChip } from "@aura/ui";
import { listBookingsAction, type Booking } from "./actions";

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
 * — enough to pick up the phone without opening anything else.
 */
export function BookedCalls({ initial, timeZone }: { initial: Booking[]; timeZone: string }) {
  const [bookings, setBookings] = useState(initial);
  const [days, setDays] = useState(14);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Skipped on first render — the server already fetched 14 days for the page.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (!mounted) {
      setMounted(true);
      return;
    }
    start(async () => {
      const res = await listBookingsAction(days);
      if (res.error) setError(res.error);
      else {
        setError(null);
        setBookings(res.bookings ?? []);
      }
    });
    // `days` is the only trigger; `mounted` guards the first pass.
  }, [days]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-semibold text-text">Booked calls</p>
          <p className="mt-0.5 text-xs text-text-muted">
            {bookings.length === 0
              ? `Nothing booked in the next ${days} days.`
              : `${bookings.length} booked in the next ${days} days · times in ${timeZone}`}
          </p>
        </div>

        <div className="flex items-center gap-1">
          {[7, 14, 30].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              aria-pressed={days === d}
              className={
                "h-9 rounded-md px-3 text-sm font-medium transition-colors " +
                (days === d
                  ? "bg-accent text-accent-fg"
                  : "border border-border text-text-muted hover:bg-surface-hover hover:text-text")
              }
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-3 rounded-md border border-danger/30 bg-danger/5 p-2.5 text-xs text-danger-text">
          {error}
        </p>
      ) : null}

      {pending ? <p className="mt-3 text-xs text-text-muted">Loading…</p> : null}

      {bookings.length === 0 && !pending ? (
        <p className="mt-4 text-sm text-text-muted">
          When someone books a slot from the website it appears here, with their number and
          email.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-2.5">
          {bookings.map((b) => (
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
                  </div>

                  {/* The enquirer's own name, not `booked_name`, when we have
                      it — booked_name is a snapshot taken at booking and the
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

                {b.enquirer_phone ? (
                  <a
                    href={`https://wa.me/${b.enquirer_phone.replace(/\D/g, "")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-9 shrink-0 items-center rounded-md border border-border px-3 text-sm font-medium text-text-muted hover:bg-surface-hover hover:text-text"
                  >
                    WhatsApp
                  </a>
                ) : null}
              </div>

              {b.calendar_error ? (
                <p className="mt-2.5 border-t border-border pt-2 text-xs text-text-muted">
                  <MonoLabel>Calendar</MonoLabel>{" "}
                  <span className="ml-1">{b.calendar_error}</span>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
