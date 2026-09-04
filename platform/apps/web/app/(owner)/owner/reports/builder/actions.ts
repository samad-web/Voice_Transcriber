"use server";

import { revalidatePath } from "next/cache";
import type { QuerySpec, ReportDoc } from "@aura/shared";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../../actions";
import { apiErrorMessage } from "../../lib/api-error";

/**
 * Server actions for the Report Builder.
 *
 * Every one re-resolves the owner from the SESSION through `ownerHeaders()`
 * rather than accepting an org id - a server action is a public endpoint, and
 * anything it takes as an argument a caller can forge. That is the same rule
 * every other owner-console action file follows, and it is the reason the
 * tenant boundary here is not one a client can influence at all.
 *
 * The admin key never leaves the server: the browser calls these, these call
 * the API. A client component fetching `/v1/...` directly would need the
 * credential in the bundle.
 */

export interface ActionResult<T = unknown> {
  data?: T;
  error?: string;
}

async function call<T>(
  path: string,
  init: { method: string; body?: unknown },
): Promise<ActionResult<T>> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: init.method,
      headers,
      cache: "no-store",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    // 204s and empty bodies are legitimate here (DELETE), so a parse failure
    // on an OK response is not an error.
    const text = await res.text();
    return { data: (text ? JSON.parse(text) : {}) as T };
  } catch {
    return { error: "API unreachable" };
  }
}

// ── reports ───────────────────────────────────────────────────────────────

export async function createReportAction(input: {
  name: string;
  description?: string;
  templateId?: string;
  datasetByRole?: Record<string, string>;
}): Promise<ActionResult<{ report: { id: string } }>> {
  const result = await call<{ report: { id: string } }>("/v1/report-builder", {
    method: "POST",
    body: input,
  });
  if (result.data) revalidatePath("/owner/reports/builder");
  return result;
}

/**
 * The autosave.
 *
 * `revision` is the optimistic lock - the editor sends what it loaded and a
 * mismatch comes back 409. Deliberately does NOT revalidate: an autosave that
 * re-rendered the server tree on every keystroke would fight the editor for
 * control of its own state. The list page picks up the new `updated_at` on its
 * next visit, which is soon enough for a timestamp.
 */
export async function saveReportAction(
  id: string,
  patch: { revision: number; name?: string; description?: string | null; doc?: ReportDoc },
): Promise<ActionResult<{ report: { revision: number; updated_at: string } }>> {
  return call(`/v1/report-builder/${id}`, { method: "PATCH", body: patch });
}

export async function publishReportAction(id: string): Promise<ActionResult> {
  const result = await call(`/v1/report-builder/${id}/publish`, { method: "POST" });
  if (result.data) {
    revalidatePath("/owner/reports/builder");
    revalidatePath(`/owner/reports/builder/${id}`);
  }
  return result;
}

export async function archiveReportAction(id: string): Promise<ActionResult> {
  const result = await call(`/v1/report-builder/${id}`, { method: "DELETE" });
  if (result.data) revalidatePath("/owner/reports/builder");
  return result;
}

export async function saveAsTemplateAction(input: {
  reportId: string;
  name: string;
  description?: string;
  category?: string;
}): Promise<ActionResult> {
  const result = await call("/v1/report-builder/templates", { method: "POST", body: input });
  if (result.data) revalidatePath("/owner/reports/builder");
  return result;
}

export async function setSharesAction(
  id: string,
  shares: Array<{ userId: string; role: "owner" | "editor" | "viewer" }>,
): Promise<ActionResult> {
  const result = await call(`/v1/report-builder/${id}/shares`, {
    method: "PUT",
    body: { shares },
  });
  if (result.data) revalidatePath(`/owner/reports/builder/${id}`);
  return result;
}

export async function setLinkAction(
  id: string,
  enabled: boolean,
): Promise<ActionResult<{ token: string | null }>> {
  const result = await call<{ token: string | null }>(`/v1/report-builder/${id}/link`, {
    method: "PUT",
    body: { enabled },
  });
  if (result.data) revalidatePath(`/owner/reports/builder/${id}`);
  return result;
}

// ── schedules ─────────────────────────────────────────────────────────────

