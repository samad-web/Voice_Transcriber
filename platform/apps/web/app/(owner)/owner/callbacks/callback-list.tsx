"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { AlertTriangle, Clock, MessageCircle, Phone, PhoneOff } from "lucide-react";
import { Button, Card, Select, StatusChip } from "@aura/ui";
import { formatTime, formatWeekdayDate } from "@aura/shared";
import type { CallbackSection } from "@aura/shared";
import type { CallbackRow } from "./page";
import { completeCallback, recordAttempt, snoozeCallback } from "./actions";

/**
 * §10A.3's list rows and their quick actions.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE CUSTOMER'S OWN WORDS ARE ON EVERY ROW
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §10A.3: "each item shows the customer, phone, reason and call summary, THE
 * CUSTOMER'S QUOTE WITH AN AUDIO JUMP LINK, requested time, attempts so far."
 *
 * The quote is the most important thing on the row and it is not decoration. A
 * telecaller ringing somebody because a machine said to is in a weaker position
 * than one who can see the sentence - and if the reading was wrong, the quote
 * is how they find out before they dial rather than during the call.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY "MOVED" AND "NEEDS CONFIRMING" ARE SHOWN, NOT HIDDEN
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §10A.3 requires a moved callback to be "FLAGGED to the telecaller". A
 * callback silently clamped into calling hours is somebody ringing at an hour
 * the customer did not agree to with no idea that is what they are doing - so
 * the original time and the reason are both on the row.
 *
 * `needs_confirmation` is the same idea for a vague request: the time came
 * from the owner's default rule, not from the customer, and the person dialling
 * should know which.
 */

export function CallbackList({
  items,
  section,
  timeZone,
  snoozeOptionsMinutes,
}: {
  items: readonly CallbackRow[];
  section: CallbackSection;
  timeZone: string;
  snoozeOptionsMinutes: readonly number[];
}) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <li key={item.id}>
          <CallbackCard
            item={item}
            section={section}
            timeZone={timeZone}
            snoozeOptionsMinutes={snoozeOptionsMinutes}
          />
        </li>
      ))}
    </ul>
  );
}

