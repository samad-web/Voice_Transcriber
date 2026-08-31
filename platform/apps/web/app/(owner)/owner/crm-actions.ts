"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { errorText, ownerHeaders, patchRecordAction } from "./actions";
import type {
  Account,
  Contact,
  Deal,
  DuplicateMatch,
  Interaction,
  RecordCustomField,
  Task,
} from "./types";

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
  const result = await patchRecordAction<{ deal: Partial<Deal> }>(`/v1/deals/${dealId}`, update, [
    "/owner/deals",
    "/owner/contacts",
    "/owner/accounts",
  ]);
  return result.error ? { error: result.error } : { deal: result.data?.deal };
}

/**
 * Duplicate detection & merge (E0.3) — exact-match only (external_id
 * collisions), see merge.controller.ts's header for why phone/email/domain
 * aren't scanned. Same ownerHeaders()-first shape as the actions above.
 */

export async function scanDuplicatesAction(
  objectType: "contact" | "account",
): Promise<
  ActionResult & {
    scanned?: number;
    newCandidates?: number;
    /** Whether the trigram pass actually ran — see merge.controller.ts. */
    fuzzy?: "ran" | "unavailable" | "skipped";
    threshold?: number;
  }
> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/merge/scan?objectType=${objectType}`, {
      method: "POST",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    const data = (await res.json()) as {
      scanned: number;
      newCandidates: number;
      fuzzy: "ran" | "unavailable" | "skipped";
      threshold: number;
    };
    revalidatePath("/owner/duplicates");
    return data;
  } catch {
    return { error: "API unreachable" };
  }
}

export async function dismissDuplicateAction(id: string): Promise<ActionResult> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/merge/duplicates/${id}/dismiss`, {
      method: "POST",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    revalidatePath("/owner/duplicates");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}

/** Keeps `survivorId`'s own fields (no field-by-field picker in this UI — see
 *  duplicates-manager.tsx), additively merging facts/external_ids from the
 *  side being absorbed. */
export async function mergeRecordsAction(
  objectType: "contact" | "account",
  survivorId: string,
  victimId: string,
): Promise<ActionResult & { mergeId?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/merge`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify({ objectType, survivorId, victimId, fieldDecisions: {} }),
    });
    if (!res.ok) return { error: await errorText(res) };
    const data = (await res.json()) as { mergeId: string };
    revalidatePath("/owner/duplicates");
    revalidatePath("/owner/contacts");
    revalidatePath("/owner/accounts");
    revalidatePath("/owner/deals");
    return { mergeId: data.mergeId };
  } catch {
    return { error: "API unreachable" };
  }
}

// ── Track A2: the interaction timeline ──────────────────────────────────────

/** Which object's timeline — mirrors the API's nested route shape exactly. */
export type TimelineParent = "contacts" | "accounts" | "deals";

export async function fetchInteractionsAction(
  parent: TimelineParent,
  parentId: string,
  limit = 50,
): Promise<{ interactions?: Interaction[]; total?: number; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(
      `${API_URL}/v1/${parent}/${parentId}/interactions?limit=${limit}`,
      { headers, cache: "no-store" },
    );
    if (!res.ok) return { error: `API ${res.status}` };
    return (await res.json()) as { interactions: Interaction[]; total: number };
  } catch {
    return { error: "API unreachable" };
  }
}

export interface LogInteractionInput {
  type: "email" | "sms" | "whatsapp" | "meeting" | "note";
  subject?: string | null;
  body?: string | null;
  direction?: "incoming" | "outgoing" | null;
}

/**
 * Log something that happened by hand. `call` is deliberately not an option —
 * calls reach the timeline through the worker, and letting a human type one in
 * would put a row on the timeline that no recording backs.
 */
export async function logInteractionAction(
  parent: TimelineParent,
  parentId: string,
  input: LogInteractionInput,
): Promise<ActionResult & { interaction?: Interaction }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/${parent}/${parentId}/interactions`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const detail = body?.message;
      return {
        error: Array.isArray(detail)
          ? detail.map((d: { message?: string }) => d.message).join("; ")
          : typeof detail === "string"
            ? detail
            : `API ${res.status}`,
      };
    }
    const data = (await res.json()) as { interaction: Interaction };
    revalidatePath("/owner/deals");
    revalidatePath("/owner/contacts");
    revalidatePath("/owner/accounts");
    return { interaction: data.interaction };
  } catch {
    return { error: "API unreachable" };
  }
}

