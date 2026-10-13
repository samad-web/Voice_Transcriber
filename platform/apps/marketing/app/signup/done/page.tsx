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

  return (
    <main className="mk-page mx-auto max-w-2xl px-5 py-12">
      <p className="mk-eyebrow">Thank you</p>
      <DoneClient claimRef={claimRef} pending={pending} />
      <p className="mt-6 text-sm opacity-70">
        Keep this page&apos;s email handy — it is the address your workspace sign-in belongs to.
      </p>
    </main>
  );
}
