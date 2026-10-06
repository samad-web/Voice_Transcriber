"use client";

import { useRef, useState, useTransition } from "react";
import { Button, ErrorBanner, FormField, Input, StatusChip } from "@aura/ui";
import { PhoneInput } from "@/components/phone-input";
import { submitLeadAction } from "./actions";

/**
 * Screen one: send a referral (Build docs/39 §19).
 *
 * Four fields and a button. The whole point of this screen is that a broker
 * standing in front of a customer can use it on a phone in fifteen seconds, so
 * nothing is required individually and the form asks for no qualification, no
 * budget, no stage and no project - a partner who had to classify a lead would
 * classify it wrong, and the tenant's own intake rules (dedupe, routing,
 * board, source attribution) are what decide all of that anyway.
 *
 * ── THE NUMBER GOES THROUGH `PhoneInput` ───────────────────────────────────
 *
 * Not a bare text field. It starts on the WORKSPACE's country (the layout's
 * `OrgRegionProvider`), validates against that country's real lengths and
 * prefixes rather than a digit count, and calls `setCustomValidity` so this
 * form refuses to submit an unusable number. That matters more here than
 * anywhere in the console: the API derives the vault's `number_key` from these
 * digits, and a number stored under the wrong country code is a customer who
 * can never be matched to their own calls.
 *
 * ── AND WHAT IS SAID ABOUT CONSENT ─────────────────────────────────────────
 *
 * Out loud, on the form. The API stores every number from this path as
 * `consent_basis = 'unknown'` - a broker's assurance is not consent (§18) -
 * and whether it is ever dialable is the tenant's switch, not the partner's
 * claim. A portal that quietly took the number without saying so would be
 * asking a third party to make a promise on the tenant's behalf.
 */
export function SubmitLeadForm() {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, start] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  /** Bumped on every successful send; remounts the phone field - see below. */
  const [sent, setSent] = useState(0);

  return (
    <form
      ref={formRef}
      className="space-y-4"
      action={(formData) => {
        setResult(null);
        start(async () => {
          const res = await submitLeadAction(formData);
          setResult(res);
          // Cleared only on success, so a failure keeps what they typed. A
          // broker who loses a customer's number to a network blip does not
          // type it again, they give up on the portal.
          if (res.ok) {
            formRef.current?.reset();
            setSent((n) => n + 1);
          }
        });
      }}
    >
      <FormField label="Name" name="name" hint="Who the enquiry is from.">
        <Input name="name" autoComplete="off" maxLength={160} placeholder="Priya Sharma" />
      </FormField>

      <FormField label="Phone" name="phone" hint="The number the team should ring.">
        {/* `value` is required by the component and is the UNCONTROLLED
            starting point here: the field keeps its own state and posts the
            E.164 through a hidden input of the same `name`. `key` is what
            empties it after a successful send - resetting the <form> clears
            the visible input but not the component's internal state, so
            without this the last customer's number would still be sitting in
            the hidden field. */}
        <PhoneInput key={`phone-${sent}`} name="phone" value={null} />
      </FormField>

      <FormField label="Email" name="email" hint="Optional - if you have it.">
        <Input name="email" type="email" autoComplete="off" maxLength={320} placeholder="priya@example.com" />
      </FormField>

      <FormField label="What do they want?" name="note" hint="Anything that helps whoever rings them.">
        {/* A plain textarea: the kit has no multiline control, and the
            console's own note fields do the same. CONTROL_CHROME would pull
            in single-line height rules that fight a textarea. */}
        <textarea
          name="note"
          rows={4}
          maxLength={2000}
          placeholder="Looking at 2BHK in Baner, budget around 80L, free to talk after 6pm."
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:border-accent focus:ring-2 focus:ring-accent/30 focus:outline-none"
        />
      </FormField>

      {result && !result.ok ? <ErrorBanner>{result.message}</ErrorBanner> : null}
      {result?.ok ? (
        <div
          // `role="status"` so a screen reader hears the confirmation without
          // the focus moving - they are about to type the next referral.
          role="status"
          // Neutral chrome and a kit chip, not a green panel. The first draft
          // used `bg-success-subtle` + `text-success-text`, which
          // console-palette.test.ts reads - correctly - as a hand-rolled state
          // chip: the success ramp is one of four reserved state hues, and a
          // form confirming a save is not a state. The chip carries the glyph,
          // the sentence carries the meaning, and the one green thing on a
          // screen still means something.
          className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-hover p-3 text-sm leading-relaxed text-text"
        >
          <StatusChip tone="solid">Sent</StatusChip>
          <span className="min-w-0">{result.message}</span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={pending} disabled={pending}>
          {pending ? "Sending…" : "Send referral"}
        </Button>
        <p className="text-xs leading-relaxed text-text-muted">
          Only send a number when the person knows you are passing it on.
        </p>
      </div>
    </form>
  );
}