// ── Track A3: follow-up tasks ───────────────────────────────────────────────

export interface TaskInputPayload {
  title: string;
  notes?: string | null;
  dueOn?: string | null;
  priority?: "low" | "normal" | "high";
  dealId?: string | null;
  contactId?: string | null;
  accountId?: string | null;
  assigneeUserId?: string | null;
}

export async function createTaskAction(
  input: TaskInputPayload,
): Promise<ActionResult & { task?: Task }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/tasks`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify(input),
    });
    if (!res.ok) return { error: await errorText(res) };
    const data = (await res.json()) as { task: Task };
    revalidatePath("/owner/tasks");
    revalidatePath("/owner/deals");
    return { task: data.task };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function updateTaskAction(
  taskId: string,
  update: {
    status?: "open" | "done" | "cancelled";
    title?: string;
    notes?: string | null;
    dueOn?: string | null;
    priority?: "low" | "normal" | "high";
    assigneeUserId?: string | null;
  },
): Promise<ActionResult & { task?: Task }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/tasks/${taskId}`, {
      method: "PATCH",
      headers,
      cache: "no-store",
      body: JSON.stringify(update),
    });
    if (!res.ok) return { error: await errorText(res) };
    const data = (await res.json()) as { task: Task };
    revalidatePath("/owner/tasks");
    revalidatePath("/owner/deals");
    return { task: data.task };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function fetchTasksAction(
  query: {
    dealId?: string;
    contactId?: string;
    accountId?: string;
    status?: string;
    limit?: number;
  } = {},
): Promise<{ tasks?: Task[]; total?: number; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  const params = new URLSearchParams();
  if (query.dealId) params.set("dealId", query.dealId);
  if (query.contactId) params.set("contactId", query.contactId);
  if (query.accountId) params.set("accountId", query.accountId);
  if (query.status) params.set("status", query.status);
  params.set("limit", String(query.limit ?? 50));

  try {
    const res = await fetch(`${API_URL}/v1/tasks?${params}`, { headers, cache: "no-store" });
    if (!res.ok) return { error: `API ${res.status}` };
    return (await res.json()) as { tasks: Task[]; total: number };
  } catch {
    return { error: "API unreachable" };
  }
}

// ── Record lookup (for `lookup` custom fields) ──────────────────────────────

export interface RecordOption {
  id: string;
  label: string;
  detail: string | null;
}

/**
 * Search contacts / accounts / deals by name, for a picker.
 *
 * Goes through the ordinary list endpoints rather than a new search route, so
 * it inherits their permission gate AND their `owned` scope for free: a rep
 * restricted to their own records cannot use a lookup field as a way to
 * enumerate a colleague's. That is worth more than the round trip it costs.
 */
