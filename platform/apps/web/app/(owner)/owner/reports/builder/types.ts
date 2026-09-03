import type { ColumnMeta } from "@aura/shared";

/**
 * The API response shapes this feature's pages and client components share.
 *
 * ── WHY THESE ARE NOT DECLARED IN `page.tsx` ────────────────────────────
 *
 * They were, and it created an import edge from a `"use client"` component
 * back into a Server Component module. `import type` is erased by the
 * compiler, so it works - right up until it does not: the bundler still walks
 * that edge while building the React Client Manifest, and the failure mode is
 * a runtime `Cannot read properties of undefined (reading 'call')` that names
 * nothing useful and looks like a corrupted cache.
 *
 * A plain types module has no runtime half to get pulled in either direction,
 * so the question cannot arise. Same reason `(owner)/owner/types.ts` exists
 * next door.
 */

export interface ReportRow {
  id: string;
  name: string;
  description: string | null;
  status: "draft" | "published" | "archived";
  published_at: string | null;
  published_version: number;
  updated_at: string;
  has_link: boolean;
  created_by_name: string | null;
  role: "owner" | "editor" | "viewer" | null;
  active_schedules: number;
}

export interface TemplateRow {
  id: string;
  is_global: boolean;
  key: string;
  name: string;
  description: string | null;
  category: string | null;
  dataset_roles: Array<{
    role: string;
    label: string;
    hint: string;
    suggestedSourceKey?: string;
  }>;
}

export interface DatasetRow {
  id: string;
  name: string;
  kind: "crm" | "upload";
  source_key: string | null;
  row_count: number;
  refreshed_at: string | null;
  used_by_reports: number;
  created_by_name: string | null;
}

/** One entry of the hand-written CRM source catalogue (crm-sources.ts). */
export interface CatalogueEntry {
  key: string;
  name: string;
  description: string;
  scopable: boolean;
  columns: ColumnMeta[];
}
