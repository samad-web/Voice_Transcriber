"use server";

import { revalidatePath } from "next/cache";
import { validateCriteria, type FunnelCriteria } from "@aura/shared";
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
  crm_satisfied: string | null;
  /** Website, social handle, or whatever they gave us. Free text. */
  digital_presence: string | null;
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
  /** Events Google no longer holds — cancelled now, or already gone. */
  cancelledCalendarEvents?: string[];
  /** Still present in Google, and a human has to remove them. */
  orphanedCalendarEvents?: { eventId: string; error: string }[];
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
      cancelledCalendarEvents: data.cancelledCalendarEvents ?? [],
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
  /** Events Google no longer holds — cancelled now, or already gone. */
  cancelledCalendarEvents?: string[];
  /** Still present in Google, and a human has to remove them. */
  orphanedCalendarEvents?: { eventId: string; error: string }[];
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
      cancelledCalendarEvents: data.cancelledCalendarEvents ?? [],
      orphanedCalendarEvents: data.orphanedCalendarEvents ?? [],
    };
  } catch {
    return { error: "API unreachable — is `pnpm --filter @aura/api dev` running?" };
  }
}

export interface SendConfirmationResult {
  ok?: true;
  /** False when the booking has no Meet link — the message goes without one. */
  hasMeetLink?: boolean;
  meetingUrl?: string | null;
  error?: string;
}

/**
 * Send a booked lead their confirmation — and their Meet link — on WhatsApp.
 *
 * The worker does this automatically for every new booking. This is the manual
 * path, for a resend and for the bookings that predate the feature (migration
 * 0032 settled those as deliberately-not-sent, so the automatic sweep will
 * never pick them up).
 */
