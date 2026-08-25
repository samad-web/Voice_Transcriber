import type { Metadata } from "next";
import { pageMetadata } from "@/lib/metadata";
import { getRescheduleSession } from "@/lib/funnel/reschedule-session";
import { RescheduleCard } from "./reschedule-card";

export const metadata: Metadata = pageMetadata({
  title: "Move your Aura call",
  description: "Pick a different time for the call you have booked with Aura.",
  path: "/reschedule",
  // Nothing here is useful to a search engine and the page only means anything
  // to somebody holding a link, so it is kept out of the index alongside the
  // other token-gated surfaces.
  noIndex: true,
});

/**
 * The self-serve reschedule picker.
 *
 * Reached from /reschedule/<token>, which has already verified the token and
 * set the signed cookie naming the booking. This page holds NO id of its own —
 * the picker posts only the new slot id, and the server pairs it with the
 * booking from the cookie.
 *
 * Typing this URL by hand with no cookie lands on the expired card, which is
 * the same thing a stale link produces and says the same thing.
 */
export default async function ReschedulePage() {
  const session = await getRescheduleSession();

  return (
    <div className="mk-page relative overflow-x-clip">
      <div className="mk-wash" />
      <div className="relative z-10 mx-auto max-w-xl px-5 pb-16 pt-6 sm:px-6 sm:pb-20 sm:pt-10">
        {session ? (
          <RescheduleCard />
        ) : (
          <div className="mk-card p-7 text-center sm:p-9">
            <span
              className="mx-auto mb-6 block h-1.5 w-14 rounded-full"
              style={{ background: "var(--brand-gradient)" }}
              aria-hidden="true"
            />
            <h1 className="mk-display text-2xl">This link has expired.</h1>
            <p
              className="mx-auto mt-4 max-w-md text-[0.9375rem] leading-relaxed"
              style={{ color: "var(--mk-muted)" }}
            >
              {/* Said without blame and without detail. The commonest reasons
                  are that the call was already moved or has since happened —
                  neither is a mistake they made, and naming which one would
                  tell anyone holding a guessed link whether they guessed a
                  real appointment. */}
              It may already have been used, or the call it belonged to has been moved or has
              passed. Reply to the message we sent you and we&rsquo;ll find a new time.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
