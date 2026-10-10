"use server";

import { revalidatePath } from "next/cache";
import type { CallbackPolicy } from "@aura/shared";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders, type ActionResult } from "../../../actions";

/**
 * §10A.6's two writes, and one of them writes nothing.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  SIMULATE IS A READ, AND THAT IS THE POINT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §10A.6 step 9: "a dry run on sample transcripts showing what would be
 * scheduled, when reminders fire, and who would be escalated, WITH NOTHING
 * SENT." The API's `/simulate` opens no transaction and touches no table - it
 * runs the same pure functions the real path does. So this action is a POST
 * only because it carries a body, and it is safe to press repeatedly while an
 * owner tries different hours, which is how the step gets used.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE DRAFT POLICY IS SENT TO SIMULATE, NOT SAVED FIRST
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The wizard's step 9 previews the policy being EDITED, not the stored one.
 * "Save it and then look" would mean every experiment is live for whoever is
 * on the floor at the time.
 */

export interface SimulationOutcome {
  phrase: string;
  outcome: "scheduled" | "needs_a_person" | "not_a_callback";
  explanation: string | null;
  type?: string;
  committed?: boolean;
  needsConfirmation?: boolean;
  requestedDueAt?: string;
  dueAt?: string;
  moved?: boolean;
  movedReason?: string | null;
  onACallingDay?: boolean;
  priority?: { score: number; reasons: { factor: string; points: number }[] };
  reminders?: Array<{ kind: string; at: string; channels: string[] }>;
  escalations?: Array<{
    level: number;
    at: string;
    recipients: unknown[];
    channels: string[];
    action: string;
  }>;
}

export interface SimulationResult extends ActionResult {
  timeZone?: string;
  reference?: string;
  results?: SimulationOutcome[];
}

export async function simulateCallbackPolicy(
  phrases: string[],
  policy: CallbackPolicy,
): Promise<SimulationResult> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in." };

  try {
    const response = await fetch(`${API_URL}/v1/callbacks/simulate`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ phrases, policy }),
      cache: "no-store",
    });
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      return { error: (payload?.message as string) ?? "That did not work. Try again." };
    }
    return {
      timeZone: payload?.timeZone as string,
      reference: payload?.reference as string,
      results: payload?.results as SimulationOutcome[],
    };
  } catch {
    return { error: "API unreachable" };
  }
}

export interface SavePolicyResult extends ActionResult {
  /** How many open call-backs were moved into the new rules, if asked. */
  reapplied?: number;
}

/**
 * §10A.6 step 10's Confirm.
 *
 * The API's refusals are passed through: its cross-field rules (a ladder that
 * climbs, hours that end after they start, retries that do not get shorter)
 * are stated as sentences an owner can act on, and the wizard cannot express
 * all of them in its controls.
 */
export async function saveCallbackPolicy(input: {
  policy: CallbackPolicy;
  reapplyToOpen: boolean;
  reason: string | null;
}): Promise<SavePolicyResult> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in." };

  try {
    const response = await fetch(`${API_URL}/v1/callbacks/policy`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        ...input.policy,
        reapplyToOpen: input.reapplyToOpen,
        reason: input.reason,
      }),
      cache: "no-store",
    });
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      return { error: (payload?.message as string) ?? "That did not work. Try again." };
    }
    revalidatePath("/owner/settings/transcript-agent/callbacks");
    // The list the rules govern. A changed grace period moves what counts as
    // overdue, so the sections on screen would otherwise be the old ones.
    revalidatePath("/owner/callbacks");
    return { reapplied: (payload?.reapplied as number) ?? 0 };
  } catch {
    return { error: "API unreachable" };
  }
}
