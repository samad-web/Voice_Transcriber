"use server";

import { revalidatePath } from "next/cache";
import type { QuotationStatus } from "@aura/shared";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";

/**
 * Quotations. Same shape as every other feature's actions.ts: the tenant is
 * re-resolved from the session via ownerHeaders() on every call, and every
 * mutation revalidates the pages it feeds.
 */

/**
 * Re-exported from `@aura/shared` rather than declared here. It used to be a
 * hand-written union, one of seven places that spelled the statuses out - and
 * the one most likely to drift, because nothing fails when a web union is
 * missing a value the API can return.
 */
export type { QuotationStatus };

export interface Quotation {
  id: string;
  workspace_id: string | null;
  account_id: string | null;
  contact_id: string | null;
  deal_id: string | null;
  quotation_number: string;
  status: QuotationStatus;
  currency: string;
  /** Postgres numeric - these all come back as strings. Number() before formatting. */
  subtotal: string;
  discount_type: "percent" | "amount" | null;
  discount_value: string | null;
  tax_total: string;
  total: string;
  valid_until: string | null;
  notes: string | null;
  owner_user_id: string | null;
  /** 1 for an original. A revision carries its generation (migration 0149). */
  revision: number;
  /** The quotation this was raised from, or null for an original. */
  revision_of: string | null;
  /** The first quotation in the family. Null means this row IS the root. */
  root_id: string | null;
  created_at: string;
  updated_at: string;
  /**
   * Who it is for, resolved by the LIST endpoint's join. Absent from a detail
   * read and from a mutation's echo, which return the row unjoined - so the
   * list is the only place that may render them, and a detail screen resolves
   * a name through `RecordPicker` instead.
   */
  account_name?: string | null;
  contact_name?: string | null;
}

export interface QuotationItem {
  id: string;
  product_id: string | null;
  /** The linked catalogue entry's name, resolved by the API's LEFT JOIN. */
  product_name: string | null;
  description: string;
  quantity: string;
  unit_price: string;
  discount_pct: string | null;
  tax_rate: string | null;
  line_total: string;
  position: number;
}

export interface QuotationItemInput {
  productId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  discountPct?: number;
  taxRate?: number;
}

export interface QuotationDiscount {
  type: "percent" | "amount" | null;
  value: number;
}

export interface QuotationCreateInput {
  workspaceId?: string;
  accountId?: string;
  contactId?: string;
  dealId?: string;
  currency: string;
  discount: QuotationDiscount;
  validUntil?: string;
  notes?: string;
  items: QuotationItemInput[];
}

export interface QuotationPatch {
  status?: QuotationStatus;
  /**
   * Who the quotation is for. `null` clears the link; omitting the field leaves
   * it alone - the API distinguishes the two by `!== undefined`, so these must
   * never be defaulted on the way out.
   */
  accountId?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  discount?: QuotationDiscount;
  validUntil?: string | null;
  notes?: string | null;
  /** A full replacement of the line items - never a partial patch of one row. */
  items?: QuotationItemInput[];
}

async function message(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({}));
  const detail = (body as { message?: unknown }).message;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => (typeof d === "string" ? d : ((d as { message?: string }).message ?? "")))
      .join("; ");
  }
  return typeof detail === "string" ? detail : `API ${res.status}`;
}

export async function createQuotationAction(
  input: QuotationCreateInput,
): Promise<{ quotation?: Quotation; items?: QuotationItem[]; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/quotations`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify(input),
    });
    if (!res.ok) return { error: await message(res) };
    const data = (await res.json()) as { quotation: Quotation; items: QuotationItem[] };
    revalidatePath("/owner/quotations");
    return data;
  } catch {
    return { error: "API unreachable" };
  }
}

/** One row of a quotation's revision history, as the detail endpoint returns it. */
export interface QuotationRevision {
  id: string;
  quotation_number: string;
  status: QuotationStatus;
  revision: number;
  total: string;
  currency: string;
  created_at: string;
}

/**
 * Raise a new revision of an issued quotation.
 *
 * The original keeps its number and its lines and becomes `superseded`; the new
 * one is `<number>-r2` in draft. Nothing is overwritten, which is the whole
 * point - a sent quotation's numbers are what a customer was told.
 */
export async function reviseQuotationAction(
  id: string,
): Promise<{ quotation?: Quotation; items?: QuotationItem[]; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/quotations/${id}/revise`, {
      method: "POST",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await message(res) };
    const data = (await res.json()) as { quotation: Quotation; items: QuotationItem[] };
    revalidatePath("/owner/quotations");
    revalidatePath(`/owner/quotations/${id}`);
    return data;
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Every field is optional - the caller sends only what changed, except
 * `items`, which is always a full replacement (see QuotationPatch above).
 */
export async function updateQuotationAction(
  id: string,
  patch: QuotationPatch,
): Promise<{ quotation?: Quotation; items?: QuotationItem[]; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/quotations/${id}`, {
      method: "PATCH",
      headers,
      cache: "no-store",
      body: JSON.stringify(patch),
    });
    if (!res.ok) return { error: await message(res) };
    const data = (await res.json()) as { quotation: Quotation; items: QuotationItem[] };
    revalidatePath("/owner/quotations");
    revalidatePath(`/owner/quotations/${id}`);
    return data;
  } catch {
    return { error: "API unreachable" };
  }
}
