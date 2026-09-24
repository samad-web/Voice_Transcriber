"use server";

import { revalidatePath } from "next/cache";
import type { PipelineStages } from "@aura/shared";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";
import { apiErrorMessage } from "../lib/api-error";

/**
 * Add a deal from the board, optionally creating its contact on the way.
 *
 * Up to three calls, in order, because the API has no single "deal with a new
 * contact" route and does not need one: contact first (so the deal can point
 * at it), then the deal, then the owner. Owner is a separate PATCH because
 * POST /v1/deals stamps the owner itself - the creator, when their scope is
 * "owned", so a rep never loses sight of a deal they just made - and does not
 * take one in the body.
 *
 * If a later step fails the earlier ones stand, and the message says exactly
 * what exists, rather than pretending nothing happened: a contact created
 * without its deal is still a real contact, and deleting it behind the
 * person's back would be the surprising outcome.
 *
 * A "new" contact whose email the org already has stops at step one with
 * nothing written - the API answers 409 - and, when the API says the person
 * may see that contact, hands it back as `existingContact` so the dialog can
 * offer to put the deal on them instead. Nine times in ten that is what the
 * person meant: they did not find the customer in the search and typed them
 * in again.
 */
export async function addDealAction(input: {
  pipelineId: string;
  stage: string;
  name: string;
  amount: number | null;
  ownerUserId: string | null;
  contact: { kind: "existing"; id: string } | { kind: "new"; displayName: string; email: string | null } | null;
}): Promise<{ dealId?: string; error?: string; existingContact?: ExistingContact }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    let contactId: string | null = null;
    if (input.contact?.kind === "existing") contactId = input.contact.id;
    if (input.contact?.kind === "new") {
      const res = await fetch(`${API_URL}/v1/contacts`, {
        method: "POST",
        headers,
        cache: "no-store",
        body: JSON.stringify({
          displayName: input.contact.displayName,
          ...(input.contact.email ? { email: input.contact.email } : {}),
        }),
      });
      if (res.status === 409) return duplicateContact(res, input.contact.email);
      if (!res.ok) return { error: `Couldn't create the contact: ${await apiErrorMessage(res)}` };
      contactId = ((await res.json()) as { contact: { id: string } }).contact.id;
    }

    const res = await fetch(`${API_URL}/v1/deals`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify({
        pipelineId: input.pipelineId,
        stage: input.stage,
        name: input.name,
        ...(input.amount !== null ? { amount: input.amount } : {}),
        ...(contactId ? { contactId } : {}),
      }),
    });
    if (!res.ok) {
      const why = await apiErrorMessage(res);
      return {
        error:
          input.contact?.kind === "new"
            ? `The contact was created, but the deal wasn't: ${why}`
            : `Couldn't create the deal: ${why}`,
      };
    }
    const dealId = ((await res.json()) as { deal: { id: string } }).deal.id;

    if (input.ownerUserId) {
      const owned = await fetch(`${API_URL}/v1/deals/${dealId}`, {
        method: "PATCH",
        headers,
        cache: "no-store",
        body: JSON.stringify({ ownerUserId: input.ownerUserId }),
      });
      if (!owned.ok) {
        revalidatePath("/owner/deals");
        return { dealId, error: `The deal was added, but its owner wasn't set: ${await apiErrorMessage(owned)}` };
      }
    }

    revalidatePath("/owner/deals");
    return { dealId };
  } catch {
    return { error: "API unreachable" };
  }
}

/** A contact the org already has, as the API's 409 names it. */
export interface ExistingContact {
  id: string;
  displayName: string;
  email: string | null;
}

/**
 * Read POST /v1/contacts' 409 (contacts.controller.ts, `duplicateEmail`).
 *
 * `existing` is null when the caller may not see that contact - then the
 * message says the email is taken and nothing about whose it is, because the
 * API withheld exactly that. Any other 409 shape (an older API, a different
 * conflict) falls back to the API's own message rather than guessing.
 */
async function duplicateContact(
  res: Response,
  email: string | null,
): Promise<{ error: string; existingContact?: ExistingContact }> {
  const body = (await res.json().catch(() => ({}))) as {
    code?: string;
    message?: unknown;
    existing?: { id?: unknown; displayName?: unknown } | null;
  };
  const existing = body.existing;
  if (body.code === "contact_email_exists" && typeof existing?.id === "string") {
    const displayName = typeof existing.displayName === "string" ? existing.displayName : "A contact";
    return {
      error: `${displayName} already has ${email ?? "this email"}. Nothing was added.`,
      existingContact: { id: existing.id, displayName, email },
    };
  }
  if (body.code === "contact_email_exists") {
    return {
      error: `A contact with ${email ?? "this email"} already exists, but it isn't one you can see. Nothing was added - ask whoever owns it, or use a different email.`,
    };
  }
  return {
    error: `Couldn't create the contact: ${typeof body.message === "string" ? body.message : `API ${res.status}`}`,
  };
}

/**
 * How many deals sit in each stage of one pipeline - what "Manage board" needs
 * to refuse removing a column that still has cards.
 *
 * Read from the board endpoint (one card per stage is plenty; only `count` is
 * used) so the numbers are the ones the board itself shows.
 */
export async function stageCountsAction(
  pipelineId: string,
): Promise<{ counts?: Record<string, number>; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(
      `${API_URL}/v1/deals/board?perStage=1&pipelineId=${encodeURIComponent(pipelineId)}`,
      { headers, cache: "no-store" },
    );
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const data = (await res.json()) as { columns: { key: string; count: number }[] };
    return { counts: Object.fromEntries(data.columns.map((c) => [c.key, c.count])) };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Save a pipeline's columns as edited in "Manage board".
 *
 * Plain PATCH `stages`, which does NOT move cards - so the dialog only ever
 * sends lists that keep every stage holding deals (it refuses to remove one
 * with cards, and renames keep the key). Reshaping a board that DOES strand
 * cards is the stage-pack route's job, which moves them in the same
 * transaction; see pipelines.controller.ts.
 */
export async function saveStagesAction(
  pipelineId: string,
  stages: PipelineStages,
): Promise<{ error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}/v1/pipelines/${pipelineId}`, {
      method: "PATCH",
      headers,
      cache: "no-store",
      body: JSON.stringify({ stages }),
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    revalidatePath("/owner/deals");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}
