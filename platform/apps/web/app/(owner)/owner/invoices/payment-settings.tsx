"use client";

import { useState, useTransition } from "react";
import { useDraftState } from "@/lib/use-server-state";
import { Button, Card, FormField, Input, MonoLabel, StatusChip, useAlert } from "@aura/ui";
import { savePaymentSettingsAction, type PaymentSettings } from "./actions";

/**
 * "Connect your payment account" - the client's own Razorpay keys.
 *
 * ── WHY IT LEADS WITH WHAT IS TRUE TODAY ──────────────────────────────────
 *
 * A client with no keys is not broken: migration 0060 falls back to the
 * platform's gateway, so their payment links already work and the money
 * settles to us and is passed on. The honest framing is therefore "where
 * should this money land" and not "payments are not set up" - the second
 * reads as a fault, and a client chasing a fault that does not exist is a
 * support ticket we caused.
 *
 * ── THE SECRET IS WRITE-ONLY ──────────────────────────────────────────────
 *
 * The API never returns it, so the field is always blank and an empty field on
 * save means "keep the stored one". That is what lets somebody fix a typo in
 * the key id without going back to Razorpay for the secret, and it is why the
 * placeholder says so rather than leaving them guessing whether blank wipes it.
 */
export function PaymentSettingsCard({
  initial,
  onSaved,
}: {
  initial: PaymentSettings;
  /** Called after a successful save - the Integrations store's connect step moves on with it. */
  onSaved?: () => void;
}) {
  const [keyId, setKeyId] = useDraftState(initial.keyId ?? "");
  const [keySecret, setKeySecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [open, setOpen] = useState(!initial.keyId);
  const [pending, startTransition] = useTransition();
  const alert = useAlert();

  const save = () => {
    startTransition(async () => {
      const result = await savePaymentSettingsAction({
        keyId: keyId.trim(),
        keySecret: keySecret.trim() || undefined,
        webhookSecret: webhookSecret.trim() || undefined,
        enabled: true,
      });
      if (result.error) {
        await alert({
          title: "Couldn't save your payment account",
          body: result.error,
          tone: "danger",
        });
        return;
      }
      // Cleared rather than kept: leaving a secret sitting in a form field
      // after it has been stored is the same disclosure the read path avoids.
      setKeySecret("");
      setWebhookSecret("");
      setOpen(false);
      onSaved?.();
    });
  };

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <MonoLabel>Payment account</MonoLabel>
          <p className="mt-2 max-w-xl text-sm text-text-muted">
            {initial.usingPlatformGateway
              ? "Payments on your invoices are being collected through the platform's gateway and passed on to you. Add your own Razorpay keys to have them settle directly into your account."
              : "Payments on your invoices settle directly into your own Razorpay account."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusChip tone={initial.usingPlatformGateway ? "outline" : "solid"}>
            {initial.usingPlatformGateway ? "Platform gateway" : "Your account"}
          </StatusChip>
          {!open && (
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)} disabled={pending}>
              {initial.keyId ? "Change" : "Connect"}
            </Button>
          )}
        </div>
      </div>

      {open && (
        <div className="mt-4 space-y-4">
          <FormField
            label="Razorpay key ID"
            name="rzp-key-id"
            required
            hint="Starts with rzp_live_ or rzp_test_. Find it under API Keys in your Razorpay dashboard."
          >
            <Input
              name="rzp-key-id"
              value={keyId}
              disabled={pending}
              placeholder="rzp_live_..."
              onChange={(e) => setKeyId(e.target.value)}
            />
          </FormField>

          <FormField
            label="Razorpay key secret"
            name="rzp-key-secret"
            required={!initial.hasSecret}
            hint={
              initial.hasSecret
                ? "Stored and never shown again. Leave blank to keep the current one."
                : "Shown by Razorpay once, when you generate the key."
            }
          >
            <Input
              name="rzp-key-secret"
              type="password"
              autoComplete="new-password"
              value={keySecret}
              disabled={pending}
              placeholder={initial.hasSecret ? "Unchanged" : ""}
              onChange={(e) => setKeySecret(e.target.value)}
            />
          </FormField>

          <FormField
            label="Webhook secret"
            name="rzp-webhook-secret"
            hint="Optional, and worth setting: it is what proves a 'payment succeeded' callback really came from Razorpay before an invoice is marked paid."
          >
            <Input
              name="rzp-webhook-secret"
              type="password"
              autoComplete="new-password"
              value={webhookSecret}
              disabled={pending}
              placeholder={initial.hasWebhookSecret ? "Unchanged" : ""}
              onChange={(e) => setWebhookSecret(e.target.value)}
            />
          </FormField>

          <div className="flex gap-2">
            <Button onClick={save} disabled={pending || keyId.trim().length < 8}>
              Save payment account
            </Button>
            {initial.keyId && (
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
