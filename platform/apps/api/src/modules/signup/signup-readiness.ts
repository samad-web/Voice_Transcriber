import { ServiceUnavailableException } from "@nestjs/common";

/**
 * SHOULD A STRANGER BE ABLE TO BUY THIS RIGHT NOW? (doc 49 P9 step 5)
 *
 * ── THE LINE THIS ENFORCES ──────────────────────────────────────────────────
 *
 * Doc 49 calls it "the single most important line in this document after P1
 * itself":
 *
 *   "Decide when signups go live. They are off today. They should stay off
 *    until P1 and P2 are done - self-serve onboarding into a pipeline that
 *    transcribes 4% of calls generates refunds and reviews, not revenue."
 *
 * A dependency like that, written in a plan, is a thing somebody has to
 * remember on the day they are excited about taking the first unattended
 * payment. This makes it mechanical instead.
 *
 * ── WHY "OFF" NEEDED A SWITCH AT ALL ────────────────────────────────────────
 *
 * It did not have one. Self-serve was "off" only in the sense that no Razorpay
 * keys were configured - and `resolvePlatformGateway` treats absent keys as
 * `manual`, which is a complete, working path: the signup row is written and
 * the buyer is told we will invoice them. So the public checkout was in fact
 * LIVE, in manual mode, the moment the route shipped. That is a reasonable way
 * to sell the first twenty accounts, and it is not the same thing as "off", and
 * the difference should not depend on which env var somebody notices first.
 *
 * ── THE TWO CONDITIONS ──────────────────────────────────────────────────────
 *
 * 1. `PUBLIC_SIGNUPS_ENABLED` must be explicitly true. Default off, so a
 *    deployment that has not made the decision has not accidentally made it.
 *
 * 2. The pipeline must be able to do the job. Checked at request time, not at
 *    boot: a vendor account that empties at 2am would otherwise keep selling a
 *    product that stopped working at 2am. `asrUsable` comes from
 *    `asr_provider_health` (0202) - the same table the router and the alerts
 *    read - so there is one answer to "does transcription work" rather than
 *    three.
 *
 * The second condition is the one that would have mattered. Between
 * 2026-08-13 and 2026-10-14 this deployment transcribed 12.6% of its calls; a
 * stranger buying a transcription product in that window would have been owed
 * a refund and would have left a review first.
 *
 * ── WHAT IT DELIBERATELY DOES NOT BLOCK ─────────────────────────────────────
 *
 * The price list, the catalogue read, and the claim flow for a signup that has
 * ALREADY been paid for. Somebody who has paid must always be able to finish:
 * refusing them is worse than never having taken the money, and the money is
 * already taken. Only the step that CREATES a new obligation is gated.
 */

export interface SignupReadiness {
  /** The explicit operator decision. */
  switchedOn: boolean;
  /** Whether any ASR provider is usable right now (0202). Null = unknown. */
  asrUsable: boolean | null;
  /** Null when a stranger may buy; otherwise why not, operator-facing. */
  blockedBecause: string | null;
}

export function signupsSwitchedOn(): boolean {
  const raw = process.env.PUBLIC_SIGNUPS_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * @param asrUsable  From `asr_provider_health`: true when at least one provider
 *                   is not parked. Pass null when it could not be read - and
 *                   note that null ALLOWS, deliberately. A blip on a
 *                   bookkeeping query must not close the shop; the switch is
 *                   the control, and this is the safety catch behind it.
 */
export function signupReadiness(asrUsable: boolean | null): SignupReadiness {
  const switchedOn = signupsSwitchedOn();
  let blockedBecause: string | null = null;

  if (!switchedOn) {
    blockedBecause =
      "PUBLIC_SIGNUPS_ENABLED is not set. Self-serve checkout is off by default until " +
      "somebody decides it is on - see doc 49 P9.";
  } else if (asrUsable === false) {
    blockedBecause =
      "no ASR provider is usable right now, so a new customer would be buying a " +
      "transcription product that cannot transcribe. Check asr_provider_health.";
  }

  return { switchedOn, asrUsable, blockedBecause };
}

/**
 * The message a buyer sees. Deliberately the same for both reasons.
 *
 * A stranger must not be able to tell "we have not launched" from "our speech
 * vendor is out of credit": the second is an operational fact about us that a
 * public endpoint has no business publishing, and both mean the same thing to
 * them. The operator reason goes to the log and to /v1/admin/health.
 */
export function assertSignupsOpen(readiness: SignupReadiness): void {
  if (!readiness.blockedBecause) return;
  console.warn(`public signup refused: ${readiness.blockedBecause}`);
  throw new ServiceUnavailableException(
    "Self-serve sign-up is not open at the moment. Email us and we will set your " +
      "workspace up by hand today.",
  );
}
