"use server";

import { revalidatePath } from "next/cache";
import {
  CreateDialCampaignInput,
  UpdateDialCampaignInput,
  UpdateDialSettingsInput,
  type DialCampaignView,
  type DialPreviewCounts,
  type DialSettingsView,
} from "@aura/shared/dist/dialer";
import { getOwner } from "@/lib/owner-context";
import { API_URL, orgHeaders } from "@/lib/server-api";

/**
 * The dialer console's server actions (Build docs/40 §B1).
 *
 * ── WHAT THIS SCREEN IS, AND THE THREE THINGS IT IS NOT ────────────────────
 *
 * Migrations 0159-0162 built the whole dialer - the queue, the 120s lease, the
 * claim protocol, the eight block reasons - and no console ever reached any of
 * it. This is the surface, and it does four things: name a campaign and its
 * source, read the preview, hand the queue to agents, and start or stop it.
 *
 * It is NOT a softphone. There is no WebRTC here, no bridging, no carrier and
 * no virtual number. The HANDSET dials; this console assigns and reports, and
 * `/v1/devices/me/dialer/next` is what a phone asks. That is a standing
 * product decision, not an unfinished part - a dial button on this page would
 * be the first line of an IVR.
 *
 * It does NOT validate the dial rules. `dialability()` in @aura/shared is the
 * one predicate three processes share (this preview, the queue build and the
 * handset's claim), and a second opinion rendered in a browser is how a
 * supervisor comes to believe a record is dialable that the phone will refuse.
 * The counts on this page come from the API running that same function.
 *
 * And the org is never taken from the caller. Every action below resolves it
 * from the verified session through `getOwner()`, so a browser may post
 * whatever it likes and still only write inside its own tenant.
 */

const PAGE = "/owner/dialer";

type Refusal = { error: string };
type Ok<T> = { data: T };

/**
 * The API's own message, read back rather than replaced.
 *
 * These forms refuse for reasons a person can act on - "The calling window must
 * start before it ends", "nothing to update", a source that selects no records -
 * and "Something went wrong" would throw all of that away. Only a transport
 * failure gets our own sentence, because the API did not produce one.
 */
async function refusal(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    const m = body.message;
    if (typeof m === "string") return m;
    if (Array.isArray(m)) {
      // A zod issue array from the API. The first message is the one the field
      // the person just touched produced; listing all of them for a four-field
      // form reads as a stack trace.
      const first = m[0] as { message?: unknown } | undefined;
      if (first && typeof first.message === "string") return first.message;
    }
  } catch {
    // Fall through: a non-JSON body means a proxy or a crash, not a refusal.
  }
  return `The dialer couldn't do that (${res.status}).`;
}

async function call<T>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<Refusal | Ok<T>> {
  const owner = await getOwner();
  if (!owner) return { error: "Not signed in to a workspace." };
  const headers = orgHeaders(owner.membership.orgId, {
    ownerRole: owner.membership.ownerRole,
    userId: owner.userId,
  });

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: { ...headers, "content-type": "application/json" },
      cache: "no-store",
      // A POST with no body at all - activate, pause, preview. Sending `"{}"`
      // would also work, but these routes take no input and an empty object is
      // a body somebody later adds a field to.
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return { error: "The server could not be reached. Try again in a moment." };
  }
  if (!res.ok) return { error: await refusal(res) };
  const text = await res.text();
  return { data: (text ? JSON.parse(text) : {}) as T };
}

// ── Campaigns ───────────────────────────────────────────────────────────────

export interface CampaignResult {
  error?: string;
  campaign?: DialCampaignView;
}

/**
 * A new campaign, always a draft.
 *
 * `status` is deliberately absent from the input the API accepts: a campaign
 * that could be created already active would start ringing before anybody had
 * looked at the preview, which is the screen this whole feature is built
 * around. Activation is its own action below.
 */
export async function createCampaignAction(input: unknown): Promise<CampaignResult> {
  const parsed = CreateDialCampaignInput.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the campaign details." };
  }
  const result = await call<{ campaign: DialCampaignView }>(
    "POST",
    "/v1/dialer/campaigns",
    parsed.data,
  );
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return { campaign: result.data.campaign };
}

/**
 * Patched with a HAND-BUILT schema, not `CreateDialCampaignInput.partial()`.
 *
 * `.partial()` keeps `.default()`, so a rename would carry `mode: "preview"`
 * along with it and quietly put a progressive floor back into manual dialling.
 * `UpdateDialCampaignInput` exists for that reason and `dialer.test.ts` proves
 * the shortcut would have been wrong.
 */
