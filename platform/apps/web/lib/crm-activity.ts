import "server-only";
import type { ApiResult } from "@/lib/api-result";
import {
  interactionToActivity,
  mergeActivity,
  messageToActivity,
  transitionToActivity,
  type ActivityChannel,
  type ActivityItem,
  type InteractionRow,
  type MessageRow,
  type StageTransitionInput,
} from "@/lib/activity";
import type { OwnerMembership, Principal } from "@/lib/owner-context";
import { apiTry } from "@/lib/server-api";

/**
 * Where a contact's 360° activity comes from, per tenant.
 *
 * Same seam as lib/crm-search.ts: one interface, the Aura implementation, and
 * `activitySourceFor` to pick. A tenant whose history lives in another CRM gets
 * an adapter that returns the same `ContactActivity`.
 */
export interface ContactActivity {
  items: ActivityItem[];
  /** Channels that SHOULD be here but could not be read (upstream error) - never permission refusals. */
  unavailable: ActivityChannel[];
  /** True when older interactions exist beyond what was loaded. */
  truncated: boolean;
}

export interface ContactActivitySource {
  forContact(
    contact: { id: string; displayName: string },
    owner: Principal & { membership: OwnerMembership },
    options?: ActivityOptions,
  ): Promise<ContactActivity>;
}

/**
 * How much history to compose (CRM dashboard Phase 8).
 *
 * The timeline used to stop at a hundred logged activities and say so, with no
 * way to see the hundred-and-first - a list that has silently ended. This is
 * the "show older" step, clamped to what the interactions route will serve
 * (limit max 200), so the console can never ask for a page the API refuses.
 */
export interface ActivityOptions {
  interactionLimit?: number;
}

const INTERACTION_LIMIT = 100;
export const INTERACTION_LIMIT_MAX = 200;
const CONVERSATION_LIMIT = 10;
const MESSAGES_PER_CONVERSATION = 100;

interface DealRow {
  id: string;
  name: string;
  pipeline_id: string;
}
interface PipelineRow {
  id: string;
  stages: { key: string; label: string }[];
}

/** A refusal is silence (it would disclose that the data exists); anything else is "unavailable". */
const isDenied = (r: ApiResult<unknown>) => !r.ok && (r.kind === "forbidden" || r.kind === "notfound");

export const auraActivitySource: ContactActivitySource = {
  async forContact(contact, owner, options) {
    const { membership } = owner;
    const interactionLimit = Math.min(
      INTERACTION_LIMIT_MAX,
      Math.max(1, Math.round(options?.interactionLimit ?? INTERACTION_LIMIT)),
    );
    const caller = { ownerRole: membership.ownerRole, userId: owner.userId };
    const get = <T>(path: string) => apiTry<T>(path, membership.orgId, caller);
    const id = encodeURIComponent(contact.id);

    // Each source through its own permission-gated route, in parallel - the
    // same reason search does it this way: contact:view, deal:view and
    // conversation:view are separate grants, and a role holding only the first
    // must still get its part of the feed rather than a blanket 403.
    const [interactions, deals, conversations, pipelines] = await Promise.all([
      get<{ interactions: InteractionRow[]; total: number }>(
        `/v1/contacts/${id}/interactions?limit=${interactionLimit}`,
      ),
      get<{ deals: DealRow[] }>(`/v1/contacts/${id}/deals`),
      get<{ conversations: { id: string }[] }>(
        `/v1/conversations?contactId=${id}&limit=${CONVERSATION_LIMIT}`,
      ),
      get<{ pipelines: PipelineRow[] }>(`/v1/pipelines`),
    ]);

    const dealRows = deals.ok ? deals.data.deals : [];
    const dealNames = Object.fromEntries(dealRows.map((d) => [d.id, d.name]));
    const stageLabel = (pipelineId: string) => (key: string) =>
      (pipelines.ok ? pipelines.data.pipelines : [])
        .find((p) => p.id === pipelineId)
        ?.stages?.find((s) => s.key === key)?.label ?? key;

    // Second fan-out: stage history per deal, messages per thread. A contact
    // has a handful of each; both lists are capped above regardless.
    const [histories, threads] = await Promise.all([
      Promise.all(
        dealRows.map((d) =>
          get<{ transitions: StageTransitionInput[] }>(`/v1/deals/${encodeURIComponent(d.id)}/stage-history`),
        ),
      ),
      Promise.all(
        (conversations.ok ? conversations.data.conversations : []).map((c) =>
          get<{ messages: MessageRow[] }>(`/v1/conversations/${encodeURIComponent(c.id)}`),
        ),
      ),
    ]);

    const context = { contactName: contact.displayName, dealNames };
    const unavailable = new Set<ActivityChannel>();
    const flag = (result: ApiResult<unknown>, channels: ActivityChannel[]) => {
      if (!result.ok && !isDenied(result)) channels.forEach((c) => unavailable.add(c));
    };
    flag(interactions, ["call", "email", "note", "meeting"]);
    flag(deals, ["stage"]);
    flag(conversations, ["whatsapp", "sms"]);
    histories.forEach((h) => flag(h, ["stage"]));
    threads.forEach((t) => flag(t, ["whatsapp", "sms"]));

    const items = mergeActivity(
      interactions.ok ? interactions.data.interactions.map((row) => interactionToActivity(row, context)) : [],
      histories.flatMap((h, i) =>
        h.ok
          ? h.data.transitions.map((t) =>
              transitionToActivity(t, dealRows[i], stageLabel(dealRows[i].pipeline_id)),
            )
          : [],
      ),
      threads.flatMap((t) =>
        t.ok ? t.data.messages.slice(-MESSAGES_PER_CONVERSATION).map((m) => messageToActivity(m, context)) : [],
      ),
    );

    return {
      items,
      unavailable: [...unavailable],
      truncated: interactions.ok && interactions.data.total > interactions.data.interactions.length,
    };
  },
};

/** The activity backend for this tenant - Aura's own tables for every tenant today. */
export function activitySourceFor(_membership: OwnerMembership): ContactActivitySource {
  return auraActivitySource;
}
