import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  AttendanceInput,
  CallInput,
  ConversionInput,
  DispositionInput,
  MAX_BATCH_ITEMS,
  PaymentInput,
  QualityScoreInput,
  TargetInput,
  IngestTeamInput,
  TelecallerInput,
  normalizeKeys,
  problem,
} from "@aura/shared";
import { ApiKeyGuard, RequireScope } from "../../common/api-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { EntitlementGuard, RequireEntitlement, requestIdOf } from "../../common/entitlement.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { IngestService } from "./ingest.service";

/**
 * The ingestion API: `/v1/ingest/*`
 * (`Build docs/no-crm-api-dashboard-build-plan.md` §6, M2).
 *
 * ── WHY THIS IS A SEPARATE CONTROLLER FROM /v1/public ───────────────────────
 *
 * `public-api.controller.ts`'s header makes the argument for a small,
 * reviewable API-key surface rather than scopes sprinkled across 200 console
 * routes, and this file is a second one for the same reason plus one more: the
 * API-only tier has CONTRACTED not to have a CRM. A controller that can write
 * a call fact and a lead is one copy-pasted decorator away from writing a lead
 * for a tenant whose plan excludes them, and the reviewable question should be
 * "what is in this file" rather than "what is missing from the other one".
 *
 * So the two surfaces are two files, two scope sets (`api-scopes.ts` keeps them
 * disjoint, and a test asserts it) and - because `ApiKeyGuard` refuses a
 * handler with no `@RequireScope` - forgetting an annotation here fails closed.
 *
 * ── EVERY WRITE IS AN UPSERT, AND NONE OF THEM COMPUTES ANYTHING ────────────
 *
 * A write stores a raw event and returns. The drain normalises. §11's "500ms
 * acknowledge, process asynchronously", and `ingest.service.ts` has the full
 * reasoning.
 *
 * ── RATE LIMITS ─────────────────────────────────────────────────────────────
 *
 * Two layers, deliberately. `@Throttle` is the coarse per-process ceiling that
 * bounds a runaway loop regardless of plan. The PLAN's own
 * `api_rate_per_min` is reported in the response headers by
 * `IngestRateInterceptor` and enforced there - it has to be per-org and
 * plan-aware, which the global throttler is not.
 */
@Controller("ingest")
@UseGuards(ApiKeyGuard, TenantGuard, EntitlementGuard)
@Throttle({ default: { limit: 600, ttl: 60_000 } })
export class IngestController {
  constructor(
    private readonly db: DbService,
    private readonly ingest: IngestService,
    private readonly entitlements: EntitlementsService,
  ) {}

  // ── People and structure ──────────────────────────────────────────────────

