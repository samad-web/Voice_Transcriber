"use server";

import { revalidatePath } from "next/cache";
import {
  CallEscalationRoutingInput,
  CallEscalationSettingsInput,
  type CallEscalationSettingsView,
} from "@aura/shared";
import { escalationCall } from "@/lib/call-escalation-api";

/**
 * Settings → Calls & AI → Escalations (0151, Build docs/38).
 *
 * Owner and manager reach the page; the switch is owners only, which the API
 * enforces (`@RequireOwnerRole("owner")` on the PUT) and the page reflects
 * from `canEditSwitch`. Routing - seniors and "escalates to" - is either.
 *
 * Each write re-reads the settings afterwards rather than trusting the PUT's
 * body: un-marking a senior also clears every "escalates to" that pointed at
 * them, and every telecaller's effective recipient can move with one change,
 * so the honest picture is the GET.
 */

const BASE = "/v1/owner/call-escalation-settings";

export interface EscalationSettingsResult {
  error?: string;
  settings?: CallEscalationSettingsView;
}

async function reread(): Promise<EscalationSettingsResult> {
  const fresh = await escalationCall<CallEscalationSettingsView>("GET", BASE);
  // The write landed; only the re-read failed. Say nothing alarming - the
  // page's own refresh will bring the new state in.
  return fresh.ok ? { settings: fresh.data } : {};
}

/** The workspace switch. Owners only - the API refuses anybody else. */
export async function setEscalationSwitchAction(enabled: boolean): Promise<EscalationSettingsResult> {
  const parsed = CallEscalationSettingsInput.safeParse({ enabled });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Choose on or off." };
  const result = await escalationCall<unknown>("PUT", BASE, parsed.data);
  if (!result.ok) return { error: result.error };
  revalidatePath("/owner/settings/escalations");
  // The whole console, not only this page: the rail's Escalations entry
  // appears or disappears with the switch, and the membership it reads is
  // resolved per request by the layout.
  revalidatePath("/owner", "layout");
  return reread();
}

/** Who can receive, and who each telecaller escalates to. Only the rows sent change. */
export async function updateEscalationRoutingAction(input: unknown): Promise<EscalationSettingsResult> {
  const parsed = CallEscalationRoutingInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Nothing to change." };
  const result = await escalationCall<unknown>("PUT", `${BASE}/routing`, parsed.data);
  if (!result.ok) return { error: result.error };
  revalidatePath("/owner/settings/escalations");
  return reread();
}
