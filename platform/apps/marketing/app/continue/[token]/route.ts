import { redirect } from "next/navigation";
import { markResumeTokenUsed, resolveResumeToken } from "@/lib/funnel/resume";
import { setFunnelSession } from "@/lib/funnel/session";

/**
 * The link in a "you didn't finish" nudge.
 *
 * Exchanges a resume token for the ordinary step-1 session cookie and drops the
 * person at step 2. From there NOTHING is special: they answer the same
 * questions, `submitQualificationAction` runs the same validation, and the same
 * operator-editable criteria decide the same outcome. There is no second
 * qualification path to keep in sync, which is the whole reason this is a token
 * exchange rather than a bespoke resume form.
 *
 * ── A ROUTE HANDLER, NOT A PAGE ────────────────────────────────────────────
 *
 * It has to SET a cookie, and a Server Component cannot. A page would have to
 * render something that then posted the token back, which puts the credential
 * in the DOM — the exact thing lib/funnel/session.ts exists to avoid.
 *
 * ── WHY OPENING IT TWICE IS FINE ───────────────────────────────────────────
 *
 * `used_at` is telemetry, not a latch. WhatsApp fetches URLs to build link
 * previews, so the first GET is quite often a bot rather than the person; a
 * single-use token would be burnt before they ever tapped it. Someone who opens
 * the link, is interrupted, and comes back an hour later must also still get in.
 * What actually ends the link's usefulness is the enquiry being finished, which
 * `resolveResumeToken` checks on every call.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  const target = await resolveResumeToken(token);

  if (!target) {
    // Unknown, expired, already finished, or erased — one destination for all
    // four. Telling a holder of a guessed token which one it was tells them
    // whether they guessed a real enquiry.
    redirect("/start?link=expired");
  }

  await setFunnelSession(target.submissionId, target.historyId);
  // After the session is established, so a failure here cannot cost them the
  // thing they came to do.
  await markResumeTokenUsed(token);

  redirect("/start?resume=1");
}