export async function updateCampaignAction(
  id: unknown,
  patch: unknown,
): Promise<CampaignResult> {
  if (typeof id !== "string" || !id) return { error: "Which campaign?" };
  const parsed = UpdateDialCampaignInput.safeParse(patch);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the campaign details." };
  }
  const result = await call<{ campaign: DialCampaignView }>(
    "PATCH",
    `/v1/dialer/campaigns/${id}`,
    parsed.data,
  );
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return { campaign: result.data.campaign };
}

export interface PreviewResult {
  error?: string;
  preview?: DialPreviewCounts;
}

/**
 * The preview, which is read BEFORE the queue is built and again as part of
 * building it.
 *
 * Both answers come from the same `dialability()` over the same source, which
 * is what lets the build report "4,812 queued" and the preview say "4,812
 * dialable" and mean it. §5 exists to stop those two numbers diverging, so this
 * action must never cache or adjust what it gets back.
 */
export async function previewCampaignAction(id: unknown): Promise<PreviewResult> {
  if (typeof id !== "string" || !id) return { error: "Which campaign?" };
  const result = await call<{ preview: DialPreviewCounts }>(
    "POST",
    `/v1/dialer/campaigns/${id}/preview`,
  );
  if ("error" in result) return result;
  return { preview: result.data.preview };
}

export interface BuildResult {
  error?: string;
  preview?: DialPreviewCounts;
  inserted?: number;
  queued?: number;
}

/**
 * Builds the queue and hands it out.
 *
 * `assignUserIds` round-robins in the order given; empty leaves every item
 * unassigned, which any agent on the campaign may then claim - the right
 * default for a small floor, and why assignment lives on the ITEM rather than
 * the campaign.
 */
export async function buildQueueAction(
  id: unknown,
  assignUserIds: unknown,
): Promise<BuildResult> {
  if (typeof id !== "string" || !id) return { error: "Which campaign?" };
  const ids = Array.isArray(assignUserIds) ? assignUserIds.filter((v) => typeof v === "string") : [];
  const result = await call<{ preview: DialPreviewCounts; inserted: number; queued: number }>(
    "POST",
    `/v1/dialer/campaigns/${id}/build`,
    { assignUserIds: ids },
  );
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return result.data;
}

/**
 * Start or stop the floor.
 *
 * Two actions rather than one `setStatus(status)`, because the two are not
 * symmetrical in consequence and a single action with a string argument invites
 * a UI that flips whichever way the current state suggests. Activating commits
 * a day of calls; pausing is always safe.
 */
export async function activateCampaignAction(id: unknown): Promise<CampaignResult> {
  if (typeof id !== "string" || !id) return { error: "Which campaign?" };
  const result = await call<{ campaign: DialCampaignView }>(
    "POST",
    `/v1/dialer/campaigns/${id}/activate`,
  );
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return { campaign: result.data.campaign };
}

export async function pauseCampaignAction(id: unknown): Promise<CampaignResult> {
  if (typeof id !== "string" || !id) return { error: "Which campaign?" };
  const result = await call<{ campaign: DialCampaignView }>(
    "POST",
    `/v1/dialer/campaigns/${id}/pause`,
  );
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return { campaign: result.data.campaign };
}

// ── The org-wide dial policy ────────────────────────────────────────────────

export interface SettingsResult {
  error?: string;
  settings?: DialSettingsView;
}

/**
 * The calling window, the unknown-consent switch and the per-person ceiling.
 *
 * ── WHY THE CEILING IS EDITED FROM THIS PAGE ───────────────────────────────
 *
 * It is an ORG column (`dialer_max_calls_per_person_per_day`, 0157), not a
 * campaign field - so the tidy place for it is a settings page. It is here
 * instead, beside `maxAttempts`, deliberately.
 *
 * `maxAttempts` answers "how many times may we try this RECORD". The ceiling
 * answers "how many times may we ring this HUMAN today, across every campaign
 * at once". They are different questions with the same shape, and the second
 * exists because two leads can be the same person - which is exactly the case
 * a per-campaign limit cannot see. An owner who sets `maxAttempts: 5` on three
 * campaigns has authorised fifteen calls to one man in a morning and will not
 * know it unless both numbers are in front of them at the moment they choose.
 *
 * The ceiling ships UNCAPPED, and that default is only defensible while it is
 * visible here. Doc 39's decision record says so in as many words.
 */
export async function updateDialSettingsAction(patch: unknown): Promise<SettingsResult> {
  const parsed = UpdateDialSettingsInput.safeParse(patch);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the dial settings." };
  }
  const result = await call<{ settings: DialSettingsView }>(
    "PATCH",
    "/v1/dialer/settings",
    parsed.data,
  );
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return { settings: result.data.settings };
}
