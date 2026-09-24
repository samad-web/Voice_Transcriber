"use client";

import { useState, useTransition } from "react";
import { useDraftState } from "@/lib/use-server-state";
import { Button, Card, FormField, Input, MonoLabel, StatusChip, useAlert } from "@aura/ui";
import { savePaymentSettingsAction, type PaymentProvider, type PaymentSettings } from "./actions";

/**
 * What differs between the two gateways' cards: names, the field that is safe
 * to show back, and where to find each value. Stripe's `keyId` is the
 * PUBLISHABLE key - the API refuses a secret key pasted there, because that
 * field is stored in the clear and rendered back on this page.
 */
const COPY: Record<
  PaymentProvider,
  {
    name: string;
    keyIdLabel: string;
    keyIdPlaceholder: string;
    keyIdHint: string;
    secretLabel: string;
    secretHint: string;
    webhookHint: string;
    platformBlurb: string;
    ownBlurb: string;
    noPlatformBlurb: string;
  }
> = {
  razorpay: {
    name: "Razorpay",
    keyIdLabel: "Razorpay key ID",
    keyIdPlaceholder: "rzp_live_...",
    keyIdHint: "Starts with rzp_live_ or rzp_test_. Find it under API Keys in your Razorpay dashboard.",
    secretLabel: "Razorpay key secret",
    secretHint: "Shown by Razorpay once, when you generate the key.",
    webhookHint:
      "Optional, and worth setting: it is what proves a 'payment succeeded' callback really came from Razorpay before an invoice is marked paid.",
    platformBlurb:
      "Payments on your invoices are being collected through the platform's gateway and passed on to you. Add your own Razorpay keys to have them settle directly into your account.",
    ownBlurb: "Payments on your invoices settle directly into your own Razorpay account.",
    noPlatformBlurb: "Add your Razorpay keys to collect payments on your invoices through Razorpay.",
  },
  stripe: {
    name: "Stripe",
    keyIdLabel: "Stripe publishable key",
    keyIdPlaceholder: "pk_live_...",
    keyIdHint: "Starts with pk_live_ or pk_test_. Find it under Developers, API keys in your Stripe dashboard.",
    secretLabel: "Stripe secret key",
    secretHint: "Starts with sk_ (or rk_ for a restricted key). Shown by Stripe when you reveal or create it.",
    webhookHint:
      "Starts with whsec_. Without it Stripe payments are never marked paid here: the signing secret is what proves a 'payment succeeded' callback came from Stripe.",
    platformBlurb:
      "Stripe payments on your invoices go through the platform's Stripe account and are passed on to you. Add your own keys to have them settle directly into your account.",
    ownBlurb: "Stripe payments on your invoices settle directly into your own Stripe account.",
    noPlatformBlurb:
      "For customers paying from outside India. Add your Stripe keys to offer Stripe on your invoices' payment links.",
  },
};

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
  provider = "razorpay",
  platformAvailable = true,
}: {
  initial: PaymentSettings;
  /** Called after a successful save - the Integrations store's connect step moves on with it. */
  onSaved?: () => void;
  /** Which gateway this card configures. Razorpay unless said otherwise. */
  provider?: PaymentProvider;
  /**
   * Whether the platform has its own keys for this gateway. Razorpay's card has
   * always assumed so; Stripe's must not, or it would promise a fallback that
   * does not exist.
   */
  platformAvailable?: boolean;
}) {
  const copy = COPY[provider];
  const [keyId, setKeyId] = useDraftState(initial.keyId ?? "");
  const [keySecret, setKeySecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [open, setOpen] = useState(!initial.keyId);
  const [pending, startTransition] = useTransition();
  const alert = useAlert();

  const save = () => {
    startTransition(async () => {
      const result = await savePaymentSettingsAction({
        provider,
        keyId: keyId.trim(),
        keySecret: keySecret.trim() || undefined,
        webhookSecret: webhookSecret.trim() || undefined,
        enabled: true,
      });
      if (result.error) {
        await alert({
          title: `Couldn't save your ${copy.name} account`,
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
          <MonoLabel>{provider === "razorpay" ? "Payment account" : `${copy.name} account`}</MonoLabel>
          <p className="mt-2 max-w-xl text-sm text-text-muted">
            {!initial.usingPlatformGateway
              ? copy.ownBlurb
              : platformAvailable
                ? copy.platformBlurb
                : copy.noPlatformBlurb}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusChip tone={initial.usingPlatformGateway ? "outline" : "solid"}>
            {!initial.usingPlatformGateway
              ? "Your account"
              : platformAvailable
                ? "Platform gateway"
                : "Not connected"}
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
            label={copy.keyIdLabel}
            name={`${provider}-key-id`}
            required
            hint={copy.keyIdHint}
          >
            <Input
              name={`${provider}-key-id`}
              value={keyId}
              disabled={pending}
              placeholder={copy.keyIdPlaceholder}
              onChange={(e) => setKeyId(e.target.value)}
            />
          </FormField>

          <FormField
            label={copy.secretLabel}
            name={`${provider}-key-secret`}
            required={!initial.hasSecret}
            hint={
              initial.hasSecret
                ? "Stored and never shown again. Leave blank to keep the current one."
                : copy.secretHint
            }
          >
            <Input
              name={`${provider}-key-secret`}
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
            name={`${provider}-webhook-secret`}
            hint={copy.webhookHint}
          >
            <Input
              name={`${provider}-webhook-secret`}
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
              Save {copy.name} account
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
