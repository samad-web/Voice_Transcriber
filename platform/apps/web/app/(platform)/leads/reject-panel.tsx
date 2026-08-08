"use client";

import { useState, useTransition } from "react";
import { BrutalButton, Input } from "@aura/ui";
import { rejectLeadAction, type Lead } from "./actions";

/**
 * Rejecting a lead, and telling them.
 *
 * ── THREE WAYS THE PERSON CAN BE TOLD, AND THEY ARE NOT EQUIVALENT ─────────
 *
 * WHATSAPP, QUEUED — THE DEFAULT since 2026-08-08, at the owner's instruction:
 * email is on hold and WhatsApp is the channel this market actually replies on.
 * It goes through Evolution API (apps/worker/src/pipeline/whatsapp.ts), which
 * drives a real WhatsApp account and can therefore send the free-form text this
 * funnel wants. Meta's official Cloud API cannot: outside a 24-hour reply
 * window it permits only pre-approved template messages. The trade is that
 * Evolution is unofficial and the account carries a ban risk if it is used like
 * a bulk sender — fine for replying to someone who contacted you first, which
 * is exactly what a rejection is.
 *
 * EMAIL — OFF by default, code path intact. Queued inside the same transaction
 * as the rejection when enabled, so the two cannot come apart. Turn it back on
 * by ticking the box; it becomes the default again when a mail provider is
 * configured and the decision is reversed.
 *
 * WHATSAPP, BY HAND — the `wa.me` link. It always works, needs no server
 * configuration, and is the honest fallback while Evolution is unconfigured. It
 * opens WhatsApp with the number and message filled in; a human presses send.
 *
 * The distinction is kept visible in the UI on purpose. An operator who thinks
 * a message went out when it is sitting in an outbox will not follow up, and
 * the person who enquired hears nothing at all.
 */
