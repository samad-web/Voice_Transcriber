"use server";

import { revalidatePath } from "next/cache";
import { requireOperator } from "@/lib/operator-guard";
import { getPrincipal } from "@/lib/owner-context";
import { API_URL, crossTenantHeaders } from "@/lib/server-api";

/**
 * Converting a marketing lead into a client.
 *
 * EVERY exported function here calls requireOperator() FIRST. A Server Action is
 * an independently-addressable POST endpoint — the `(platform)` layout's operator
 * check gates rendering, not invocation — and these actions send the root
 * ADMIN_API_KEY. Unguarded, any signed-in account could provision tenants and
 * read every enquirer's phone number and email.
 */

export interface Lead {
  id: string;
  name: string;
  email: string;
  phone_e164: string;
  whatsapp_e164: string | null;
  country_code: string;
  business_type: string | null;
  team_size: string | null;
  budget_inr: string | null;
  intent: string | null;
  has_crm: string | null;
  crm_name: string | null;
  wants_custom_crm: string | null;
  crm_connector_status: string | null;
  status: string;
  contact_attempts: number;
  last_contacted_at: string;
  created_at: string;
  converted_org_id: string | null;
  converted_at: string | null;
  converted_by: string | null;
  converted_org_name: string | null;
  /**
   * The call this person booked, if they booked one. Null for everyone else,
   * which is most of them — booking is offered only on the qualified path.
   */
  booked_starts_at: string | null;
  booked_ends_at: string | null;
  booked_meeting_url: string | null;
}

export interface LeadsResult {
  leads?: Lead[];
  error?: string;
}