function CallbackCard({
  item,
  section,
  timeZone,
  snoozeOptionsMinutes,
}: {
  item: CallbackRow;
  section: CallbackSection;
  timeZone: string;
  snoozeOptionsMinutes: readonly number[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState("reached");

  const who = item.contact_name?.trim() || item.lead_name?.trim() || "Unnamed customer";
  const run = (action: () => Promise<{ error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.error) setError(result.error);
    });
  };

  return (
    <Card>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{who}</span>
              {item.contact_phone_last3 ? (
                <span className="text-sm text-[var(--muted-foreground)]">
                  …{item.contact_phone_last3}
                </span>
              ) : null}
              {/* `StatusChip`, not `StateChip`.
                  
                  `StateChip` is for CALL states and its red means MISSED and
                  only missed (state.tsx's functional colour rule). "They gave
                  this time" is a category, not a state, so it takes a grey
                  chip - and the WORDS carry the meaning, because colour alone
                  is not an accessible signal. */}
              {item.committed ? (
                <StatusChip tone="solid">They gave this time</StatusChip>
              ) : (
                <StatusChip tone="outline">No time given</StatusChip>
              )}
              {item.temperature === "hot" ? <StatusChip tone="muted">Hot</StatusChip> : null}
              {item.attempts > 0 ? (
                <StatusChip tone="muted">
                  Tried {item.attempts} of {item.max_attempts}
                </StatusChip>
              ) : null}
            </div>

            <p className="mt-1 flex items-center gap-1.5 text-sm">
              <Clock className="size-3.5 shrink-0" aria-hidden />
              <span className={section === "overdue" ? "font-semibold" : undefined}>
                {formatWeekdayDate(item.due_at, timeZone)} at {formatTime(item.due_at, timeZone)}
              </span>
              {item.window_end && item.window_start !== item.window_end ? (
                <span className="text-[var(--muted-foreground)]">
                  (any time to {formatTime(item.window_end, timeZone)})
                </span>
              ) : null}
            </p>

            {/* §10A.3's quote. The audio jump is a link to the call, which
                carries its own gates - the player is behind `call_intel` and
                `recordings_listen`, so this is a link and not an embed. */}
            {item.requested_text ? (
              <p className="mt-2 flex items-start gap-1.5 text-sm text-[var(--muted-foreground)]">
                <MessageCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  &ldquo;{item.requested_text}&rdquo;
                  {item.source_call_id ? (
                    <>
                      {" "}
                      <Link
                        href={`/owner/calls/${item.source_call_id}`}
                        className="underline underline-offset-2"
                      >
                        hear the call
                      </Link>
                    </>
                  ) : null}
                </span>
              </p>
            ) : null}

            {item.condition_text ? (
              <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                They are waiting on something: &ldquo;{item.condition_text}&rdquo;
              </p>
            ) : null}

            {/* §10A.3's flag. Both halves: what they asked for, and why it moved. */}
            {item.moved_reason ? (
              <p className="mt-2 flex items-start gap-1.5 text-sm text-[var(--warn-foreground,var(--muted-foreground))]">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  {item.requested_due_at ? (
                    <>
                      They asked for {formatTime(item.requested_due_at, timeZone)} on{" "}
                      {formatWeekdayDate(item.requested_due_at, timeZone)} —{" "}
                    </>
                  ) : null}
                  {item.moved_reason}
                </span>
              </p>
            ) : null}

            {item.needs_confirmation ? (
              <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                They did not give a time, so this one came from your workspace&rsquo;s default.
                Worth confirming on the call.
              </p>
            ) : null}
          </div>

          {item.lead_id ? (
            <Link
              href={`/owner/leads/${item.lead_id}`}
              className="shrink-0 text-sm underline underline-offset-2"
            >
              Open the lead
            </Link>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* "Call now" is a LINK to the lead, where the number is revealed
              through its own `contact_number:view` route. Not a button here:
              revealing a customer's real number is the most sensitive single
              read in the product and it is audited where it happens. */}
          {item.lead_id ? (
            <Link
              href={`/owner/leads/${item.lead_id}`}
              className="inline-flex items-center gap-1.5 rounded-md bg-text px-3 py-1.5 text-sm font-medium text-bg"
            >
              <Phone className="size-3.5" aria-hidden /> Call now
            </Link>
          ) : null}

          <label className="flex items-center gap-1.5 text-sm">
            <span className="sr-only">Snooze for</span>
            <Select
              aria-label="Snooze for"
              defaultValue=""
              disabled={pending}
              onChange={(event) => {
                const minutes = Number(event.currentTarget.value);
                if (!minutes) return;
                run(() => snoozeCallback(item.id, minutes));
                event.currentTarget.value = "";
              }}
            >
              <option value="">Snooze…</option>
              {snoozeOptionsMinutes.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes} min
                </option>
              ))}
            </Select>
          </label>

          <label className="flex items-center gap-1.5 text-sm">
            <span className="sr-only">Outcome</span>
            <Select
              aria-label="Outcome"
              value={outcome}
              disabled={pending}
              onChange={(event) => setOutcome(event.currentTarget.value)}
            >
              <option value="reached">Reached them</option>
              <option value="interested">Still interested</option>
              <option value="not_interested">Not interested</option>
              <option value="converted">Converted</option>
            </Select>
          </label>

          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => run(() => completeCallback(item.id, outcome))}
          >
            Done
          </Button>

          {/* §10A.5: this is an ATTEMPT, not a miss. The copy says so, because
              a telecaller who thinks "Can't reach" counts against them will
              stop pressing it - and then the retry rules never run. */}
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => run(() => recordAttempt(item.id))}
          >
            <PhoneOff className="size-3.5" aria-hidden /> No answer
          </Button>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-[var(--destructive)]">
            {error}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