export async function createScheduleAction(
  id: string,
  input: {
    cadence: "daily" | "weekly" | "monthly";
    dayOfWeek?: number | null;
    dayOfMonth?: number | null;
    hourUtc: number;
    recipients: string[];
  },
): Promise<ActionResult> {
  const result = await call(`/v1/report-builder/${id}/schedules`, {
    method: "POST",
    body: input,
  });
  if (result.data) revalidatePath(`/owner/reports/builder/${id}`);
  return result;
}

export async function deleteScheduleAction(
  id: string,
  scheduleId: string,
): Promise<ActionResult> {
  const result = await call(`/v1/report-builder/${id}/schedules/${scheduleId}`, {
    method: "DELETE",
  });
  if (result.data) revalidatePath(`/owner/reports/builder/${id}`);
  return result;
}

export async function runNowAction(id: string): Promise<ActionResult<{ run: { id: string } }>> {
  const result = await call<{ run: { id: string } }>(`/v1/report-builder/${id}/runs`, {
    method: "POST",
  });
  if (result.data) revalidatePath(`/owner/reports/builder/${id}`);
  return result;
}

/**
 * Render every widget live, without persisting anything - what the print
 * route and the standalone dashboard view both poll. `token` carries the
 * report's read-only share link when the caller isn't its owner/editor/viewer.
 */
export async function renderReportAction(
  id: string,
  token?: string,
): Promise<
  ActionResult<{
    name: string;
    failures: string[];
    snapshot: {
      doc: ReportDoc;
      widgets: Record<
        string,
        {
          rows: Array<Record<string, string | number | null>>;
          dimensionKeys: string[];
          measureKeys: string[];
          truncated: boolean;
          error?: string;
        }
      >;
      generatedAt: string;
    };
  }>
> {
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return call(`/v1/report-builder/${id}/render${query}`, { method: "POST", body: {} });
}

// ── data ──────────────────────────────────────────────────────────────────

/**
 * Run one widget's query.
 *
 * The single call every chart in the editor makes (design doc D2 - the browser
 * never receives a raw row). Returns the widget-shaped result including its
 * `error` field, which the canvas renders per-tile rather than treating as a
 * page failure.
 */
export async function runWidgetQueryAction(
  datasetId: string,
  spec: QuerySpec,
): Promise<ActionResult<{ rows: unknown[]; dimensionKeys: string[]; measureKeys: string[]; truncated: boolean; error?: string }>> {
  return call(`/v1/report-datasets/${datasetId}/query`, { method: "POST", body: spec });
}

export async function createDatasetAction(
  input:
    | { kind: "crm"; sourceKey: string; name?: string }
    | { kind: "upload"; name: string; headers: string[]; rows: Array<Record<string, unknown>> },
): Promise<ActionResult<{ dataset: { id: string; name: string } }>> {
  const result = await call<{ dataset: { id: string; name: string } }>("/v1/report-datasets", {
    method: "POST",
    body: input,
  });
  if (result.data) revalidatePath("/owner/reports/builder/data");
  return result;
}

/**
 * Replace an upload's rows.
 *
 * Returns the drift report - which widgets in which reports the new shape has
 * broken - so the console can show it immediately rather than letting the user
 * discover it the next time they open a report (prompt 3.2, AC 7).
 */
export async function refreshDatasetAction(
  id: string,
  input: { headers: string[]; rows: Array<Record<string, unknown>> },
): Promise<
  ActionResult<{
    dataset: { rowCount: number };
    drifted: boolean;
    issues: Array<{ reportId: string; reportName: string; issues: Array<{ message: string }> }>;
  }>
> {
  const result = await call<{
    dataset: { rowCount: number };
    drifted: boolean;
    issues: Array<{ reportId: string; reportName: string; issues: Array<{ message: string }> }>;
  }>(`/v1/report-datasets/${id}/rows`, { method: "POST", body: input });
  if (result.data) revalidatePath("/owner/reports/builder/data");
  return result;
}

export async function deleteDatasetAction(id: string): Promise<ActionResult> {
  const result = await call(`/v1/report-datasets/${id}`, { method: "DELETE" });
  if (result.data) revalidatePath("/owner/reports/builder/data");
  return result;
}

export async function createPaletteAction(input: {
  name: string;
  colors: string[];
  background?: string | null;
}): Promise<ActionResult> {
  const result = await call("/v1/report-builder/palettes", { method: "POST", body: input });
  if (result.data) revalidatePath("/owner/reports/builder");
  return result;
}
