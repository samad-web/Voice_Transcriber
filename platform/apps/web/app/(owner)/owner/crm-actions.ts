"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "./actions";
import type { Account, Contact, Deal } from "./types";

/**
 * CRM Phase 1 foundation (E0.1) — mutations for the new Deal/Contact/Account
 * objects. Same shape as actions.ts's lead actions deliberately: every action
 * re-resolves the owner from the session via `ownerHeaders()` rather than
 * trusting an org id from the client, since a server action is a public
 * endpoint.
 */

export interface ActionResult {
  error?: string;
}

export interface DealUpdate {
  stage?: string;
  name?: string;
  amount?: number | null;
  expectedCloseDate?: string | null;
  summary?: string | null;
  nextAction?: string | null;
  notes?: string | null;
  contactId?: string | null;
  accountId?: string | null;
}

/**
 * Move a card, or edit what's on it — the deal-board counterpart to
 * updateLeadAction. The board applies the move optimistically and calls
 * this; on failure it rolls the card back.
 */
export async function updateDealAction(
  dealId: string,
  update: DealUpdate,
): Promise<ActionResult & { deal?: Partial<Deal> }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/deals/${dealId}`, {
      method: "PATCH",
      headers,
      cache: "no-store",
      body: JSON.stringify(update),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const detail = body?.message ?? body;
      return { error: typeof detail === "string" ? detail : `API ${res.status}` };
    }
    const data = (await res.json()) as { deal: Partial<Deal> };
    revalidatePath("/owner/deals");
    revalidatePath("/owner/contacts");
    revalidatePath("/owner/accounts");
    return { deal: data.deal };
  } catch {
    return { error: "API unreachable" };
  }
}

/** Deal detail for the drawer — reads the same joined shape the board/list already carry. */
export async function fetchDealAction(dealId: string): Promise<{ deal?: Deal; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/deals/${dealId}`, { headers, cache: "no-store" });
    if (!res.ok) return { error: `API ${res.status}` };
    return (await res.json()) as { deal: Deal };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function fetchContactAction(
  contactId: string,
): Promise<{ contact?: Contact; deals?: Deal[]; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const [contactRes, dealsRes] = await Promise.all([
      fetch(`${API_URL}/v1/contacts/${contactId}`, { headers, cache: "no-store" }),
      fetch(`${API_URL}/v1/contacts/${contactId}/deals`, { headers, cache: "no-store" }),
    ]);
    if (!contactRes.ok) return { error: `API ${contactRes.status}` };
    const { contact } = (await contactRes.json()) as { contact: Contact };
    const { deals } = dealsRes.ok
      ? ((await dealsRes.json()) as { deals: Deal[] })
      : { deals: [] };
    return { contact, deals };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function fetchAccountAction(
  accountId: string,
): Promise<{ account?: Account; contacts?: Contact[]; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/accounts/${accountId}`, { headers, cache: "no-store" });
    if (!res.ok) return { error: `API ${res.status}` };
    return (await res.json()) as { account: Account; contacts: Contact[] };
  } catch {
    return { error: "API unreachable" };
  }
}
