"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";

/**
 * Invoices. Same shape as quotations/actions.ts (and every other feature's
 * actions.ts): the tenant is re-resolved from the session via ownerHeaders()
 * on every call, and every mutation revalidates the pages it feeds.
 */

export type InvoiceStatus = "draft" | "sent" | "paid" | "overdue" | "void";

export type PaymentProvider = "razorpay" | "stripe";

export interface Invoice {
  id: string;
  workspace_id: string | null;
  account_id: string | null;
  contact_id: string | null;
  deal_id: string | null;
  quotation_id?: string | null;
  invoice_number: string;
  status: InvoiceStatus;
  currency: string;
  /** Postgres numeric - these all come back as strings. Number() before formatting. */
  subtotal: string;
  discount_type: "percent" | "amount" | null;
  discount_value: string | null;
  /** cgst + sgst + igst, derived by the API. */
  tax_total: string;
  /** IGST (true) or CGST + SGST (false). */
  is_inter_state: boolean;
  /** The gateway a payment link was already sent through, if any. */
  payment_provider: PaymentProvider | null;
  cgst: string | null;
  sgst: string | null;
  igst: string | null;
  total: string;
  amount_paid: string;
  customer_gstin: string | null;
  place_of_supply: string | null;
  due_date: string | null;
  notes: string | null;
  owner_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvoiceItem {
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

export interface Payment {
  id: string;
  provider: string;
  status: "created" | "paid" | "failed";
  /** What the link asked for. */
  amount: string;
  /** What the gateway reported capturing - can exceed the balance that was credited. */
  amount_captured: string | null;
  currency: string;
  razorpay_payment_link_id: string | null;
  created_at: string;
  captured_at: string | null;
}

export interface InvoiceItemInput {
  productId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  discountPct?: number;
  taxRate?: number;
}

export interface InvoiceDiscount {
  type: "percent" | "amount" | null;
  value: number;
}

export interface InvoicePatch {
  status?: InvoiceStatus;
  discount?: InvoiceDiscount;
  dueDate?: string | null;
  notes?: string | null;
  customerGstin?: string | null;
  placeOfSupply?: string | null;
  /** IGST (true) or CGST + SGST (false). Locked by the API once money is received. */
  interState?: boolean;
  /** A full replacement of the line items - never a partial patch of one row. */
  items?: InvoiceItemInput[];
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

/**
 * The primary way an invoice gets created in this console: clone an existing
 * quotation into a new draft invoice. No body - the API copies everything
 * (items, discount, currency, account/contact/deal) from the quotation.
 */
export async function createInvoiceFromQuotationAction(
  quotationId: string,
): Promise<{ invoice?: Invoice; items?: InvoiceItem[]; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/invoices/from-quotation/${quotationId}`, {
      method: "POST",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await message(res) };
    const data = (await res.json()) as { invoice: Invoice; items: InvoiceItem[] };
    revalidatePath("/owner/invoices");
    return data;
  } catch {
    return { error: "API unreachable" };
  }
}

export async function updateInvoiceAction(
  id: string,
  patch: InvoicePatch,
): Promise<{ invoice?: Invoice; items?: InvoiceItem[]; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/invoices/${id}`, {
      method: "PATCH",
      headers,
      cache: "no-store",
      body: JSON.stringify(patch),
    });
    if (!res.ok) return { error: await message(res) };
    const data = (await res.json()) as { invoice: Invoice; items: InvoiceItem[] };
    revalidatePath("/owner/invoices");
    revalidatePath(`/owner/invoices/${id}`);
    return data;
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Mint a payment link through the chosen gateway (Razorpay when unspecified,
 * which is the API's default too). A human clicks the button that calls this,
 * gets back a URL, and shares it themselves - there is no auto-send here or
 * on the API side. Can fail with a 503 (gateway not configured on this
 * deployment) or a 400 (nothing outstanding, or a link already out through the
 * other gateway); all come back as `error` for the caller to render as plain
 * text, not to treat as a crash.
 */
export async function createPaymentLinkAction(
  id: string,
  provider: PaymentProvider = "razorpay",
): Promise<{ payment?: Payment; paymentLinkUrl?: string; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/invoices/${id}/payment-link`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify({ provider }),
    });
    if (!res.ok) return { error: await message(res) };
    const data = (await res.json()) as { payment: Payment; paymentLinkUrl: string };
    revalidatePath(`/owner/invoices/${id}`);
    return data;
  } catch {
    return { error: "API unreachable" };
  }
}

// ── The client's own payment gateway (migration 0060, console added with 0095) ──

export interface PaymentSettings {
  keyId: string | null;
  hasSecret: boolean;
  hasWebhookSecret: boolean;
  enabled: boolean;
  /** True while payments still route through the platform's own Razorpay. */
  usingPlatformGateway: boolean;
}

/** One provider's card, as `GET /v1/owner/payment-settings` returns it in `providers`. */
export interface GatewayState extends PaymentSettings {
  provider: PaymentProvider;
  /** The org's own keys are complete and switched on. */
  ownAccount: boolean;
  /** A link can be created through this provider (own keys or the platform's). */
  available: boolean;
}

export interface PaymentSettingsResponse {
  /** The Razorpay card - kept for callers written before Stripe. */
  settings: PaymentSettings;
  providers?: Record<PaymentProvider, GatewayState>;
}

export interface PaymentSettingsDraft {
  /** Omitted means Razorpay, on the API as here. */
  provider?: PaymentProvider;
  keyId: string;
  /** Omitted keeps the stored secret - the API never returns it to be re-sent. */
  keySecret?: string;
  webhookSecret?: string;
  enabled: boolean;
}

/**
 * Owner-only on the API (`@RequireOwnerRole("owner")`): these keys decide which
 * bank account this business's money lands in.
 *
 * Revalidates the OWNER LAYOUT, not just this page, because connecting a
 * gateway completes a required setup step - and the checklist banner lives in
 * the layout. Without this the client would save their keys and still be told
 * to connect a payment account until they next signed in.
 */
export async function savePaymentSettingsAction(
  draft: PaymentSettingsDraft,
): Promise<{ error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/payment-settings`, {
      method: "PUT",
      headers,
      cache: "no-store",
      body: JSON.stringify(draft),
    });
    if (!res.ok) return { error: await message(res) };
    revalidatePath("/owner", "layout");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}
