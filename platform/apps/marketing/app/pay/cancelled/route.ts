import { payResultResponse } from "@/lib/pay-result-page";

/**
 * `/pay/cancelled` - Stripe Checkout's cancel_url (doc 26 P3). Public, no
 * sign-in, no site chrome or analytics: see lib/pay-result-page.ts.
 */
export function GET(): Response {
  return payResultResponse("cancelled");
}
