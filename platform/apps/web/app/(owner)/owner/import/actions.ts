"use server";

import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";

// Mirrors `ImportEntity` in @aura/shared, which is itself pinned against
// `import_jobs.entity`'s CHECK by import.test.ts. Three finance members were
// added for Build docs/indian-business-finance-documents-cycles-import §3.
export type ImportEntity =
  | "contact"
  | "account"
  | "deal"
  | "payment"
  | "expense"
  | "bank_txn";
export type DedupeStrategy = "skip" | "update" | "create";

/** The API's guessed column mapping for one entity's target fields. */
export interface ImportPreview {
  /** Target field → the source CSV header it guessed, or null if it couldn't. */
  mapping: Record<string, string | null>;
  requiredFields: string[];
}

/** The outcome of one `/import/run` call. */
export interface ImportJob {
  id: string;
  entity: ImportEntity;
  status: string;
  dedupe_strategy: DedupeStrategy;
  total_rows: number;
  inserted_count: number;
  updated_count: number;
  skipped_count: number;
  failed_count: number;
  created_at: string;
}

export interface ImportRowError {
  row_number: number;
  raw: Record<string, unknown>;
  error: string;
}

/**
 * Bulk CSV import - contacts, accounts or deals.
 *
 * Every action re-resolves the owner from the session via ownerHeaders()
 * rather than trusting anything the client passed, same as every other
 * server-action file under /owner. Nothing here calls revalidatePath: this
 * page is the only place an import job's data is ever shown, so there is
 * nothing else on the console for a run to invalidate.
 */
