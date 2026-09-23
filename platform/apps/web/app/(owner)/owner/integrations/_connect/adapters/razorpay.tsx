"use client";

import type { PaymentSettings } from "../../../invoices/actions";
import { PaymentSettingsCard } from "../../../invoices/payment-settings";
import type { StepProps } from "../types";

/** What an organisation with no gateway row reads as: the platform's gateway, nothing of its own. */
const NOTHING_SAVED: PaymentSettings = {
  keyId: null,
  hasSecret: false,
  hasWebhookSecret: false,
  enabled: true,
  usingPlatformGateway: true,
};

/**
 * Razorpay: the Invoices page's own payment-account card, hosted. Saving moves
 * the flow on. There is no live check yet - Razorpay's keys are proved by the
 * first payment link - so the plan goes straight to Done (doc 28 §11.2).
 */
export function RazorpayAuth({ data, next }: StepProps) {
  return <PaymentSettingsCard initial={data.payments ?? NOTHING_SAVED} onSaved={() => next()} />;
}
