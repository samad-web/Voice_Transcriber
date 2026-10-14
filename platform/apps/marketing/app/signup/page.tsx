import type { Metadata } from "next";
import Link from "next/link";
import { pageMetadata } from "@/lib/metadata";
import { startHref } from "@/lib/site";
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
 *
 * ── ONE SCREEN, AND WHAT THAT COSTS (redesigned 2026-10-14) ─────────────────
 *
 * The brief for this page is that the whole transaction fits above the fold:
 * plan, details and the pay button visible together, with nothing to scroll
 * past before deciding. That is a constraint, not a style, and it is paid for
 * in content - so here is what was cut and where it went, because the next
 * person will otherwise add it back:
 *
 *   · THE THREE-STEP EXPLAINER (pay, claim your sign-in link, pair a phone by
 *     QR) is now one line under the heading. The full version belongs on
 *     `/signup/done`, which is where somebody actually needs to know what is
 *     coming, and on `/pricing`, which is the page for reading.
 *   · THE "NEED MORE HANDSETS" BLOCK is one footnote row rather than a band.
 *     It is the exit from this page, and an exit does not need a section.
 *   · NO SECOND WASH, NO FEATURE GRID, NO TESTIMONIAL. A checkout earns trust
 *     by being legible and specific about money, not by arguing again. The
 *     argument happened on the pages that got them here.
 *
 * `min-h` is deliberately NOT set on this page. Forcing the viewport height
 * would centre a short form and leave the pay button under the fold on a
 * laptop in landscape, which is the exact failure the brief is about; the page
 * is short enough that the ground reaches the footer on its own.
 *
 * Two structural fixes came with it. This page used to render its own `<main>`
 * inside `app/layout.tsx`'s `<main id="main">` - invalid, and the skip link
 * lands on the outer one - and it used Tailwind's default borders rather than
 * the `--mk-*` tokens, so on the dark theme the only page that takes money was
 * the one that looked least like the site.
 */

const TALK = startHref("signup-overflow", "signup");

export const metadata: Metadata = {
  ...pageMetadata({
    title: "Start your workspace",
    description:
      "Pick a plan, pay, and your Auratel workspace is created straight away. No call, no setup fee, no waiting.",
    path: "/signup",
  }),
  robots: { index: false, follow: true },
};

export default async function SignupPage({
  searchParams,
}: {
  /** `?plan=capture_growth&period=annual` - the tier whose button was clicked
   *  on /pricing. Validated in the client against the served catalogue, so a
   *  stale or hand-typed value falls back rather than failing. */
  searchParams: Promise<{ plan?: string; period?: string }>;
}) {
  const params = await searchParams;
  const period =
    params.period === "monthly" || params.period === "annual" ? params.period : undefined;

  return (
    <div className="mk-page relative overflow-x-clip">
      <div className="mk-wash" />
      <div className="relative z-10 mx-auto max-w-6xl px-5 pt-4 pb-10 sm:px-6 sm:pt-6">
        {/* The heading is `mk-h2`, not `mk-h1`. A hero-scale headline is four
            lines of the viewport on a laptop, and on this page those four lines
            are the pay button. The lede is held to ~62ch for the same reason:
            at the usual 56ch it wrapped to three lines and pushed the fine
            print under the fold. */}
        <p className="mk-eyebrow mb-2">Start now</p>
        <h1 className="mk-display mk-h2">
          Your workspace, <span className="mk-gradient-text">in about a minute.</span>
        </h1>
        <p className="mt-2 max-w-[62ch] text-[0.9375rem] leading-relaxed">
          Pay, and it is created in seconds. A sign-in link goes to your email, then you pair your
          first phone by scanning a QR code from inside.
        </p>

        <div className="mt-5">
          <CheckoutClient
            initialPlanKey={params.plan}
            initialPeriod={period}
            footer={
              <div
                className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t pt-3.5 text-[0.8125rem]"
                style={{ borderColor: "var(--mk-line)", color: "var(--mk-muted)" }}
              >
                <p>
                  Need more than four handsets?{" "}
                  <Link
                    href={TALK}
                    className="font-medium underline"
                    style={{ color: "var(--brand-mid)" }}
                  >
                    Talk to us
                  </Link>
                </p>
                <p>
                  <Link href="/pricing" className="underline">
                    Compare every plan and limit
                  </Link>
                </p>
              </div>
            }
          />
        </div>
      </div>
    </div>
  );
}