export async function searchRecordsAction(
  objectType: "contact" | "account" | "deal",
  q: string,
): Promise<{ records?: RecordOption[]; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  const path = `${objectType}s`;
  const query = new URLSearchParams({ limit: "10" });
  if (q.trim()) query.set("q", q.trim());

  try {
    const res = await fetch(`${API_URL}/v1/${path}?${query}`, { headers, cache: "no-store" });
    if (!res.ok) return { error: `API ${res.status}` };
    const data = (await res.json()) as {
      contacts?: Contact[];
      accounts?: Account[];
      deals?: Deal[];
    };

    if (objectType === "contact") {
      return {
        records: (data.contacts ?? []).map((c) => ({
          id: c.id,
          label: c.display_name,
          detail: c.email ?? c.title ?? null,
        })),
      };
    }
    if (objectType === "account") {
      return {
        records: (data.accounts ?? []).map((a) => ({
          id: a.id,
          label: a.name,
          detail: a.domain,
        })),
      };
    }
    return {
      records: (data.deals ?? []).map((d) => ({
        id: d.id,
        label: d.name,
        detail: d.stage,
      })),
    };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * The label for ONE record, so a picker holding a stored id can show a name
 * instead of a uuid.
 *
 * Returns null rather than erroring when the record is gone or invisible —
 * a lookup pointing at a deleted record should read as "unknown record",
 * not break the whole form it sits in.
 */
export async function resolveRecordAction(
  objectType: "contact" | "account" | "deal",
  id: string,
): Promise<RecordOption | null> {
  const headers = await ownerHeaders();
  if (!headers) return null;

  try {
    const res = await fetch(`${API_URL}/v1/${objectType}s/${id}`, { headers, cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      contact?: Contact;
      account?: Account;
      deal?: Deal;
    };
    if (data.contact) {
      return { id, label: data.contact.display_name, detail: data.contact.email };
    }
    if (data.account) return { id, label: data.account.name, detail: data.account.domain };
    if (data.deal) return { id, label: data.deal.name, detail: data.deal.stage };
    return null;
  } catch {
    return null;
  }
}

// ── Sending mail to a contact ───────────────────────────────────────────────

/**
 * One message, to the contact named by `contactId`, from the signed-in user's
 * own connected mailbox.
 *
 * There is no recipient parameter, and that is the design — the API reads the
 * address from the contact row, so neither this action nor anything calling it
 * can point a send at an arbitrary inbox. See outbound-mail.controller.ts.
 */
export async function sendContactEmailAction(
  contactId: string,
  input: { subject: string; body: string },
): Promise<ActionResult & { sent?: boolean; to?: string; interaction?: Interaction | null }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/contacts/${contactId}/email`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify(input),
    });
    if (!res.ok) return { error: await errorText(res) };
    const data = (await res.json()) as {
      sent: boolean;
      to: string;
      interaction: Interaction | null;
    };
    revalidatePath("/owner/contacts");
    return data;
  } catch {
    return { error: "API unreachable" };
  }
}

// ── Stage history (migration 0046) ──────────────────────────────────────────

export interface StageTransitionRow {
  id: string;
  from_stage: string | null;
  to_stage: string;
  from_status: string | null;
  to_status: string;
  source: "console" | "pipeline" | "automation" | "backfill";
  occurred_at: string;
  actor: string | null;
  days_in_stage: number | null;
}

export async function fetchStageHistoryAction(
  dealId: string,
): Promise<{ transitions?: StageTransitionRow[]; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/deals/${dealId}/stage-history`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    return (await res.json()) as { transitions: StageTransitionRow[] };
  } catch {
    return { error: "API unreachable" };
  }
}

// ── Custom field values on a record ─────────────────────────────────────────

/**
 * The definitions and their values in one response — see
 * custom-field-values.controller.ts for why the API joins them rather than
 * making every caller do it.
 */
export async function fetchCustomFieldsAction(
  parent: TimelineParent,
  parentId: string,
): Promise<{ fields?: RecordCustomField[]; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/${parent}/${parentId}/custom-fields`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    return (await res.json()) as { fields: RecordCustomField[] };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Partial save: only the keys present are touched, and a key mapped to `null`
 * clears that field. Anything a person writes here becomes `source: 'human'`
 * server-side, which stops the next AI extraction from overwriting it.
 */
export async function saveCustomFieldsAction(
  parent: TimelineParent,
  parentId: string,
  values: Record<string, unknown>,
): Promise<ActionResult & { fields?: RecordCustomField[] }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/${parent}/${parentId}/custom-fields`, {
      method: "PUT",
      headers,
      cache: "no-store",
      body: JSON.stringify({ values }),
    });
    if (!res.ok) return { error: await errorText(res) };
    const data = (await res.json()) as { fields: RecordCustomField[] };
    revalidatePath("/owner/deals");
    revalidatePath("/owner/contacts");
    revalidatePath("/owner/accounts");
    return { fields: data.fields };
  } catch {
    return { error: "API unreachable" };
  }
}
