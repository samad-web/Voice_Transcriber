import { payResultResponse } from "@/lib/pay-result-page";

/**
 * `/pay/thanks` - Stripe Checkout's success_url (doc 26 P2). Public, no
 * sign-in, no site chrome or analytics: see lib/pay-result-page.ts. It marks
 * nothing paid; the signed Stripe webhook does that.
 */
export function GET(): Response {
  return payResultResponse("thanks");
}