  /**
   * Create or update one telecaller (§6.2's `PUT /v1/telecallers/{id}`).
   *
   * Written inline rather than through the drain, and it is the ONE exception.
   * Every fact the drain normalises needs a telecaller to attach to, so a
   * caller who creates a person and immediately posts their calls would
   * otherwise race their own setup and have the whole first batch land in
   * `unmapped_refs`. A roster write is low volume by nature - a floor of 200
   * people changes a few times a week - so there is nothing to gain by
   * deferring it and a real confusion to avoid.
   *
   * The `active_telecallers` quota is checked HERE and blocks ADDING only, per
   * §4: nobody already on the roster is removed or deactivated by a limit.
   */
  @Put("telecallers/:externalId")
  @RequireScope("telecallers:write")
  async upsertTelecaller(
    @OrgId() orgId: string,
    @Param("externalId") externalId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = TelecallerInput.safeParse(normalizeKeys((body ?? {}) as Record<string, unknown>));
    if (!parsed.success) {
      throw new BadRequestException(
        problem("validation_failed", "one or more fields are invalid", requestIdOf(req), {
          field_errors: parsed.error.issues.map((i) => ({
            field: i.path.join(".") || "(root)",
            message: i.message,
          })),
        }),
      );
    }
    const input = parsed.data;
    const env = envOf(req);

    return this.db.withOrg(orgId, async (client) => {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM telecallers WHERE org_id = $1 AND external_id = $2`,
        [orgId, externalId],
      );

      if (existing.rowCount === 0 && input.status === "active") {
        const quota = await this.entitlements.quota(orgId, "active_telecallers");
        if (!quota.allowed) {
          throw new BadRequestException(
            problem(
              "quota_exceeded",
              `This plan covers ${quota.quota?.limit} active telecallers and ${quota.quota?.used} ` +
                "are already active. Archive someone, or move to a plan that fits the floor. " +
                "Nobody already on the roster has been changed.",
              requestIdOf(req),
            ),
          );
        }
      }

      // The team is resolved by the customer's own id, and a team we have not
      // been told about yet becomes an unmapped reference rather than an
      // error - §6.3 accepts out-of-order data, and a roster import that
      // mentions teams before creating them is the normal order of events.
      let teamId: string | null = null;
      if (input.team_external_id) {
        const { rows } = await client.query<{ id: string }>(
          `SELECT id FROM teams WHERE org_id = $1 AND external_id = $2`,
          [orgId, input.team_external_id],
        );
        teamId = rows[0]?.id ?? null;
        if (!teamId) await noteUnmapped(client, orgId, "team", input.team_external_id, null);
      }

      const { rows } = await client.query(
        `INSERT INTO telecallers (org_id, external_id, display_name, status, team_id)
              VALUES ($1, $2, $3, $4, $5)
         -- The index predicate is NOT optional here. telecallers_org_external_id
         -- (0067) is PARTIAL - WHERE external_id IS NOT NULL, because the
         -- column is optional for a handset-only tenant - and Postgres will
         -- not infer a partial index unless the conflict target repeats its
         -- predicate. Omitting it does not fall back to anything: it raises
         -- "there is no unique or exclusion constraint matching the ON CONFLICT
         -- specification", which is a 500 on every roster write.
         ON CONFLICT (org_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET
           display_name = EXCLUDED.display_name,
           status       = EXCLUDED.status,
           -- COALESCE, so a payload that omits the team does not UNSET it.
           -- An integration that only knows names must not be able to
           -- dissolve the org structure by posting a roster refresh.
           team_id      = COALESCE(EXCLUDED.team_id, telecallers.team_id),
           updated_at   = now()
         RETURNING id, external_id, display_name, status, team_id`,
        [orgId, externalId, input.name, input.status, teamId],
      );

      // A person who was unmapped is now mapped. Resolving the queue entry
      // here rather than making somebody click it is the point: the one-click
      // action in §7 is for the case where WE have to guess, not for the case
      // where the customer has just told us.
      await client.query(
        `UPDATE unmapped_refs
            SET resolved_at = now(), resolution = 'created', updated_at = now()
          WHERE org_id = $1 AND kind = 'telecaller' AND external_ref = $2 AND resolved_at IS NULL`,
        [orgId, externalId],
      );

      return { telecaller: rows[0], env };
    });
  }

  @Put("teams/:externalId")
  @RequireScope("teams:write")
  async upsertTeam(
    @OrgId() orgId: string,
    @Param("externalId") externalId: string,
    @Body() body: unknown,
  ) {
    const parsed = IngestTeamInput.safeParse(normalizeKeys((body ?? {}) as Record<string, unknown>));
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      let parentId: string | null = null;
      if (input.parent_external_id) {
        const { rows } = await client.query<{ id: string }>(
          `SELECT id FROM teams WHERE org_id = $1 AND external_id = $2`,
          [orgId, input.parent_external_id],
        );
        parentId = rows[0]?.id ?? null;
      }

      // `teams_org_name` is unique on lower(name) from 0177, so a tenant that
      // already has a hand-made "Delhi" team converges onto it rather than
      // failing - which is what makes this safe for a tenant holding both the
      // org chart and this tier.
      const { rows } = await client.query(
        `INSERT INTO teams (org_id, external_id, name, parent_team_id)
              VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, lower(name)) DO UPDATE SET
           external_id    = COALESCE(teams.external_id, EXCLUDED.external_id),
           parent_team_id = COALESCE(EXCLUDED.parent_team_id, teams.parent_team_id),
           updated_at     = now()
         RETURNING id, external_id, name, parent_team_id`,
        [orgId, externalId, input.name, parentId],
      );

      await client.query(
        `UPDATE unmapped_refs
            SET resolved_at = now(), resolution = 'created', updated_at = now()
          WHERE org_id = $1 AND kind = 'team' AND external_ref = $2 AND resolved_at IS NULL`,
        [orgId, externalId],
      );
      return { team: rows[0] };
    });
  }

  // ── Facts ─────────────────────────────────────────────────────────────────

  @Post("calls")
  @RequireScope("calls:write")
  async calls(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    return this.ingest.accept(
      ctxOf(req, orgId),
      "call",
      CallInput,
      itemsOf(body, "calls", req),
      (item) => (item.external_id as string) ?? null,
    );
  }

  /**
   * An outcome attached after the call (§6.2).
   *
   * Keyed on `call_external_id`, so the raw event's own `external_id` is the
   * CALL's - which is what makes a replayed disposition converge on the same
   * call rather than creating a second event nobody can match up.
   */
  @Post("dispositions")
  @RequireScope("calls:write")
  async dispositions(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    return this.ingest.accept(
      ctxOf(req, orgId),
      "disposition",
      DispositionInput,
      itemsOf(body, "dispositions", req),
      (item) => (item.call_external_id as string) ?? null,
    );
  }

  @Post("conversions")
  @RequireScope("conversions:write")
  async conversions(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    return this.ingest.accept(
      ctxOf(req, orgId),
      "conversion",
      ConversionInput,
      itemsOf(body, "conversions", req),
      (item) => (item.external_id as string) ?? null,
    );
  }

  /** Growth and above (§4's `revenue_summary`). */
  @Post("payments")
  @RequireScope("payments:write")
  @RequireEntitlement("revenue_summary", "basic")
  async payments(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    return this.ingest.accept(
      ctxOf(req, orgId),
      "payment",
      PaymentInput,
      itemsOf(body, "payments", req),
      (item) => (item.external_id as string) ?? null,
    );
  }

  @Post("attendance")
  @RequireScope("attendance:write")
  async attendance(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    return this.ingest.accept(
      ctxOf(req, orgId),
      "attendance",
      AttendanceInput,
      itemsOf(body, "attendance", req),
      // A day and a person identify the mark, so that pair is the convergence
      // key and `POST /v1/attendance` needs no external_id of its own.
      (item) => `${item.telecaller_external_id}:${item.date}`,
    );
  }

  /** Growth and above (§4's `manual_quality_scoring`). Human reviews only. */
  @Post("quality-scores")
  @RequireScope("quality:write")
  @RequireEntitlement("manual_quality_scoring")
  async qualityScores(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    return this.ingest.accept(
      ctxOf(req, orgId),
      "quality_score",
      QualityScoreInput,
      itemsOf(body, "quality_scores", req),
      (item) => (item.external_id as string) ?? null,
    );
  }

  /**
   * Per-person or per-team targets (§6.2's `POST /v1/targets`).
   *
   * Goes through the drain like any other resource, because the subject is
   * named by the customer's own id and may not exist yet - exactly the
   * unmapped case the queue handles. Weight is deliberately not settable here;
   * see `TargetInput`'s header.
   */
  @Post("targets")
  @RequireScope("targets:write")
  async targets(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    return this.ingest.accept(
      ctxOf(req, orgId),
      "target",
      TargetInput,
      itemsOf(body, "targets", req),
      (item) => `${item.kpi_key}:${item.scope}:${item.scope_external_id ?? "org"}:${item.effective_from}`,
    );
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /**
   * What became of one event (§6.2's `GET /v1/events/{id}`).
   *
   * The whole return on an append-only raw store: an integrator who got
   * `accepted` can find out whether it became a fact, which fact, and - if it
   * did not - exactly why, in the same error shape the batch response uses.
   */
  @Get("events/:id")
  @RequireScope("events:read")
  async event(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [event],
      } = await client.query(
        `SELECT e.id, e.resource, e.external_id, e.status, e.env, e.source,
                e.received_at, e.payload - '__idx' AS payload
           FROM ingest_events e
          WHERE e.org_id = $1 AND e.id = $2`,
        [orgId, id],
      );
      if (!event) throw new NotFoundException("no such event");
      const { rows: attempts } = await client.query(
        `SELECT attempt, status, error, fact_table, fact_id, processed_at
           FROM ingest_event_results
          WHERE org_id = $1 AND ingest_event_id = $2
          ORDER BY attempt`,
        [orgId, id],
      );
      return { event, attempts };
    });
  }

  /** §6.2's `GET /v1/usage`: where this workspace stands against its plan. */
  @Get("usage")
  @RequireScope("usage:read")
  async usage(@OrgId() orgId: string) {
    const { plan, meters } = await this.entitlements.usageReport(orgId);
    return {
      plan: plan.planKey,
      plan_name: plan.planName,
      status: plan.status,
      trial_plan: plan.trialPlanKey,
      trial_ends_at: plan.trialEndsAt,
      // `remaining` here is room to the LIMIT, which is what a caller that
      // does `limit - used` expects. `QuotaReading.remaining` is a different
      // number - room to the 110% grace ceiling, which is where `state` flips
      // to `blocked` - and returning that one under this name meant a plan on
      // 500,000 events reporting 545,970 remaining against a 500,000 limit.
      //
      // Both are worth knowing, so both are sent and each says which it is.
      // Safe to name correctly rather than preserve: this endpoint ships with
      // the API-only tier and no integration has read it yet.
      meters: meters.map((m) => ({
        key: m.key,
        used: m.reading.used,
        limit: m.reading.limit,
        remaining:
          m.reading.limit === null ? null : Math.max(0, m.reading.limit - m.reading.used),
        /** Further room above the limit before writes are refused outright. */
        grace_remaining: m.reading.remaining,
        state: m.reading.state,
        per: m.per,
      })),
      batch_max_items: MAX_BATCH_ITEMS,
    };
  }

  /**
   * Wipe the sandbox (§14's "reset test data").
   *
   * Only ever touches `env = 'test'`, in one transaction, and there is no
   * parameter that could widen it - the literal is in the SQL. A route that
   * could be talked into deleting live facts is not worth having, however
   * convenient.
   */
  @Post("test-data/reset")
  @RequireScope("calls:write")
  async resetTestData(@OrgId() orgId: string, @Req() req: PrincipalRequest) {
    if (envOf(req) !== "test") {
      throw new BadRequestException(
        problem(
          "live_key_refused",
          "Call this with a test key. A live key cannot reset test data, and nothing can reset live data.",
          requestIdOf(req),
        ),
      );
    }
    return this.db.withOrg(orgId, async (client) => {
      const counts: Record<string, number> = {};
      for (const table of [
        "insights_calls",
        "insights_conversions",
        "insights_payments",
        "insights_attendance",
        "insights_quality_reviews",
        "ingest_events",
      ]) {
        // `ingest_events` has no DELETE grant for `aura_app` (0193), so it is
        // listed and will fail if someone grants one later - the raw log is
        // the replay source and must survive a sandbox reset. Caught and
        // reported rather than aborting the rest.
        try {
          const { rowCount } = await client.query(
            `DELETE FROM ${table} WHERE org_id = $1 AND env = 'test'`,
            [orgId],
          );
          counts[table] = rowCount ?? 0;
        } catch {
          counts[table] = -1;
        }
      }
      return { deleted: counts };
    });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function envOf(req: PrincipalRequest): "test" | "live" {
  // Set by ApiKeyGuard from the key row. There is no header and no body field
  // that can choose an environment, for the same reason there is none that can
  // choose a tenant: it is a property of the credential.
  return req.apiKey?.env ?? "live";
}

function ctxOf(req: PrincipalRequest, orgId: string) {
  const header = req.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  return {
    orgId,
    apiKeyId: req.apiKey?.id ?? null,
    env: envOf(req),
    source: "api" as const,
    requestId: requestIdOf(req),
    idempotencyKey: key?.trim().slice(0, 200) || null,
  };
}

/**
 * Pull the item list out of a request body.
 *
 * Accepts `{ calls: [...] }` and a bare array, because both turn up in the
 * wild. A body that is neither is the one case that IS a 400: there are no
 * per-item results to report when there are no items.
 */
function itemsOf(body: unknown, field: string, req: PrincipalRequest): unknown[] {
  const list = Array.isArray(body)
    ? body
    : typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)[field]
      : undefined;
  if (!Array.isArray(list)) {
    throw new BadRequestException(
      problem(
        "invalid_batch",
        `expected { "${field}": [ ... ] } or a bare array of items`,
        requestIdOf(req),
      ),
    );
  }
  if (list.length === 0) {
    throw new BadRequestException(
      problem("empty_batch", "a batch needs at least one item", requestIdOf(req)),
    );
  }
  if (list.length > MAX_BATCH_ITEMS) {
    throw new BadRequestException(
      problem(
        "batch_too_large",
        `at most ${MAX_BATCH_ITEMS} items per request; this one had ${list.length}`,
        requestIdOf(req),
      ),
    );
  }
  return list;
}

/**
 * Record an unknown reference without failing the write (§7).
 *
 * `occurrences` counts repeats rather than inserting a row per event: a dialer
 * pushing 4,000 calls for a telecaller nobody created would otherwise produce
 * 4,000 identical queue entries, and the queue would be unusable exactly when
 * it mattered.
 */
export async function noteUnmapped(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  orgId: string,
  kind: "telecaller" | "team",
  ref: string,
  eventId: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO unmapped_refs (org_id, kind, external_ref, last_event_id)
          VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, kind, external_ref) DO UPDATE SET
       occurrences   = unmapped_refs.occurrences + 1,
       last_seen_at  = now(),
       last_event_id = COALESCE(EXCLUDED.last_event_id, unmapped_refs.last_event_id),
       updated_at    = now()`,
    [orgId, kind, ref, eventId],
  );
}
