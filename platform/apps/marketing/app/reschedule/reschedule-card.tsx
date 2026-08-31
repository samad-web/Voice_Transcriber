"use client";

import { useEffect, useState, useTransition } from "react";
import type { OpenSlot } from "@/lib/funnel/slots";
import { listRescheduleSlotsAction, rescheduleToSlotAction } from "./actions";

/**
 * The reschedule picker.
 *
 * Deliberately the same shape as `SlotPicker` in ../start/funnel-form.tsx, and
 * the same absolute rule: it renders NOTHING until it knows there are real
 * slots. The list is fetched after the card paints, and while it is loading -
 * and if it comes back empty - the visitor is told to reply to the message
 * instead. Doc 16 §0.4: a time that is not genuinely bookable must never
 * appear, so the honest fallback is the default state and the calendar is what
 * has to prove itself.
 *
 * It is NOT shared with that component, and that is a deliberate call rather
 * than an oversight: the two differ in what they render before the list arrives
 * (nothing vs. a whole outcome screen), in what a failure means (pick another
 * vs. your link died), and in what happens after success. Factoring them
 * together would produce one component with two modes and a prop for every
 * difference, which is harder to read than two that each do one thing.
 */
export function RescheduleCard() {
  const [slots, setSlots] = useState<OpenSlot[] | null>(null);
  const [moved, setMoved] = useState<{
    dayLabel: string;
    timeLabel: string;
    meetingUrl: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Terminal: the link is spent and no slot on this page can work. */
  const [expired, setExpired] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    void listRescheduleSlotsAction().then((r) => {
      if (live) setSlots(r.slots);
    });
    return () => {
      live = false;
    };
  }, []);

  if (moved) {
    return (
      <div className="mk-card p-7 text-center sm:p-9">
        <span
          className="mx-auto mb-6 block h-1.5 w-14 rounded-full"
          style={{ background: "var(--brand-gradient)" }}
          aria-hidden="true"
        />
        <h1 className="mk-display text-2xl">Moved. You&rsquo;re booked for a new time.</h1>
        <p className="mt-4 text-[0.9375rem]">
          {moved.dayLabel} at {moved.timeLabel}
        </p>
        <p className="mx-auto mt-3 max-w-md text-[0.9375rem] leading-relaxed" style={{ color: "var(--mk-muted)" }}>
          We&rsquo;ve cancelled the old time and sent you a fresh confirmation.
        </p>

        {/* Only when Google actually returned a link. Rendering a "Join" button
            that goes nowhere is worse than not offering one. */}
        {moved.meetingUrl ? (
          <p className="mt-4 text-sm">
            <a
              href={moved.meetingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold underline underline-offset-2"
            >
              Join on Google Meet
            </a>{" "}
            <span style={{ color: "var(--mk-muted)" }}>(the same link is in your invite)</span>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mk-card p-7 sm:p-9">
      <h1 className="mk-display text-2xl">Pick a new time.</h1>
      <p className="mt-3 text-[0.9375rem] leading-relaxed" style={{ color: "var(--mk-muted)" }}>
        Choosing one below releases your current slot and books the new one. Nothing else changes.
      </p>

      {error ? (
        <p role="alert" className="mt-5 rounded-xl px-4 py-3 text-sm" style={alertStyle}>
          {error}
        </p>
      ) : null}

      {/* A dead end otherwise: the visitor is told the link is spent and left
          staring at buttons that will each fail identically. */}
      {expired ? (
        <div className="mt-5 rounded-xl border p-4 text-sm" style={{ borderColor: "var(--mk-line)" }}>
          <p style={{ color: "var(--mk-ink)" }}>
            Reply to the message we sent you and we&rsquo;ll find a new time by hand. Your original
            booking has not been changed.
          </p>
        </div>
      ) : null}

      {!expired && slots !== null && slots.length === 0 ? (
        <p className="mt-5 text-[0.9375rem]" style={{ color: "var(--mk-muted)" }}>
          There are no other times open at the moment. Reply to the message we sent you and
          we&rsquo;ll sort one out.
        </p>
      ) : null}

      {!expired && slots && slots.length > 0 ? <Picker /> : null}
    </div>
  );

  function Picker() {
    // Grouped by day so a list of times reads as a diary rather than a queue.
    const days = [...new Set(slots!.map((s) => s.dayLabel))];

    return (
      <div className="mt-6">
        {days.map((day) => (
          <div key={day} className="mb-4">
            <p
              className="mb-2 text-xs font-semibold uppercase tracking-widest"
              style={{ color: "var(--mk-muted)" }}
            >
              {day}
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {slots!
                .filter((s) => s.dayLabel === day)
                .map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      start(async () => {
                        const res = await rescheduleToSlotAction(s.id);
                        if (res.ok) {
                          setError(null);
                          setMoved({
                            dayLabel: res.dayLabel!,
                            timeLabel: res.timeLabel!,
                            meetingUrl: res.meetingUrl ?? null,
                          });
                        } else if (res.sessionExpired) {
                          // Terminal for this page: every slot here will fail
                          // the same way, so re-fetching would only offer a
                          // fresh set of buttons that cannot work either.
                          setExpired(true);
                          setError(res.error ?? "This link has expired.");
                        } else {
                          setError(res.error ?? "That time is no longer available.");
                          // Whatever went is gone, and showing it again invites
                          // a second failure on the same button.
                          void listRescheduleSlotsAction().then((r) => setSlots(r.slots));
                        }
                      })
                    }
                    className="flex min-h-11 w-full items-center justify-center rounded-xl border text-sm font-medium transition-colors disabled:opacity-60"
                    style={{ borderColor: "var(--mk-line)", color: "var(--brand-mid)" }}
                  >
                    {s.timeLabel}
                  </button>
                ))}
            </div>
          </div>
        ))}

        <p className="mt-1 text-xs" style={{ color: "var(--mk-muted)" }}>
          {slots![0]!.durationMinutes} minutes. Times shown in India Standard Time.
        </p>
      </div>
    );
  }
}

const alertStyle: React.CSSProperties = {
  background: "color-mix(in srgb, #c22b2b 8%, transparent)",
  border: "1px solid color-mix(in srgb, #c22b2b 30%, transparent)",
  color: "#c22b2b",
};
