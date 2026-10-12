import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { ZodTypeAny, z } from "zod";
import {
  type IngestBatchResponse,
  type IngestItemResult,
  fieldErrors,
  normalizeKeys,
} from "@aura/shared";
import { DbService } from "../../db/db.service";
import { EntitlementsService } from "../entitlements/entitlements.service";

/**
 * Accepting a batch: validate each item, write the raw events, answer per item.
 *
 * `Build docs/no-crm-api-dashboard-build-plan.md` §6.3 and §11, M2.
 *
 * ── ACCEPT FAST, NORMALISE LATER ────────────────────────────────────────────
 *
 * §11 wants the ingestion endpoint to acknowledge within 500ms and process
 * asynchronously. So the request path does exactly three things: validate,
 * INSERT into `ingest_events`, and reply. It does not resolve a telecaller,
 * does not write a fact and does not touch a KPI snapshot - all of that is the
 * drain's job (`apps/worker/src/pipeline/ingest-drain.ts`).
 *
 * The cost of that split is visible to the caller and is stated in the docs:
 * `POST /v1/calls` returns `accepted`, not "counted". `GET /v1/events/{id}`
 * says what became of it. The alternative - normalising inline - would put a
 * telecaller lookup and a fact upsert per item inside the request, which for a
 * 500-item batch against a database ~125ms away (DB_LATENCY_MIGRATION.md) is
 * not a 500ms response under any arrangement.
 *
 * ── ONE STATEMENT PER BATCH ─────────────────────────────────────────────────
 *
 * All the valid items of a batch are inserted by a single multi-row INSERT with
 * `unnest`, for the reason `telecaller-stats.ts` gives at length: node-postgres
 * does not pipeline, so 500 inserts would be 500 round trips. One statement,
 * `ON CONFLICT DO NOTHING` on the idempotency index, and the RETURNING tells us
 * which of them were new.
 *
 * ── A REJECTED ITEM NEVER FAILS ITS NEIGHBOURS ──────────────────────────────
 *
 * §6.3's MUST. Invalid items are collected with their index and their
 * field-level errors and reported alongside the accepted ones; the HTTP status
 * is 200 even when every item was rejected, because the REQUEST succeeded and
 * the per-item results are the answer. A 400 for one bad row in 500 would make
 * an integrator retry the whole batch, which is the behaviour this design
 * exists to avoid.
 *
 * The one exception is a batch that fails to parse as a batch at all - no
 * array, or more than `MAX_BATCH_ITEMS`. That is a 400, because there are no
 * per-item results to report.
 */

export type IngestResource =
  | "telecaller"
  | "team"
  | "call"
  | "disposition"
  | "conversion"
  | "payment"
  | "attendance"
  | "quality_score"
  | "target";

export interface AcceptContext {
  orgId: string;
  apiKeyId: string | null;
  env: "test" | "live";
  source: "api" | "import";
  requestId: string;
  idempotencyKey: string | null;
}

/** How an item's own `external_id` is found, per resource. */
type IdOf = (item: Record<string, unknown>) => string | null;

@Injectable()
export class IngestService {
  constructor(
    private readonly db: DbService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /**
   * Validate and store a batch.
   *
   * `idOf` is passed rather than assumed, because the resources disagree about
   * what identifies an item: a call has its own `external_id`, a disposition is
   * keyed by the call it attaches to, and an attendance mark is keyed by the
   * person and the day. The raw event's `external_id` has to be whichever of
   * those the drain will converge on, or a replay writes a second row.
   */
  async accept<S extends ZodTypeAny>(
    ctx: AcceptContext,
    resource: IngestResource,
    schema: S,
    items: unknown[],
    idOf: IdOf,
  ): Promise<IngestBatchResponse> {
    const valid: { index: number; externalId: string | null; payload: z.infer<S> }[] = [];
    const results: IngestItemResult[] = [];

    for (const [index, raw] of items.entries()) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        results.push({
          index,
          external_id: null,
          status: "rejected",
          error: { code: "invalid_item", message: "each item must be a JSON object" },
        });
        continue;
      }
      const normalized = normalizeKeys(raw as Record<string, unknown>);
      const parsed = schema.safeParse(normalized);
      if (!parsed.success) {
        results.push({
          index,
          // Reported even for a rejected item, when it is there: the id is how
          // the integrator finds the row in their own system. It is also
          // sometimes the thing that was wrong, which is why it comes from the
          // raw payload rather than from the parsed object.
          external_id: stringOrNull(normalized.external_id),
          status: "rejected",
          error: {
            code: "validation_failed",
            message: "one or more fields are invalid",
            field_errors: fieldErrors(parsed.error),
          },
        });
        continue;
      }
      valid.push({
        index,
        externalId: idOf(parsed.data as Record<string, unknown>),
        payload: parsed.data,
      });
    }

