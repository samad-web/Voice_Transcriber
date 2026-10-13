import type { Metadata } from "next";
import Link from "next/link";
import { pageMetadata } from "@/lib/metadata";
import { CheckoutClient } from "./checkout-client";

/**
 * Buy Auratel, with nobody on our side involved.
 *
 * This page is the other half of `/pricing`, which has published real prices
 * since it shipped and sent every one of its buttons into a "book a call"
 * funnel. Publishing a price is the hard part and it was already done; this is
 * the button that was missing.
 *
 * Deliberately NOT indexed. It is a transaction, not a landing page - the
 * content worth ranking is on /pricing, and a checkout competing with it in
 * search results would split the signal and rank the worse page.
 */
export const metadata: Metadata = {
  ...pageMetadata({
    title: "Start your workspace",
    description:
      "Pick a plan, pay, and your Auratel workspace is created straight away. No call, no setup fee, no waiting.",
    path: "/signup",
  }),
  robots: { index: false, follow: true },
};

export default function SignupPage() {
  return (
    <main className="mk-page mx-auto max-w-2xl px-5 py-12">
      <p className="mk-eyebrow">Start now</p>
      <h1 className="mk-display mk-h2">Your workspace, in about a minute.</h1>
      <p className="mk-lede mt-3">
        Pay and it is created immediately. The sign-in link goes to your email, and you pair your
        first phone from inside. Nobody from Auratel has to do anything for this to work.
      </p>

      <div className="mt-8 rounded-2xl border p-5 sm:p-6">
        <CheckoutClient />
      </div>

      <p className="mt-6 text-sm opacity-70">
        Need more than four handsets, or a plan quoted to your volume?{" "}
        <Link href="/start" className="underline">
          Talk to us
        </Link>{" "}
        — the larger tiers are priced per workspace.
      </p>
    </main>
  );
}