export async function sendBookingConfirmationAction(input: {
  leadId: string;
}): Promise<SendConfirmationResult> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  const actor = (await getPrincipal())?.email || "console";
  try {
    const res = await fetch(`${API_URL}/v1/admin/leads/${input.leadId}/send-confirmation`, {
      method: "POST",
      headers: crossTenantHeaders,
      cache: "no-store",
      body: JSON.stringify({ actor }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      // The API's own words: "no booked call", "no phone number". Both are
      // things the operator can act on, so they are shown rather than replaced
      // with a generic failure.
      return { error: `${JSON.stringify(body.message ?? body)}` };
    }
    const data = await res.json();
    revalidatePath("/leads");
    return {
      ok: true,
      hasMeetLink: Boolean(data.hasMeetLink),
      meetingUrl: data.meetingUrl ?? null,
    };
  } catch {
    return { error: "API unreachable — is `pnpm --filter @aura/api dev` running?" };
  }
}

/* ── Message copy ──────────────────────────────────────────────────────────
 *
 * The words sent to an enquirer at each stage, editable without a deploy.
 * Stored in `marketing.message_templates`; the API merges each stored row over
 * the catalogue in @aura/shared so a stage with no row still reports the copy
 * that would actually be sent.
 *
 * BOTH CHANNELS since migration 0053. Email copy used to live in TypeScript in
 * the worker, so it was the one thing on this page an operator could not touch;
 * it now comes back as a second variant per stage, stored and validated exactly
 * like the WhatsApp one.
 */

/** One channel's editable copy for a stage. */
export interface TemplateVariant {
  channel: "whatsapp" | "email";
  /** Email only — null on WhatsApp, which has no subject line. */
  subject: string | null;
  body: string;
  enabled: boolean;
  /** True when somebody has edited it away from the built-in wording. */
  customised: boolean;
  defaultSubject: string | null;
  defaultBody: string;
  /** Per channel: email gets a bigger ceiling than a chat message. */
  maxLength: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface MessageTemplate {
  key: string;
  label: string;
  when: string;
  /** Whether anything in the system queues this today. */
  live: boolean;
  blockedBy: string | null;
  allowedPlaceholders: string[];
  whatsapp: TemplateVariant;
  /** Null for a stage that is deliberately WhatsApp-only. */
  email: TemplateVariant | null;
}

export interface TemplatesResult {
  templates?: MessageTemplate[];
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
    return { templates: data.templates ?? [] };
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
  channel: "whatsapp" | "email";
  /** Email only. Ignored for whatsapp. */
  subject?: string;
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
        body: JSON.stringify({
          channel: input.channel,
          subject: input.subject,
          body: input.body,
          enabled: input.enabled,
          actor,
        }),
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
  channel: "whatsapp" | "email";
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
        body: JSON.stringify({ channel: input.channel, actor }),
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

/* ────────────────────────────────────────────────────────────────────────────
   WhatsApp reachability

   Every message this platform sends an enquirer goes over WhatsApp, and the
   number came from a form they typed it into. A landline, a typo, or a number
   with no WhatsApp account is indistinguishable from a good one until a
   rejection or a confirmation is queued against it and quietly fails. This
   answers that before it happens.

   A check sends NOTHING — it is a presence lookup, and the person sees nothing.
   ──────────────────────────────────────────────────────────────────────────── */

export interface NumberCheck {
  number: string;
  onWhatsApp: boolean;
  verifiedName?: string;
}

export interface WhatsAppCheckResult {
  /** False when the deployment has no Evolution instance wired up at all. */
  configured?: boolean;
  results?: NumberCheck[];
  error?: string;
}

export async function checkWhatsAppNumbersAction(
  numbers: string[],
): Promise<WhatsAppCheckResult> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }

  // Deduped before it leaves the console. Two leads can share a number — the
  // same person enquiring twice is the common case — and checking it twice is
  // avoidable traffic on an unofficial client we would rather not get banned.
  const unique = [...new Set(numbers.map((n) => n.trim()).filter(Boolean))].slice(0, 50);
  if (unique.length === 0) return { configured: true, results: [] };

  try {
    const res = await fetch(`${API_URL}/v1/admin/whatsapp/check`, {
      method: "POST",
      headers: crossTenantHeaders,
      cache: "no-store",
      body: JSON.stringify({ numbers: unique }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 404) {
        return { error: "The WhatsApp check endpoint is not available. Is the API on the current build?" };
      }
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    const data = await res.json();
    return { configured: data.configured, results: data.results ?? [] };
  } catch {
    return { error: "API unreachable — is `pnpm --filter @aura/api dev` running?" };
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   Qualification criteria

   Who counts as a lead. Held in the database and edited here rather than
   compiled into a release, because it is a commercial decision that changes
   more often than the code does.
   ──────────────────────────────────────────────────────────────────────────── */

export interface CriteriaResult {
  criteria?: FunnelCriteria;
  updatedAt?: string;
  updatedBy?: string | null;
  error?: string;
}

export async function getFunnelCriteriaAction(): Promise<CriteriaResult> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  try {
    const res = await fetch(`${API_URL}/v1/admin/funnel-criteria`, {
      headers: crossTenantHeaders,
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 404) {
        return { error: "The criteria endpoint is not available. Is the API on the current build?" };
      }
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    const data = await res.json();
    return { criteria: data.criteria, updatedAt: data.updatedAt, updatedBy: data.updatedBy };
  } catch {
    return { error: "API unreachable — is `pnpm --filter @aura/api dev` running?" };
  }
}

export async function saveFunnelCriteriaAction(criteria: FunnelCriteria): Promise<CriteriaResult> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  const actor = (await getPrincipal())?.email || "console";

  // Checked here as well as in the API. Same function, so the two cannot
  // disagree — this one just gets the operator a red line without a round trip.
  const check = validateCriteria(criteria);
  if (!check.ok) return { error: check.error };

  try {
    const res = await fetch(`${API_URL}/v1/admin/funnel-criteria`, {
      method: "PUT",
      headers: crossTenantHeaders,
      cache: "no-store",
      body: JSON.stringify({ ...criteria, actor }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    const data = await res.json();
    revalidatePath("/leads");
    return { criteria: data.criteria };
  } catch {
    return { error: "API unreachable — is `pnpm --filter @aura/api dev` running?" };
  }
}
