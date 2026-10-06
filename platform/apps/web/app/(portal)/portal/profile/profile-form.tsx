"use client";

import { useState, useTransition } from "react";
import { Button, ErrorBanner, FormField, Input } from "@aura/ui";
import { updatePortalProfileAction } from "../actions";

/**
 * The one editable thing in the portal: the signed-in person's own display
 * name.
 *
 * Their email is not editable - it is bound to the Google identity the invite
 * was accepted with, and letting it drift would break the only link between
 * this login and the person the tenant invited. Nothing about the PARTNER is
 * editable either: name, kind, referral code, status and commission plan are
 * the tenant's record of a commercial relationship, and a broker who could
 * flip their own status to 'active' would be editing the other side's
 * contract. The API refuses all of it; this form simply does not offer it.
 */
export function ProfileForm({ name }: { name: string }) {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      className="space-y-4"
      action={(formData) => {
        setResult(null);
        start(async () => setResult(await updatePortalProfileAction(formData)));
      }}
    >
      <FormField label="Your name" name="name" hint="How you appear to the team when you send a referral.">
        <Input name="name" defaultValue={name} maxLength={160} required autoComplete="name" />
      </FormField>

      {result && !result.ok ? <ErrorBanner>{result.message}</ErrorBanner> : null}
      {result?.ok ? (
        <p role="status" className="text-sm text-success-text">
          {result.message}
        </p>
      ) : null}

      <Button type="submit" loading={pending} disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