    if (valid.length === 0) {
      return this.respond(ctx, results, 0);
    }

    // ── The quota, consumed for what we are about to accept ──────────────────
    //
    // Consumed BEFORE the insert and for the valid count only. §4's behaviour
    // at 100% is a grace band to 110% and then a refusal, and `consume`
    // returns the reading so this decides once per batch rather than per item -
    // a batch half-accepted at a quota boundary is a batch an integrator cannot
    // reason about.
    const quota = await this.entitlements.consume(
      ctx.orgId,
      "ingest_events_monthly",
      valid.length,
    );
    if (!quota.allowed) {
      for (const item of valid) {
        results.push({
          index: item.index,
          external_id: item.externalId,
          status: "rejected",
          error: {
            code: "quota_exceeded",
            message:
              `This workspace has used ${quota.quota?.used} of its ${quota.quota?.limit} events ` +
              "for the month, including the grace allowance. Nothing was stored.",
          },
        });
      }
      return this.respond(ctx, results, 0);
    }

    const stored = await this.db.withOrg(ctx.orgId, async (client) =>
      this.insertEvents(client, ctx, resource, valid),
    );

    for (const item of valid) {
      const row = stored.get(item.index);
      results.push({
        index: item.index,
        external_id: item.externalId,
        // `duplicate` and not `accepted`: an integrator retrying a timeout
        // wants to know their retry was RECOGNISED, not that it worked twice.
        status: row ? "accepted" : "duplicate",
        event_id: row ?? null,
      });
    }

    return this.respond(ctx, results, stored.size);
  }

  /**
   * One multi-row INSERT, returning the ids of the rows that were new.
   *
   * `ON CONFLICT (org_id, idempotency_key) ... DO NOTHING` only fires when the
   * caller sent a key, because the index is partial. Without a key there is no
   * conflict to detect here and convergence happens later, at the fact table's
   * own `(org_id, origin, external_id)` upsert - which is the right place for
   * it: two pushes of the same call SHOULD both be recorded as having happened,
   * and should still produce one call.
   */
  private async insertEvents(
    client: PoolClient,
    ctx: AcceptContext,
    resource: IngestResource,
    valid: { index: number; externalId: string | null; payload: unknown }[],
  ): Promise<Map<number, string>> {
    // The idempotency key is per REQUEST, so for a batch it is suffixed with
    // the item index. Otherwise a 500-item batch would conflict with itself on
    // the second row and 499 items would silently become duplicates.
    const keys = valid.map((item) =>
      ctx.idempotencyKey ? `${ctx.idempotencyKey}:${item.index}` : null,
    );

    const { rows } = await client.query<{ id: string; idx: number }>(
      `INSERT INTO ingest_events
         (org_id, api_key_id, source, env, resource, external_id, idempotency_key, payload)
       SELECT $1, $2, $3, $4, $5, e.external_id, e.idempotency_key, e.payload
         FROM unnest($6::text[], $7::text[], $8::jsonb[])
                AS e(external_id, idempotency_key, payload)
       ON CONFLICT (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id, (payload->>'__idx')::int AS idx`,
      [
        ctx.orgId,
        ctx.apiKeyId,
        ctx.source,
        ctx.env,
        resource,
        valid.map((i) => i.externalId),
        keys,
        // `__idx` rides along in the payload so RETURNING can say WHICH items
        // were inserted - `ON CONFLICT DO NOTHING` returns fewer rows than it
        // was given and in no guaranteed order, so position cannot be inferred
        // from the result set.
        //
        // It cannot collide with a customer's own field: the payload stored
        // here is zod's OUTPUT, and `z.object` strips keys it does not declare,
        // so a caller who sends `__idx` has it dropped before this line. The
        // drain ignores it when re-reading the payload.
        valid.map((i) => JSON.stringify({ ...(i.payload as object), __idx: i.index })),
      ],
    );

    return new Map(rows.map((r) => [Number(r.idx), r.id]));
  }

  private respond(
    ctx: AcceptContext,
    results: IngestItemResult[],
    acceptedCount: number,
  ): IngestBatchResponse {
    const duplicate = results.filter((r) => r.status === "duplicate").length;
    return {
      accepted: acceptedCount,
      rejected: results.filter((r) => r.status === "rejected").length,
      duplicate,
      results: results.sort((a, b) => a.index - b.index),
      request_id: ctx.requestId,
    };
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 200) : null;
}
