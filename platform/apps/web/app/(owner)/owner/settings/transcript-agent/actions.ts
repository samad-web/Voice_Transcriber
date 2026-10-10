"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders, type ActionResult } from "../../actions";

/**
 * §3A.8's writes, as server actions.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  EVERY ONE RE-RESOLVES THE OWNER
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `ownerHeaders()` reads the session. A server action is a public endpoint, so
 * nothing about WHO is acting may come from the page - only WHAT they want
 * does. The API then applies `OwnerRoleGuard` on top, which is the gate that
 * actually refuses a manager.
 *
 * ── THE API'S OWN MESSAGE IS RETURNED, NOT A GENERIC ONE ────────────────
 *
 * These endpoints refuse for reasons an owner has to act on: consent not yet
 * acknowledged, an accuracy gate not met, a notice superseded. Each carries a
 * `code` and a sentence written for a person; replacing them with "that did
 * not work" would throw away the only useful part.
 */

interface ApiRefusal {
  code?: string;
  message?: string;
  noticeVersion?: string;
  reviewedCases?: number;
  precision?: number | null;
}

export interface GateActionResult extends ActionResult {
  code?: string;
  /** §3A.5's "states exactly what will happen", as counts from the API. */
  consequences?: {
    pendingReviewFrozen: number;
    runsHeld: number;
    callbacksConvertedToTasks: number;
    alreadyCreatedKept: number;
  } | null;
  /** Surfaced rather than silent when a per-user mode was clamped (§3A.1). */
  clampedToOrgMaximum?: string | null;
}

async function send(
  path: string,
  method: "PUT" | "POST",
  body: unknown,
): Promise<GateActionResult> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in." };

  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as
    | (ApiRefusal & Record<string, unknown>)
    | null;

  if (!response.ok) {
    return {
      error: payload?.message ?? "That did not work. Try again.",
      code: payload?.code,
    };
  }

  // Both pages: this one, and the to-call list - a capability change can empty
  // or fill it.
  revalidatePath("/owner/settings/transcript-agent");
  revalidatePath("/owner/callbacks");

  return {
    consequences:
      (payload?.consequences as GateActionResult["consequences"]) ?? null,
    clampedToOrgMaximum: (payload?.clampedToOrgMaximum as string | null) ?? null,
  };
}

/**
 * §3A.5's consent acknowledgement.
 *
 * Separate from the master switch on purpose: the API REFUSES a first
 * enablement without it (`consent_required`), so the page asks, the owner
 * reads, and only then does the switch work. A single combined call would make
 * the acknowledgement a checkbox nobody reads on the way to the thing they
 * wanted.
 */
export async function acknowledgeNotice(noticeVersion: string): Promise<GateActionResult> {
  return send("/v1/features/gated/consent", "POST", { noticeVersion, acknowledged: true });
}

/** §3A.8's `PUT /org` - the master switch, the maximum mode, the capabilities. */
export async function setOrgGate(input: {
  state: "on" | "off";
  maxMode: string;
  capabilities: string[];
  reason?: string | null;
}): Promise<GateActionResult> {
  return send("/v1/features/gated/org", "PUT", {
    state: input.state,
    maxMode: input.maxMode,
    capabilities: input.capabilities,
    reason: input.reason ?? null,
  });
}

/** §3A.8's `PUT /users/:userId`. */
export async function setUserGate(
  userId: string,
  input: {
    state: "on" | "off" | "inherit";
    mode?: string | null;
    capabilities?: string[] | null;
    effectiveTo?: string | null;
    reason?: string | null;
  },
): Promise<GateActionResult> {
  return send(`/v1/features/gated/users/${userId}`, "PUT", {
    state: input.state,
    mode: input.mode ?? null,
    capabilities: input.capabilities ?? null,
    effectiveTo: input.effectiveTo ?? null,
    reason: input.reason ?? null,
  });
}

/**
 * §3A.6's "bulk select by team, department or position".
 *
 * A TEAM target writes ONE team-scoped row rather than a row per member, so
 * somebody who joins the team afterwards is covered - which is also §3A.6's
 * "apply to new joiners in this team or role" with no second mechanism.
 */
export async function bulkSetGate(input: {
  target:
    | { kind: "users"; userIds: string[] }
    | { kind: "team"; teamId: string }
    | { kind: "role"; ownerRole: string };
  state: "on" | "off" | "inherit";
  mode?: string | null;
  capabilities?: string[] | null;
  reason?: string | null;
}): Promise<GateActionResult> {
  return send("/v1/features/gated/users/bulk", "POST", {
    target: input.target,
    setting: {
      state: input.state,
      mode: input.mode ?? null,
      capabilities: input.capabilities ?? null,
      reason: input.reason ?? null,
    },
  });
}

/**
 * §3A.5's backfill.
 *
 * `confirm: false` is a PREVIEW and starts nothing - the API returns the counts
 * and the estimated cost. The mode and the no-messages rule are not parameters
 * at all: `GateBackfillInput` has no field for either, so there is nothing for
 * this action to get wrong.
 */
export async function previewBackfill(
  userIds: string[],
  days: number,
): Promise<GateActionResult & { preview?: unknown }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in." };
  const response = await fetch(`${API_URL}/v1/features/gated/backfill`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ userIds, days, confirm: false }),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    return { error: (payload?.message as string) ?? "That did not work." };
  }
  return { preview: payload?.preview };
}

export async function startBackfill(userIds: string[], days: number): Promise<GateActionResult> {
  return send("/v1/features/gated/backfill", "POST", { userIds, days, confirm: true });
}
