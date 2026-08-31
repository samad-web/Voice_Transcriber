import type { Metadata } from "next";
import { getScheduler } from "@/lib/scheduler";
import { BookingConfirmed, ReachOutScreen } from "./outcome";

export const metadata: Metadata = {
  title: "Your call is booked",
  description: "Confirmation of your booked Aura intro call.",
  // A conversion screen, not content. `app/robots.ts` already disallows
  // `/start`; this page carries its own noindex rather than reaching into that
  // file, which is not this partition's to edit. Adding `/booked` to the
  // robots disallow list is a one-liner worth doing next to `/start`.
  robots: { index: false, follow: false },
};

/**
 * Read at request time, not at build time.
 *
 * `getScheduler()` reads `process.env` and the credentials are supplied by the
 * container, not by the build. Statically prerendering this page would bake
 * today's "unconfigured" answer into the HTML and keep serving it after the
 * Google project exists. Doc 16 §4 anticipates exactly this split: content
 * pages stay static, funnel routes are dynamic.
 */
export const dynamic = "force-dynamic";

/**
 * The post-booking confirmation.
 *
 * The guard is the point. This route is reachable by typing the URL, and it is
 * the one screen on the site that asserts something happened. So it refuses to
 * assert it in a build where it cannot have: with no scheduler configured, no
 * calendar event has ever been created by this application, and a "your call is
 * booked" page would be false for every single visitor who reaches it. In that
 * state it shows the contact screen instead - the same screen every other
 * unbooked path shows.
 *
 * Once the scheduler is real the guard weakens, because a direct visit still
 * renders a confirmation for someone who booked nothing. Closing that properly
 * needs a submission reference this page can verify against
 * `funnel_submissions.calendar_event_id`, which is Dev C's table; see followUps.
 * Displaying no specific time keeps today's version from being a *convincing*
 * false confirmation in the meantime.
 */
export default function BookedPage() {
  if (!getScheduler().configured) return <ReachOutScreen />;
  return <BookingConfirmed />;
}