export async function previewImportAction(
  entity: ImportEntity,
  headers: string[],
): Promise<{ mapping?: Record<string, string | null>; requiredFields?: string[]; error?: string }> {
  const authHeaders = await ownerHeaders();
  if (!authHeaders) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/import/preview`, {
      method: "POST",
      headers: authHeaders,
      cache: "no-store",
      body: JSON.stringify({ entity, headers }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const detail = (body as { message?: unknown })?.message ?? body;
      return { error: typeof detail === "string" ? detail : `API ${res.status}` };
    }
    const data = (await res.json()) as ImportPreview;
    return { mapping: data.mapping, requiredFields: data.requiredFields };
  } catch {
    return { error: "API unreachable" };
  }
}

// Running the import is NOT an action: the rows are several MB, past the 1 MB
// every Server Action is capped at. It is the route handler in ./run/route.ts.

/** The per-row failures for one job, for the results table. */
export async function fetchImportErrorsAction(
  jobId: string,
): Promise<{ errors?: ImportRowError[]; error?: string }> {
  const authHeaders = await ownerHeaders();
  if (!authHeaders) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/import/${jobId}/errors`, {
      headers: authHeaders,
      cache: "no-store",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    const data = (await res.json()) as { errors: ImportRowError[] };
    return { errors: data.errors };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * The same failures as an already-RFC4180-encoded CSV string, for the
 * download button. This has to be a server action rather than a plain link:
 * the API sits behind the admin key, which never reaches the browser, so the
 * client cannot fetch `/v1/import/:id/errors.csv` itself.
 */
export async function fetchImportErrorsCsvAction(
  jobId: string,
): Promise<{ csv?: string; error?: string }> {
  const authHeaders = await ownerHeaders();
  if (!authHeaders) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/import/${jobId}/errors.csv`, {
      headers: authHeaders,
      cache: "no-store",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    const data = (await res.json()) as { csv: string };
    return { csv: data.csv };
  } catch {
    return { error: "API unreachable" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The staged flow
// (Build docs/indian-business-finance-documents-cycles-import §3)
//
// Four actions for four steps - stage, read the preview, commit, undo - rather
// than one that does everything. §3's whole premise is that a person approves
// the import once, between staging and committing, and an action that staged
// and committed in one call would have no gap for them to approve in.
// ─────────────────────────────────────────────────────────────────────────────

export interface StageInput {
  entity: ImportEntity;
  mapping: Record<string, string | null>;
  mode: "create" | "update" | "upsert";
  dateOrder: "iso" | "dmy" | "mdy";
  rows: Record<string, unknown>[];
  sourceRowNumbers?: number[];
  fileName?: string;
  sheetName?: string;
  headerRow?: number;
  source?: string;
}

export async function stageImportAction(input: StageInput): Promise<{
  jobId?: string;
  summary?: {
    newRows: number;
    updateRows: number;
    skippedRows: number;
    errorRows: number;
    duplicateRows: number;
    totalRows: number;
  };
  dedupeWarning?: string | null;
  error?: string;
}> {
  const authHeaders = await ownerHeaders();
  if (!authHeaders) return { error: "Not signed in as an instance owner" };

  const res = await fetch(`${API_URL}/v1/import/stage`, {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify(input),
    cache: "no-store",
  });
  if (!res.ok) return { error: await readError(res, "Could not stage that import.") };
  const data = (await res.json()) as {
    jobId: string;
    summary: StageInput extends never ? never : Record<string, number>;
    dedupeWarning: string | null;
  };
  return {
    jobId: data.jobId,
    summary: data.summary as never,
    dedupeWarning: data.dedupeWarning,
  };
}

export async function stagedRowsAction(
  jobId: string,
  status?: string,
): Promise<{
  rows?: Array<{
    sourceRowNumber: number;
    status: string;
    error: string | null;
    raw: Record<string, unknown>;
  }>;
  error?: string;
}> {
  const authHeaders = await ownerHeaders();
  if (!authHeaders) return { error: "Not signed in as an instance owner" };

  const query = status ? `?status=${encodeURIComponent(status)}&limit=50` : "?limit=50";
  const res = await fetch(`${API_URL}/v1/import/jobs/${jobId}/staged${query}`, {
    headers: authHeaders,
    cache: "no-store",
  });
  if (!res.ok) return { error: await readError(res, "Could not read the staged rows.") };
  const data = (await res.json()) as { rows: never[] };
  return { rows: data.rows };
}

export async function commitImportAction(jobId: string): Promise<{
  job?: ImportJob;
  reconciled?: number | null;
  awaitingApproval?: number | null;
  error?: string;
}> {
  const authHeaders = await ownerHeaders();
  if (!authHeaders) return { error: "Not signed in as an instance owner" };

  const res = await fetch(`${API_URL}/v1/import/jobs/${jobId}/commit`, {
    method: "POST",
    headers: authHeaders,
    cache: "no-store",
  });
  if (!res.ok) return { error: await readError(res, "Could not apply that import.") };
  return (await res.json()) as { job: ImportJob; reconciled: number | null; awaitingApproval: number | null };
}

export async function discardStagedImportAction(jobId: string): Promise<{ error?: string }> {
  const authHeaders = await ownerHeaders();
  if (!authHeaders) return { error: "Not signed in as an instance owner" };

  const res = await fetch(`${API_URL}/v1/import/jobs/${jobId}`, {
    method: "DELETE",
    headers: authHeaders,
    cache: "no-store",
  });
  if (!res.ok) return { error: await readError(res, "Could not discard that import.") };
  return {};
}

export async function rollbackImportAction(
  jobId: string,
  reason: string,
): Promise<{ undone?: number; kept?: number; problems?: string[]; error?: string }> {
  const authHeaders = await ownerHeaders();
  if (!authHeaders) return { error: "Not signed in as an instance owner" };

  const res = await fetch(`${API_URL}/v1/import/jobs/${jobId}/rollback`, {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ reason }),
    cache: "no-store",
  });
  if (!res.ok) return { error: await readError(res, "Could not undo that import.") };
  return (await res.json()) as { undone: number; kept: number; problems: string[] };
}

/**
 * The API's own message where it sent one.
 *
 * A 403 from a finance import is the case that matters: "Importing payments
 * needs permission to create finance records" is actionable, and "Request
 * failed" sends somebody to the wrong person.
 */
async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string | string[] };
    const message = Array.isArray(body.message) ? body.message.join(", ") : body.message;
    return message || fallback;
  } catch {
    return fallback;
  }
}
