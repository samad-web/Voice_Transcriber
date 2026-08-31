import { redirect } from "next/navigation";
import { markRescheduleTokenUsed, resolveRescheduleToken } from "@/lib/funnel/reschedule";
import { setRescheduleSession } from "@/lib/funnel/reschedule-session";
import { schedulerTimeZone } from "@/lib/scheduler";

/**
 * The link in a booking confirmation or a pre-call reminder.
 *
 * Exchanges a reschedule token for a short-lived signed cookie and drops the
 * person on the picker. From there nothing is special: they see the same open
 * slots the funnel offers anyone, and the swap runs under the same notice
 * window and the same busy checks a first booking does.
 *
 * ── A ROUTE HANDLER, NOT A PAGE ────────────────────────────────────────────
 *
 * It has to SET a cookie, and a Server Component cannot. A page would have to
 * render something that then posted the token back, which puts the credential
 * in the DOM - the exact thing lib/funnel/reschedule-session.ts exists to
 * avoid.
 *
 * ── WHY OPENING IT TWICE IS FINE ───────────────────────────────────────────
 *
 * `used_at` is telemetry, not a latch. WhatsApp fetches URLs to build link
 * previews, so the first GET is quite often a bot rather than the person; a
 * single-use token would be burnt before they ever tapped it. What actually
 * ends the link's usefulness is the booking no longer being held, which
 * `resolveRescheduleToken` checks on every call - and which becomes true by
 * itself the moment the call is moved, because the old slot goes back to
 * 'open'.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  const target = await resolveRescheduleToken(token, schedulerTimeZone());

  if (!target) {
    // Unknown, expired, already moved, cancelled, or erased - one destination
    // for all five. Telling a holder of a guessed token which one it was tells
    // them whether they guessed a real appointment.
    redirect("/reschedule?link=expired");
  }

  await setRescheduleSession(target.bookingSlotId, target.submissionId);
  // After the session is established, so a failure here cannot cost them the
  // thing they came to do.
  await markRescheduleTokenUsed(token);

  redirect("/reschedule");
}