export function RejectPanel({ lead, onDone }: { lead: Lead; onDone: () => void }) {
  const [reason, setReason] = useState("");
  // Email is ON HOLD (owner, 2026-08-08). WhatsApp is the live channel.
  const [notify, setNotify] = useState(false);
  const [notifyWhatsapp, setNotifyWhatsapp] = useState(true);
  const [result, setResult] = useState<{
    queuedEmail?: boolean;
    queuedWhatsapp?: boolean;
    releasedSlots?: Array<{ id: string; startsAt: string }>;
    orphanedCalendarEvents?: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Digits only: wa.me rejects a leading + and any spacing.
  const waNumber = (lead.whatsapp_e164 || lead.phone_e164 || "").replace(/\D/g, "");
  const first = lead.name.trim().split(/\s+/)[0] || "there";
  const waText = encodeURIComponent(
    `Hi ${first}, thanks for your interest in Aura and for taking the time to tell us about ` +
      `your business. Having looked at it properly we don't think we're the right fit for you ` +
      `at the moment, so we won't take this further. If things change, do come back to us.`,
  );

  if (result) {
    return (
      <div className="mt-4 rounded-md border border-border bg-bg-subtle p-4">
        <p className="text-sm font-semibold text-text">{lead.name} was rejected.</p>
        {/* "Queued", not "sent", and the caveat is not hedging — it is the
            difference between what happened and what the operator will assume
            happened. The worker's dispatcher falls back to LogOnlyFollowUpDispatcher
            when FUNNEL_FOLLOWUP_ENDPOINT is unset, which writes the message to
            the log and marks the row sent with a `log-only:` id. Nothing
            reaches the enquirer. Telling someone their rejection email "will
            send" when it will be logged is exactly the kind of quiet
            almost-true this codebase avoids everywhere else. */}
        <p className="mt-1 text-xs text-text-muted">
          {result.queuedEmail ? (
            <>
              The rejection email is <strong className="font-medium text-text">queued</strong>. It
              leaves the outbox once a mail provider is configured
              (<code>FUNNEL_FOLLOWUP_ENDPOINT</code>); until then the worker logs it rather than
              sending it.
            </>
          ) : (
            "No email was queued — one had already been sent to this person."
          )}
        </p>

        {result.queuedWhatsapp ? (
          <p className="mt-1 text-xs text-text-muted">
            A WhatsApp message is <strong className="font-medium text-text">queued</strong> for
            Evolution to send.
          </p>
        ) : null}

        {/* Rejecting used to leave a booked call sitting in the diary — an
            appointment with someone just declined, and an hour no real prospect
            could take. The slot is handed back now, and saying so matters: the
            operator would otherwise have no way to know their Monday afternoon
            had reopened. */}
        {result.releasedSlots && result.releasedSlots.length > 0 ? (
          <p className="mt-1 text-xs text-text-muted">
            {result.releasedSlots.length === 1 ? "Their booked call" : "Their booked calls"} on{" "}
            <strong className="font-medium text-text">
              {result.releasedSlots
                .map((s) => new Date(s.startsAt).toLocaleString())
                .join(", ")}
            </strong>{" "}
            {result.releasedSlots.length === 1 ? "has" : "have"} been released and can be booked
            again.
          </p>
        ) : null}

        {/* Only reachable once Google Calendar is configured. The API cannot
            delete the event — the calendar client lives in the marketing app —
            so this is honest about what is left to do rather than leaving an
            event to outlive the booking silently. */}
        {result.orphanedCalendarEvents && result.orphanedCalendarEvents.length > 0 ? (
          <p className="mt-2 rounded-md border border-warning/40 bg-warning-subtle p-2.5 text-xs text-warning-text">
            <strong className="font-semibold">Remove the calendar event by hand.</strong> The slot
            was released here, but the Google Calendar event still exists and we cannot delete it
            from this console:{" "}
            <code>{result.orphanedCalendarEvents.join(", ")}</code>
          </p>
        ) : null}

        {waNumber ? (
          <>
            <a
              href={`https://wa.me/${waNumber}?text=${waText}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex h-10 items-center rounded-md border border-accent px-4 text-sm font-medium text-accent-text hover:bg-surface-hover"
            >
              Open WhatsApp with the message
            </a>
            <p className="mt-1.5 text-xs text-text-muted">
              Opens WhatsApp with the text ready. You still press send — we have no WhatsApp
              Business API account, and Meta does not allow free-form business-initiated messages
              without approved templates.
            </p>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-4 border-t border-border pt-4">
      <label className="flex flex-col gap-1 text-xs font-medium text-text">
        Reason (kept internal, never sent to them)
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. below minimum team size"
          maxLength={500}
        />
      </label>

      <label className="mt-3 flex items-center gap-2 text-xs text-text">
        <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
        Also send the rejection email
      </label>
      <p className="mt-1 pl-6 text-xs text-text-muted">
        On hold — no mail provider is configured, so this would be logged rather than sent.
      </p>

      <label className="mt-2 flex items-center gap-2 text-xs text-text">
        <input
          type="checkbox"
          checked={notifyWhatsapp}
          onChange={(e) => setNotifyWhatsapp(e.target.checked)}
        />
        Send the rejection over WhatsApp
      </label>
      <p className="mt-1 pl-6 text-xs text-text-muted">
        Queued for the worker to send through Evolution GO. Needs EVOLUTION_BASE_URL and
        EVOLUTION_API_KEY set; until then it is logged, not sent. The link below always works.
      </p>

      {error ? (
        <p role="alert" className="mt-3 rounded-md border border-danger/30 bg-danger/5 p-2.5 text-xs text-danger-text">
          {error}
        </p>
      ) : null}

      <BrutalButton
        className="mt-3"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const res = await rejectLeadAction({ leadId: lead.id, reason, notify, notifyWhatsapp });
            if (res.error) setError(res.error);
            else {
              setResult({
                queuedEmail: res.queuedEmail,
                queuedWhatsapp: res.queuedWhatsapp,
                releasedSlots: res.releasedSlots,
                orphanedCalendarEvents: res.orphanedCalendarEvents,
              });
              onDone();
            }
          })
        }
      >
        {pending ? "Rejecting…" : "Confirm rejection"}
      </BrutalButton>
    </div>
  );
}
