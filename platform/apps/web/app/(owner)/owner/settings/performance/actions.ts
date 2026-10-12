"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders, type ActionResult } from "../../actions";
import { apiErrorMessage } from "../../lib/api-error";

/**
 * The KPI setup wizard's writes (§8.5, doc 41 F4).
 *
 * ── NOTHING IS VALIDATED HERE, ON PURPOSE ───────────────────────────────────
 *
 * The four-to-six rule, the weights totalling 100, the one-Result-and-one-
 * Activity rule and the missing-data acknowledgement are all enforced by the
 * API (`insights.controller.ts`), and this action simply relays the message it
 * sends back.
 *
 * Duplicating them here would mean two places to change and two chances to
 * disagree - and the one that has to be right is the API's, because a server
 * action and a direct PUT are the same route and only one of them has a form
 * in front of it. The client form does check them, but only to give a decent
 * message before the round trip; it is not where the rule lives.
 */

export async function saveKpiConfigAction(input: {
  effectiveFrom: string;
  kpis: { kpiKey: string; targetValue: number | null; period: string; weightPct: number }[];
  acknowledgeMissingData: boolean;
}): Promise<ActionResult & { saved?: number }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/insights/kpi/config`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const data = (await res.json()) as { saved?: number };
    // Both the setup page and every dashboard that reads the config. The
    // snapshot sweep is what actually fills the new KPIs in, so the dashboard
    // will say "not computed yet" until it next runs - which is honest, and is
    // why the page says so rather than implying the numbers are ready.
    revalidatePath("/owner/settings/performance");
    revalidatePath("/owner/kpi");
    revalidatePath("/owner/kpi/leaderboard");
    revalidatePath("/owner/kpi/teams");
    return { saved: data.saved };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function saveKpiBandsAction(input: {
  effectiveFrom: string;
  bands: { bandKey: string; label: string; minPct: number; maxPct: number | null; tone: string }[];
}): Promise<ActionResult> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/insights/kpi/bands`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    revalidatePath("/owner/settings/performance");
    revalidatePath("/owner/kpi");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}

export async function saveInsightsSettingsAction(input: {
  leaderboardVisibility?: string;
  demoMode?: boolean;
  staleFeedHours?: number;
  coverageFloor?: number;
}): Promise<ActionResult> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/insights/settings`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    revalidatePath("/owner/settings/performance");
    revalidatePath("/owner/kpi");
    revalidatePath("/owner/kpi/leaderboard");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}
