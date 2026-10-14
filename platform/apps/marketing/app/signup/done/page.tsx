import type { Metadata } from "next";
import { DoneClient } from "./done-client";

/**
 * Where Razorpay sends the buyer after a successful payment.
 *
 * Never indexed: it is a per-purchase URL carrying a reference, and the only
 * thing on it is the status of one person's order.
 */
export const metadata: Metadata = {
  title: "Setting up your workspace",
  robots: { index: false, follow: false },
};

export default async function SignupDonePage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string; pending?: string }>;
}) {
  const params = await searchParams;
  const claimRef = params.ref ?? "";
  const pending = params.pending === "1";

  // A `<div>`, not a `<main>`: `app/layout.tsx` already wraps every page in
  // `<main id="main">`, and nesting a second one is invalid and leaves the skip
  // link pointing at the outer element. The wash and the card come from
  // `brand.css` for the same reason the checkout does - this is the screen
  // somebody judges a payment by, and it should look like the site they just
  // paid.
  return (
    <div className="mk-page relative overflow-x-clip">
      <div className="mk-wash" />
      <div className="relative z-10 mx-auto max-w-2xl px-5 py-12 sm:px-6 sm:py-16">
        <p className="mk-eyebrow">Thank you</p>
        <DoneClient claimRef={claimRef} pending={pending} />
        <p className="mt-6 text-sm" style={{ color: "var(--mk-muted)" }}>
          Keep this page&apos;s email handy — it is the address your workspace sign-in belongs to.
        </p>
      </div>
    </div>
  );
}
