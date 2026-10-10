import "server-only";
import type { ApiResult } from "@/lib/api-result";
import type { getOwner } from "@/lib/owner-context";
import {
  reviewSourceSpec,
  reviewSourcesFor,
  type ReviewDuplicate,
  type ReviewItem,
  type ReviewOptOut,
  type ReviewAgentAction,
  type ReviewQualification,
  type ReviewSourceKey,
} from "@/lib/review-queue";
import { apiTry } from "@/lib/server-api";

/**
 * Where the review queue's items come from - one adapter per source.
 *
 * The seam the dashboard's other modules have (`CrmSearchSource`,
 * `ContactActivitySource`): a tenant whose proposals live in a different
 * backend gets a different adapter behind the same key, and the page, the
 * cards and the ordering rules do not change.
 *
 * Each adapter goes through its OWN permission-gated route, and a refusal
 * yields an empty source rather than failing the page - a telecaller who holds
 * `conversation:view` but not the duplicates grant still gets the WhatsApp
 * half. A 5xx is different: that source says it could not be loaded, because
 * an empty list and a broken one must not look the same.
 */

type Owner = NonNullable<Awaited<ReturnType<typeof getOwner>>>;

export interface ReviewSourceLoad {
  items: ReviewItem[];
  /** Waiting in total, which can exceed `items` when the source pages. */
  total: number;
  unavailable: boolean;
  /**
   * The API REFUSED this person, rather than failing. Kept apart from
   * `unavailable` because the two mean opposite things to a reader: one is
   * "this is not yours", the other is "this is broken".
   */
  denied: boolean;
}

export interface ReviewLoadOptions {
  /** WhatsApp only: include junk the qualifier would normally hide. */
  includeJunk: boolean;
}

export interface ReviewSourceAdapter {
  key: ReviewSourceKey;
  load(owner: Owner, options: ReviewLoadOptions): Promise<ReviewSourceLoad>;
}

const LIMIT = 50;

function get<T>(owner: Owner, path: string): Promise<ApiResult<T>> {
  return apiTry<T>(path, owner.membership.orgId, {
    ownerRole: owner.membership.ownerRole,
    userId: owner.userId,
  });
}

function settle<T>(
  result: ApiResult<T>,
  pick: (data: T) => { items: ReviewItem[]; total: number },
): ReviewSourceLoad {
  if (result.ok) return { ...pick(result.data), unavailable: false, denied: false };
  const denied = result.kind === "forbidden" || result.kind === "notfound";
  return { items: [], total: 0, unavailable: !denied, denied };
}

export const auraWhatsAppReviewSource: ReviewSourceAdapter = {
  key: "whatsapp",
  async load(owner, { includeJunk }) {
    const params = new URLSearchParams({ status: "pending", limit: String(LIMIT) });
    if (includeJunk) params.set("includeJunk", "true");
    const result = await get<{ items: ReviewQualification[] }>(
      owner,
      `/v1/conversation-qualifications?${params.toString()}`,
    );
    return settle(result, (data) => ({
      items: data.items.map((q) => ({
        source: "whatsapp" as const,
        id: q.id,
        waitingSince: q.created_at,
        qualification: q,
      })),
      total: data.items.length,
    }));
  },
};

export const auraOptOutReviewSource: ReviewSourceAdapter = {
  key: "opt_outs",
  async load(owner) {
    const result = await get<{ items: ReviewOptOut[]; total: number }>(owner, `/v1/opt-outs?limit=${LIMIT}`);
    return settle(result, (data) => ({
      items: data.items.map((o) => ({
        source: "opt_outs" as const,
        id: o.id,
        waitingSince: o.created_at,
        optOut: o,
      })),
      total: data.total,
    }));
  },
};

export const auraDuplicateReviewSource: ReviewSourceAdapter = {
  key: "duplicates",
  async load(owner) {
    const result = await get<{ duplicates: ReviewDuplicate[] }>(owner, `/v1/merge/duplicates?status=pending`);
    return settle(result, (data) => ({
      items: data.duplicates.map((d) => ({
        source: "duplicates" as const,
        id: d.id,
        waitingSince: d.created_at,
        duplicate: d,
      })),
      total: data.duplicates.length,
    }));
  },
};

/** This deployment's adapters. A tenant-specific backend swaps entries here. */
/**
 * §12's review inbox, as a source of this queue rather than a page of its own.
 *
 * ── WHY IT IS NOT ITS OWN SCREEN ──────────────────────────────────────────
 *
 * "Needs review" already exists and already means one thing: something a
 * machine proposed that a person must decide. A second screen with the same
 * job would split a telecaller's attention between two inboxes, and the one
 * with the SLA timer is the one they would miss.
 *
 * `pending_review` only. The other states (`done`, `rejected`, `frozen`) are
 * history and belong in the call's own timeline; a queue that shows them is a
 * queue nobody can empty.
 */
export const auraAgentActionReviewSource: ReviewSourceAdapter = {
  key: "agent_actions",
  async load(owner) {
    const result = await get<{ items: ReviewAgentAction[] }>(
      owner,
      `/v1/transcript-agent/review?state=pending_review&limit=${LIMIT}`,
    );
    return settle(result, (data) => ({
      items: data.items.map((action) => ({
        source: "agent_actions" as const,
        id: action.id,
        waitingSince: action.requested_at,
        agentAction: action,
      })),
      total: data.items.length,
    }));
  },
};

export const REVIEW_ADAPTERS: Record<ReviewSourceKey, ReviewSourceAdapter> = {
  agent_actions: auraAgentActionReviewSource,
  whatsapp: auraWhatsAppReviewSource,
  opt_outs: auraOptOutReviewSource,
  duplicates: auraDuplicateReviewSource,
};

export interface ReviewQueueData {
  available: ReviewSourceKey[];
  items: ReviewItem[];
  totals: Partial<Record<ReviewSourceKey, number>>;
  unavailable: ReviewSourceKey[];
}

/**
 * Load every source this person may review, in parallel.
 *
 * All of them even when one tab is selected: the tab row shows a count per
 * source, and a count that only appears once you click the tab is not a count.
 */
export async function loadReviewQueue(owner: Owner, options: ReviewLoadOptions): Promise<ReviewQueueData> {
  const { ownerRole, enabledModules, featureOverrides } = owner.membership;
  const offered = reviewSourcesFor(ownerRole, enabledModules, featureOverrides);
  const loads = await Promise.all(offered.map((key) => REVIEW_ADAPTERS[key].load(owner, options)));

  // §3A.4: "agent sections are HIDDEN, not greyed out". A source that says so
  // on its spec loses its TAB when its API refuses this person, rather than
  // showing a zero they cannot do anything about. Every other source keeps the
  // tab - see `hideWhenDenied`'s own note for why the default is the opposite.
  const available = offered.filter(
    (key, index) => !(loads[index].denied && reviewSourceSpec(key).hideWhenDenied),
  );

  const totals: Partial<Record<ReviewSourceKey, number>> = {};
  const unavailable: ReviewSourceKey[] = [];
  const items: ReviewItem[] = [];
  offered.forEach((key, index) => {
    if (!available.includes(key)) return;
    totals[key] = loads[index].total;
    if (loads[index].unavailable) unavailable.push(key);
    items.push(...loads[index].items);
  });
  return { available, items, totals, unavailable };
}
