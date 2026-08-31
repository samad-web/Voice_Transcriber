"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";

/**
 * Quotations. Same shape as every other feature's actions.ts: the tenant is
 * re-resolved from the session via ownerHeaders() on every call, and every
 * mutation revalidates the pages it feeds.
 */

export type QuotationStatus = "draft" | "sent" | "accepted" | "rejected" | "expired";

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
  created_at: string;
  updated_at: string;
}

export interface QuotationItem {
  id: string;
  product_id: string | null;
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
