"use server";

import { revalidatePath } from "next/cache";
import type { ExportFormat, ExportScope } from "@aura/shared";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../../actions";
import { apiErrorMessage } from "../../lib/api-error";

/**
 * The exports centre's server actions (doc 35 SS8, migration 0148).
 *
 * Each one re-resolves the tenant from the session (`ownerHeaders`) - a server
 * action is a public endpoint, so the org is never taken from an argument. The
 * same rule every other actions.ts here follows.
 *
 * `ownerHeaders` also sends `x-caller-user-id`, which this feature needs more
 * than most: an export BELONGS to a person, the job row's owner is a NOT NULL
 * FK, and the API refuses a caller it cannot name.
 */

export interface ExportJobRow {
  id: string;
  scope: ExportScope;
  section: string | null;
  format: string;
  datasets: string[];
  status: string;
  rows_total: string | number | null;
  rows_written: string | number;
  bytes_written: string | number;
  current_dataset: string | null;
  file_name: string | null;
  expires_at: string | null;
  downloaded_count: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  requested_by_user_id: string;
  requested_by_name: string | null;
  canDownload: boolean;
}

export interface ExportDatasetOption {
  key: string;
  label: string;
  section: string;
  sensitivity: "normal" | "call_content" | "financial";
  columns: Array<{ name: string; type: string }>;
  redacted: string[];
}

export interface ExportCatalogue {
  datasets: ExportDatasetOption[];
  sections: Array<{ section: string; datasets: string[] }>;
  omitted: Array<{ dataset: string; reason: string }>;
  canExportRecordings: boolean;
  retentionDays: number;
  scope: "all" | "own";
}

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
  revalidate = true,
): Promise<{ data?: T; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: init.method ?? "GET",
      headers: { ...headers, "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
    });
    // `apiErrorMessage` consumes the Response, so it must be called BEFORE the
    // body is read for the success path - a Response body can only be read once.
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (revalidate) revalidatePath("/owner/account/data");
    return { data: parsed as T };
  } catch {
    return { error: "Could not reach the server" };
  }
}

export async function fetchExportsAction(): Promise<{ data?: { jobs: ExportJobRow[] }; error?: string }> {
  return call<{ jobs: ExportJobRow[] }>("/v1/exports", {}, false);
}

export async function fetchExportCatalogueAction(): Promise<{
  data?: ExportCatalogue;
  error?: string;
}> {
  return call<ExportCatalogue>("/v1/exports/datasets", {}, false);
}

export interface StartExportInput {
  scope: ExportScope;
  format: ExportFormat;
  dataset?: string;
  section?: string;
  /** Only meaningful on a `view` export; the API rejects it on the others. */
  filters?: Record<string, unknown>;
  columns?: string[];
}

export async function startExportAction(input: StartExportInput): Promise<{
  data?: { jobId: string; status: string; datasets: string[]; omitted: Array<{ dataset: string; reason: string }> };
  error?: string;
}> {
  // Sent as given. `filters` on a section or bulk export is REJECTED by the API
  // rather than dropped, and stripping it here would hide that from the caller -
  // somebody who sent filters believes they were applied.
  return call("/v1/exports", { method: "POST", body: input });
}

/** Cancel a live job, or delete a finished one's file now. */
export async function cancelExportAction(id: string): Promise<{ data?: { status: string }; error?: string }> {
  return call(`/v1/exports/${id}`, { method: "DELETE" });
}

/**
 * The download URL, fetched through the server so the browser never holds the
 * admin key.
 *
 * The API answers 302 to a freshly signed S3 URL, so `redirect: "manual"` and
 * the Location header is what the browser is handed. Nothing is stored: the
 * signature lives five minutes and is re-minted on every click, which is the
 * whole reason the job row holds a KEY and not a URL.
 */
export async function exportDownloadUrlAction(
  id: string,
): Promise<{ url?: string; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}/v1/exports/${id}/download`, {
      headers,
      redirect: "manual",
      cache: "no-store",
    });
    const location = res.headers.get("location");
    if (location) return { url: location };
    // 410 is its own message, because "gone" is a different thing to tell
    // somebody than "refused": the export was real and its file has been
    // deleted, so the answer is Run again rather than ask for access.
    if (res.status === 410) return { error: "This export has expired. Run it again to get a new file." };
    return { error: await apiErrorMessage(res) };
  } catch {
    return { error: "Could not reach the server" };
  }
}
