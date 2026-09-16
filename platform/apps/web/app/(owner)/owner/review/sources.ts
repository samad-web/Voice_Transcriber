import "server-only";
import type { ApiResult } from "@/lib/api-result";
import type { getOwner } from "@/lib/owner-context";
import {
  reviewSourcesFor,
  type ReviewDuplicate,
  type ReviewItem,
  type ReviewOptOut,
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
  if (result.ok) return { ...pick(result.data), unavailable: false };
  const denied = result.kind === "forbidden" || result.kind === "notfound";
  return { items: [], total: 0, unavailable: !denied };
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
export const REVIEW_ADAPTERS: Record<ReviewSourceKey, ReviewSourceAdapter> = {
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
  const { ownerRole, enabledModules, enabledFeatures } = owner.membership;
  const available = reviewSourcesFor(ownerRole, enabledModules, enabledFeatures);
  const loads = await Promise.all(available.map((key) => REVIEW_ADAPTERS[key].load(owner, options)));

  const totals: Partial<Record<ReviewSourceKey, number>> = {};
  const unavailable: ReviewSourceKey[] = [];
  available.forEach((key, index) => {
    totals[key] = loads[index].total;
    if (loads[index].unavailable) unavailable.push(key);
  });
  return { available, items: loads.flatMap((l) => l.items), totals, unavailable };
}
