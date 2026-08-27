"use server";

import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";

export type ImportEntity = "contact" | "account" | "deal";
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
 * Bulk CSV import — contacts, accounts or deals.
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

/**
 * Run the import. `rows` are the RAW parsed CSV rows keyed by original
 * header — the API applies `mapping` itself, so nothing is pre-mapped here.
 */
export async function runImportAction(
  entity: ImportEntity,
  mapping: Record<string, string | null>,
  dedupeStrategy: DedupeStrategy,
  rows: Record<string, unknown>[],
): Promise<{ job?: ImportJob; error?: string }> {
  const authHeaders = await ownerHeaders();
  if (!authHeaders) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/import/run`, {
      method: "POST",
      headers: authHeaders,
      cache: "no-store",
      body: JSON.stringify({ entity, mapping, dedupeStrategy, rows }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const detail = (body as { message?: unknown })?.message ?? body;
      return { error: typeof detail === "string" ? detail : `API ${res.status}` };
    }
    const data = (await res.json()) as { job: ImportJob };
    return { job: data.job };
  } catch {
    return { error: "API unreachable" };
  }
}

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