export async function listLeadsAction(
  state: "all" | "open" | "converted" = "open",
): Promise<LeadsResult> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  try {
    const res = await fetch(`${API_URL}/v1/admin/leads?state=${state}&limit=200`, {
      headers: crossTenantHeaders,
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      // A 404 on this route almost always means the API is running without the
      // leads module, and a 500 usually means migration 0020/0021 has not been
      // applied to whichever database it is pointed at. Say so, rather than
      // showing an empty table that looks like "no leads yet".
      if (res.status === 404) {
        return { error: "The leads endpoint is not available. Is the API running the current build?" };
      }
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    const data = await res.json();
    return { leads: data.leads ?? [] };
  } catch {
    return { error: "API unreachable — is `pnpm --filter @aura/api dev` running?" };
  }
}

export interface ConvertResult {
  error?: string;
  orgId?: string;
  orgName?: string;
  instanceId?: string;
  /** Returned by the API exactly once. Never stored, never re-fetchable. */
  adminKey?: string;
  expiresAt?: string;
  maxUses?: number;
}

/**
 * Provision a client from a lead, then link the two.
 *
 * Two calls, on purpose. Provisioning already exists as POST /v1/admin/tenants
 * and mints a one-time enrollment credential inside a five-table transaction;
 * duplicating that in a leads endpoint would give the codebase two copies of it.
 *
 * The ordering matters and is not arbitrary. Provision first, link second: if
 * the link fails the operator has a real, usable tenant and a lead that still
 * shows as open, which is a visible inconsistency they can retry. Linking first
 * would mark the lead converted and then possibly fail to create anything,
 * hiding the lead from the working view with no client to show for it.
 */
export async function convertLeadAction(input: {
  leadId: string;
  orgName: string;
  consentPolicy: string;
  retentionDays: number;
  ttlMinutes: number;
  maxUses: number;
}): Promise<ConvertResult> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  // Bare `await requireOperator()` first, with the principal fetched separately
  // afterwards, because the guard must be the FIRST statement — not the first
  // statement that also assigns something. `let actor = "console"` sitting above
  // it was enough to fail platform-actions.guard.test.ts, and that test is
  // right: the rule has to be mechanically checkable to survive future edits.
  // `||` not `??`. getPrincipal() can return a principal whose email is an
  // empty string (no session in development), and `?? "console"` only replaces
  // null or undefined — so "" sailed through and the API rejected the request
  // with `actor: too_small`. Found by clicking the button, not by typechecking.
  const actor = (await getPrincipal())?.email || "console";

  let provisioned: {
    orgId: string;
    instanceId: string;
    adminKey: string;
    expiresAt: string;
    maxUses: number;
    name: string;
  };
  try {
    const res = await fetch(`${API_URL}/v1/admin/tenants`, {
      method: "POST",
      headers: crossTenantHeaders,
      cache: "no-store",
      body: JSON.stringify({
        name: input.orgName,
        workspaceName: input.orgName,
        consentPolicy: input.consentPolicy,
        retentionDays: input.retentionDays,
        tokenTtlMinutes: input.ttlMinutes,
        tokenMaxUses: input.maxUses,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `Could not create the client — API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    const data = await res.json();
    provisioned = {
      orgId: data.enrollment.orgId,
      instanceId: data.enrollment.instanceId,
      adminKey: data.enrollment.adminKey,
      expiresAt: data.enrollment.expiresAt,
      maxUses: data.enrollment.maxUses,
      name: data.tenant.name,
    };
  } catch {
    return { error: "API unreachable — is `pnpm --filter @aura/api dev` running?" };
  }

  // Link. A failure here is reported WITH the enrollment key, because the key is
  // returned exactly once and swallowing it to report an error would leave the
  // operator with a tenant they can never enroll a handset against.
  try {
    const res = await fetch(`${API_URL}/v1/admin/leads/${input.leadId}/link`, {
      method: "POST",
      headers: crossTenantHeaders,
      cache: "no-store",
      body: JSON.stringify({ orgId: provisioned.orgId, actor }),
    });
    if (!res.ok) {
      return {
        ...provisioned,
        orgName: provisioned.name,
        error:
          `The client was created, but the lead could not be marked converted (API ${res.status}). ` +
          `Save the enrollment key below — it is shown only once.`,
      };
    }
  } catch {
    return {
      ...provisioned,
      orgName: provisioned.name,
      error:
        "The client was created, but marking the lead converted failed. " +
        "Save the enrollment key below — it is shown only once.",
    };
  }

  revalidatePath("/leads");
  revalidatePath("/instances");
  return { ...provisioned, orgName: provisioned.name };
}

export interface DeleteLeadsResult {
  deleted?: number;
  slotsReleased?: number;
  orphanedCalendarEvents?: string[];
  error?: string;
}

/**
 * Delete enquiries permanently.
 *
 * Not the same as rejecting. Rejecting records a decision and tells the person;
 * this removes them from the database, which is what a DPDP erasure request
 * requires and what clearing out test data needs.
 *
 * `scope` is passed through explicitly rather than inferred from whether `ids`
 * is empty: an empty array meaning "everything" is the kind of default that
 * deletes a table by accident.
 */
export async function deleteLeadsAction(input: {
  scope: "selected" | "all";
  ids?: string[];
}): Promise<DeleteLeadsResult> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  try {
    const res = await fetch(`${API_URL}/v1/admin/leads/delete`, {
      method: "POST",
      headers: crossTenantHeaders,
      cache: "no-store",
      body: JSON.stringify({ scope: input.scope, ids: input.ids }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    const data = await res.json();
    revalidatePath("/leads");
    // Deleting can hand booked time back, so the diary changed too.
    revalidatePath("/slots");
    return {
      deleted: data.deleted ?? 0,
      slotsReleased: data.slotsReleased ?? 0,
      orphanedCalendarEvents: data.orphanedCalendarEvents ?? [],
    };
  } catch {
    return { error: "API unreachable — is `pnpm --filter @aura/api dev` running?" };
  }
}

export interface RejectResult {
  ok?: boolean;
  queuedEmail?: boolean;
  queuedWhatsapp?: boolean;
  /** Booked calls handed back to the diary. Usually none. */
  releasedSlots?: Array<{ id: string; startsAt: string }>;
  /** Google Calendar events the API could not delete — see the reject panel. */
  orphanedCalendarEvents?: string[];
  error?: string;
}

/**
 * Reject a lead and queue the message that tells them.
 *
 * The API does both in one transaction, so a rejection can never end up
 * recorded with nobody informed.
 */
export async function rejectLeadAction(input: {
  leadId: string;
  reason?: string;
  notify: boolean;
  notifyWhatsapp: boolean;
}): Promise<RejectResult> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  const actor = (await getPrincipal())?.email || "console";
  try {
    const res = await fetch(`${API_URL}/v1/admin/leads/${input.leadId}/reject`, {
      method: "POST",
      headers: crossTenantHeaders,
      cache: "no-store",
      body: JSON.stringify({
        reason: input.reason || undefined,
        notify: input.notify,
        notifyWhatsapp: input.notifyWhatsapp,
        actor,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    const data = await res.json();
    revalidatePath("/leads");
    // The diary changed too, so its cached page has to go — otherwise the
    // released hour still shows as booked on /slots until something else
    // happens to revalidate it.
    revalidatePath("/slots");
    return {
      ok: true,
      queuedEmail: Boolean(data.queuedEmail),
      queuedWhatsapp: Boolean(data.queuedWhatsapp),
      releasedSlots: data.releasedSlots ?? [],
      orphanedCalendarEvents: data.orphanedCalendarEvents ?? [],
    };
  } catch {
    return { error: "API unreachable — is `pnpm --filter @aura/api dev` running?" };
  }
}

/* ── WhatsApp message copy ─────────────────────────────────────────────────
 *
 * The words sent to an enquirer at each stage, editable without a deploy.
 * Stored in `marketing.message_templates`; the API merges each stored row over
 * the catalogue in @aura/shared so a stage with no row still reports the copy
 * that would actually be sent.
 */

export interface MessageTemplate {
  key: string;
  label: string;
  when: string;
  /** Whether anything in the system queues this today. */
  live: boolean;
  blockedBy: string | null;
  allowedPlaceholders: string[];
  body: string;
  enabled: boolean;
  /** True when somebody has edited it away from the built-in wording. */
  customised: boolean;
  defaultBody: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface TemplatesResult {
  templates?: MessageTemplate[];
  maxLength?: number;
  error?: string;
}

export async function listMessageTemplatesAction(): Promise<TemplatesResult> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  try {
    const res = await fetch(`${API_URL}/v1/admin/message-templates`, {
      headers: crossTenantHeaders,
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 404) {
        return { error: "The message-templates endpoint is not available. Is the API on the current build?" };
      }
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    const data = await res.json();
    return { templates: data.templates ?? [], maxLength: data.maxLength };
  } catch {
    return { error: "API unreachable — is `pnpm --filter @aura/api dev` running?" };
  }
}

export interface SaveTemplateResult {
  ok?: boolean;
  error?: string;
}

export async function saveMessageTemplateAction(input: {
  key: string;
  body: string;
  enabled: boolean;
}): Promise<SaveTemplateResult> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  // `||` not `??` — getPrincipal() can return an empty-string email in
  // development, and the API rejects it as `actor: too_small`.
  const actor = (await getPrincipal())?.email || "console";
  try {
    const res = await fetch(
      `${API_URL}/v1/admin/message-templates/${encodeURIComponent(input.key)}`,
      {
        method: "PUT",
        headers: crossTenantHeaders,
        cache: "no-store",
        body: JSON.stringify({ body: input.body, enabled: input.enabled, actor }),
      },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      // A 400 here is the shared validator rejecting a placeholder or a length,
      // and its message is written for the operator. Surfaced verbatim rather
      // than wrapped in "API 400", which would bury the only useful sentence.
      const message = body.message ?? body;
      return { error: typeof message === "string" ? message : JSON.stringify(message) };
    }
    revalidatePath("/leads");
    return { ok: true };
  } catch {
    return { error: "API unreachable — is `pnpm --filter @aura/api dev` running?" };
  }
}

export async function resetMessageTemplateAction(input: {
  key: string;
}): Promise<SaveTemplateResult> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  const actor = (await getPrincipal())?.email || "console";
  try {
    const res = await fetch(
      `${API_URL}/v1/admin/message-templates/${encodeURIComponent(input.key)}/reset`,
      {
        method: "POST",
        headers: crossTenantHeaders,
        cache: "no-store",
        body: JSON.stringify({ actor }),
      },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    revalidatePath("/leads");
    return { ok: true };
  } catch {
    return { error: "API unreachable — is `pnpm --filter @aura/api dev` running?" };
  }
}
