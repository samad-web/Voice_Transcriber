"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";

/**
 * Products (quotations/invoices pick their line items from this list).
 *
 * Same shape as every other feature's actions.ts: the tenant is re-resolved
 * from the session via ownerHeaders() on every call, never trusted from the
 * client, and every mutation revalidates the list page it feeds.
 */

export interface Product {
  id: string;
  name: string;
  sku: string | null;
  description: string | null;
  /** Postgres numeric — comes back as a string. Number() before formatting. */
  unit_price: string;
  currency: string;
  tax_rate: string;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
}

export interface ProductInput {
  name: string;
  sku?: string;
  description?: string;
  unitPrice: number;
  currency: string;
  taxRate: number;
}

export interface ProductPatch extends Partial<ProductInput> {
  status?: "active" | "archived";
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

export async function createProductAction(
  input: ProductInput,
): Promise<{ product?: Product; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/products`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify(input),
    });
    if (!res.ok) return { error: await message(res) };
    const data = (await res.json()) as { product: Product };
    revalidatePath("/owner/products");
    return { product: data.product };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function updateProductAction(
  id: string,
  patch: ProductPatch,
): Promise<{ product?: Product; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/products/${id}`, {
      method: "PATCH",
      headers,
      cache: "no-store",
      body: JSON.stringify(patch),
    });
    if (!res.ok) return { error: await message(res) };
    const data = (await res.json()) as { product: Product };
    revalidatePath("/owner/products");
    return { product: data.product };
  } catch {
    return { error: "API unreachable" };
  }
}
