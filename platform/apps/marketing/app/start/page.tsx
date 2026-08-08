import type { Metadata } from "next";
import { pageMetadata } from "@/lib/metadata";
import { FunnelForm } from "./funnel-form";

export const metadata: Metadata = pageMetadata({
  title: "Get started with Aura",
  description:
    "Tell us how your team sells today and we'll show you what Aura would have picked up " +
    "from last week's calls.",
  path: "/start",
});

/**
 * The single conversion target for the whole site.
 *
 * THE FORM COMES FIRST IN THE DOM, and that is the point of the ordering below.
 * A visitor landing here has already decided to start; making them scroll past
 * a headline and three reassurance bullets to find the field they came to fill
 * in costs conversions for nothing. On a phone the form is now the first thing
 * under the header, with no scroll required to reach it.
 *
 * `lg:order-last` puts it back on the right from 1024px up, where the two
 * columns sit side by side and "first" and "second" stop meaning anything
 * vertically. So the desktop composition is unchanged and only the phone
 * ordering is fixed — one CSS property rather than two layouts.
 *
 * The reassurance list stays: the page asks a stranger for a phone number, and
 * what-happens-next and who-sees-this deserve answering. It just no longer
 * stands between them and the form.
 */
export default function StartPage() {
  return (
    <div className="mk-page relative overflow-x-clip">
      <div className="mk-wash" />
      {/* Top padding is deliberately small and asymmetric. It was `py-6 sm:py-12
          lg:py-16`, which on a desktop put 4rem of empty ground under a 64px
          sticky header before the form began — the card started roughly a
          seventh of the way down the viewport, so the page opened on whitespace
          rather than on the thing the visitor came to do.

          Bottom padding is left generous: it is the end of the page and the
          form needs room to breathe above the fold's edge, particularly once
          step 2 grows the card. */}
      <div className="relative z-10 mx-auto grid max-w-5xl items-start gap-8 px-5 pb-12 pt-4 sm:gap-12 sm:px-6 sm:pb-16 sm:pt-6 lg:grid-cols-[1fr_0.95fr] lg:pb-20 lg:pt-8">
        <FunnelForm />

        <div className="lg:order-first">
          <h1 className="mk-display text-[clamp(1.5rem,4.5vw,3rem)]">
            Find out what your calls have been saying.
          </h1>
          <p className="mk-lede mt-3 sm:mt-5">
            We&rsquo;ll come back to you with what Aura would have picked up from a
            week of your team&rsquo;s calls, and we&rsquo;ll tell you honestly if it isn&rsquo;t
            a fit.
          </p>

          <ul className="mt-5 space-y-3 sm:mt-9 sm:space-y-4">
            {[
              ["Nothing to install", "There is nothing to set up to have this conversation."],
              ["Your details stay with us", "We don't sell or share them. Ever."],
              ["A real person replies", "Not a sequence of automated emails."],
            ].map(([t, d]) => (
              <li key={t} className="flex gap-3">
                <span
                  className="mt-2 h-1.5 w-1.5 flex-none rounded-full"
                  style={{ background: "var(--brand-gradient)" }}
                  aria-hidden="true"
                />
                <span className="text-[0.9375rem]">
                  <strong className="font-semibold">{t}.</strong>{" "}
                  <span style={{ color: "var(--mk-muted)" }}>{d}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
