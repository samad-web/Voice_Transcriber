import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  DEFAULT_KPI_BANDS,
  FACT_KPIS,
  KPI_CATALOG,
  type KpiDataStatus,
  kpiDataStatus,
  kpiSpec,
  maySeeOthersRank,
  resolveInsightsSettings,
  resolveOwnerRole,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { actorUserId, auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { RequireOwnerRole, OwnerRoleGuard } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import {
  type DayWindow,
  type SubjectSummary,
  loadBands,
  liveKpiKeys,
  loadSnapshots,
  rank,
  summariseSubject,
  windowDays,
} from "./kpi-read";

const WindowQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  team: z.string().uuid().optional(),
});

const KpiConfigBody = z.object({
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  kpis: z
    .array(
      z.object({
        kpiKey: z.string().min(1).max(60),
        targetValue: z.number().min(0).nullable(),
        period: z.enum(["daily", "weekly", "monthly"]),
        weightPct: z.number().int().min(0).max(100),
      }),
    )
    .min(1)
    .max(12),
  /** The owner ticked "I know this KPI has no data and want it anyway" (§8.5). */
  acknowledgeMissingData: z.boolean().default(false),
});

const BandsBody = z.object({
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bands: z
    .array(
      z.object({
        bandKey: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
        label: z.string().trim().min(1).max(80),
        minPct: z.number().min(0).max(1000),
        maxPct: z.number().min(0).max(1000).nullable(),
        tone: z.enum(["neutral", "attention", "steady", "strong"]),
      }),
    )
    .min(2)
    .max(6),
});

/**
 * The dashboards (`Build docs/no-crm-api-dashboard-build-plan.md` §8.2-§8.5,
 * M4 and M5).
 *
 * ── RETENTION IS A FLOOR ON THE QUESTION, NEVER A DELETE ────────────────────
 *
 * Every window here is clamped by `Entitlements.retentionFloorFor`. A Starter
 * tenant asking for last year gets last quarter plus a `clampedTo` field
 * saying so, which is what the §9.2 upsell renders from - and the rows
 * themselves are untouched, so an upgrade brings them straight back.
 *
 * `retentionFloorFor` FAILS OPEN. §4: "fail closed for features, fail open for
 * already-ingested data visibility (a plan check outage must not hide a
 * customer's own dashboard)." That asymmetry is the one thing to preserve when
 * touching this file.
 *
 * ── THE FUNNEL DOES NOT GUESS WHICH DISPOSITION MEANS "INTERESTED" ──────────
 *
 * §8.2 asks for `dialed → connected → interested → converted`. The first,
 * second and fourth are facts. "Interested" is the CUSTOMER's vocabulary and we
 * were not told which of their forty dispositions means it - a tenant whose
 * list reads `warm`, `callback`, `hot` would have us pick one and be wrong
 * about the other two.
 *
 * So the funnel's third step is PEOPLE WORKED (distinct `lead_ref`), which is
 * knowable, and the disposition MIX is returned beside it so an owner sees
 * their own words with their own counts. Doing it the other way would put a
 * number on a dashboard that is a guess dressed as a measurement.
 */
@Controller("insights")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
export class InsightsController {
  constructor(
    private readonly db: DbService,
    private readonly entitlements: EntitlementsService,
  ) {}

  // ── Setup (M4) ────────────────────────────────────────────────────────────

  /**
   * The catalogue, with the "Data needed" status per KPI (§7, §8.5).
   *
   * Statuses are measured over the last 30 days of facts rather than all time,
   * because an integration that USED to send `connected` and stopped is the
   * case an owner most needs to see - and an all-time measurement would keep
   * calling it ready for a year.
   */
  @Get("kpi/catalog")
  @RequireOwnerRole("owner", "manager")
  async catalog(@OrgId() orgId: string) {
    const limit = await this.entitlements.quota(orgId, "selectable_kpis");
    const customKpis = await this.entitlements.hard(orgId, "custom_kpis");

    return this.db.withOrg(orgId, async (client) => {
      const coverage = await this.factCoverage(client, orgId);
      const live = await liveKpiKeys(client, orgId, today());

      // How many of the floor have no login behind them, for doc 41 F4's
      // second wizard step. Stated rather than averaged away (D3): selecting a
      // user-keyed KPI anyway is allowed; being surprised by it later is not.
      const {
        rows: [identity],
      } = await client.query<{ total: string; without_login: string }>(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE user_id IS NULL) AS without_login
           FROM telecallers WHERE org_id = $1 AND status = 'active'`,
        [orgId],
      );

      return {
        kpis: FACT_KPIS.map((spec) => ({
          key: spec.key,
          label: spec.label,
          blurb: spec.blurb,
          category: spec.category,
          unit: spec.unit,
          direction: spec.direction,
          identity: spec.identity,
          minBase: spec.minBase ?? null,
          dataNeeded: spec.dataNeeded,
          status: kpiDataStatus(spec, coverage) satisfies KpiDataStatus,
          selected: live.some((l) => l.kpiKey === spec.key),
        })),
        /** §9.2's "Growth lets you track up to 6 KPIs" trigger reads this. */
        maxSelectable: limit.quota?.limit ?? null,
        customKpisAllowed: customKpis.allowed,
        identity: {
          activeTelecallers: Number(identity?.total ?? 0),
          withoutLogin: Number(identity?.without_login ?? 0),
        },
        // The whole catalogue, including what is NOT offered here, so the
        // console can say what a Platform tenant would additionally get rather
        // than pretending the eleven offered are all there are.
        totalInCatalogue: KPI_CATALOG.length,
      };
    });
  }

  @Get("kpi/config")
  @RequireOwnerRole("owner", "manager")
  async config(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT c.kpi_key, c.scope_kind, c.scope_team_id, c.scope_telecaller_id,
                c.scope_owner_role, c.target_value, c.period, c.weight_pct,
                to_char(c.effective_from, 'YYYY-MM-DD') AS effective_from,
                to_char(c.effective_to, 'YYYY-MM-DD')   AS effective_to
           FROM org_kpi_config c
          WHERE c.org_id = $1
          ORDER BY c.effective_from DESC, c.kpi_key`,
        [orgId],
      );
      return {
        config: rows,
        bands: await loadBands(client, orgId, today()),
        defaultBands: DEFAULT_KPI_BANDS,
      };
    });
  }

  /**
   * The wizard's save (§8.5, doc 41 F4).
   *
   * ── FIVE GUARDRAILS, ALL RE-CHECKED HERE ────────────────────────────────────
   *
   * The console checks them too, for a decent error before the round trip. This
   * is where they are ENFORCED, because a server action and a direct PUT are
   * the same route and only one of them has a form in front of it.
   *
   *   1. between 4 and 6 KPIs, with the ceiling from the PLAN (§9.2's "Growth
   *      lets you track up to 6");
   *   2. weights total exactly 100 - cross-row, so it cannot be a CHECK;
   *   3. at least one `result` and one `activity`, so the set cannot be
   *      all-activity and gameable;
   *   4. every key is in the catalogue AND sourceable by this tenant;
   *   5. a KPI with no data needs an explicit acknowledgement.
   *
   * ── EFFECTIVE-DATING IS THE WHOLE WRITE ─────────────────────────────────────
   *
   * Saving closes the previous rows' `effective_to` at the new
   * `effective_from` and inserts new ones. It does NOT update the old rows'
   * targets. That is what makes "changing a target next month must not rewrite
   * last month" true by construction: a recompute of a past day re-resolves the
   * row that was in force then and gets the answer it got the first time.
   */
  @Put("kpi/config")
  @RequireOwnerRole("owner")
  async saveConfig(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    const parsed = KpiConfigBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { effectiveFrom, kpis, acknowledgeMissingData } = parsed.data;

    const limit = await this.entitlements.quota(orgId, "selectable_kpis");
    const max = limit.quota?.limit ?? 6;
    if (kpis.length < 4) {
      throw new BadRequestException("choose at least 4 KPIs - fewer than that is not a scorecard");
    }
    if (kpis.length > max) {
      throw new BadRequestException(
        `this plan covers ${max} KPIs at a time; move to a higher plan to track more`,
      );
    }

    const total = kpis.reduce((sum, k) => sum + k.weightPct, 0);
    if (total !== 100) {
      throw new BadRequestException(`weights must total exactly 100; these total ${total}`);
    }

    const specs = kpis.map((k) => {
      const spec = kpiSpec(k.kpiKey);
      if (!spec) throw new BadRequestException(`unknown KPI '${k.kpiKey}'`);
      if (spec.source === "native") {
        throw new BadRequestException(
          `'${spec.label}' needs data this workspace does not produce`,
        );
      }
      return spec;
    });
    if (new Set(kpis.map((k) => k.kpiKey)).size !== kpis.length) {
      throw new BadRequestException("the same KPI cannot be selected twice");
    }
    if (!specs.some((s) => s.category === "result")) {
      throw new BadRequestException("include at least one Result KPI - activity alone is gameable");
    }
    if (!specs.some((s) => s.category === "activity")) {
      throw new BadRequestException("include at least one Activity KPI");
    }

    const actor = auditActor(req);
    return this.db.withOrg(orgId, async (client) => {
      if (!acknowledgeMissingData) {
        const coverage = await this.factCoverage(client, orgId);
        const missing = specs.filter((s) => kpiDataStatus(s, coverage) === "missing");
        if (missing.length > 0) {
          throw new BadRequestException({
            code: "kpi_missing_data",
            message:
              `No data has arrived for ${missing.map((s) => s.label).join(", ")}. ` +
              "Send it, or confirm you want to track it anyway.",
            kpis: missing.map((s) => ({ key: s.key, label: s.label, dataNeeded: s.dataNeeded })),
          });
        }
      }

      // Close the previous org-scoped set. Only rows that are still open AND
      // start before the new date: a row that starts later is a future change
      // somebody scheduled, and closing it at a date before it begins would
      // violate the window-ordered CHECK and abort the save.
      await client.query(
        `UPDATE org_kpi_config
            SET effective_to = $2::date, updated_at = now()
          WHERE org_id = $1 AND scope_kind = 'org'
            AND effective_to IS NULL AND effective_from < $2::date`,
        [orgId, effectiveFrom],
      );
      // A set saved twice for the SAME effective date replaces itself rather
      // than colliding on the unique index. Deleting is safe here because a
      // row that has not taken effect has never been snapshotted against.
      await client.query(
        `DELETE FROM org_kpi_config
          WHERE org_id = $1 AND scope_kind = 'org' AND effective_from = $2::date`,
        [orgId, effectiveFrom],
      );

      await client.query(
        `INSERT INTO org_kpi_config
           (org_id, kpi_key, scope_kind, target_value, period, weight_pct, effective_from, created_by)
         SELECT $1, k.kpi_key, 'org', k.target_value, k.period, k.weight_pct, $2::date, $3
           FROM unnest($4::text[], $5::numeric[], $6::text[], $7::int[])
                  AS k(kpi_key, target_value, period, weight_pct)`,
        [
          orgId,
          effectiveFrom,
          actorUserId(actor),
          kpis.map((k) => k.kpiKey),
          kpis.map((k) => k.targetValue),
          kpis.map((k) => k.period),
          kpis.map((k) => k.weightPct),
        ],
      );

      // Seed the default bands the first time an org configures KPIs, rather
      // than in the migration - an org that never adopts KPIs should not carry
      // three band rows forever. 0195's closing comment says so.
      await client.query(
        `INSERT INTO org_kpi_bands (org_id, band_key, label, min_pct, max_pct, tone, sort, effective_from)
         SELECT $1, b.band_key, b.label, b.min_pct, b.max_pct, b.tone, b.sort, $2::date
           FROM unnest($3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::text[], $8::int[])
                  AS b(band_key, label, min_pct, max_pct, tone, sort)
          WHERE NOT EXISTS (SELECT 1 FROM org_kpi_bands WHERE org_id = $1)`,
        [
          orgId,
          effectiveFrom,
          DEFAULT_KPI_BANDS.map((b) => b.bandKey),
          DEFAULT_KPI_BANDS.map((b) => b.label),
          DEFAULT_KPI_BANDS.map((b) => b.minPct),
          DEFAULT_KPI_BANDS.map((b) => b.maxPct),
          DEFAULT_KPI_BANDS.map((b) => b.tone),
          DEFAULT_KPI_BANDS.map((b) => b.sort),
        ],
      );

        // `target_id` gets its OWN parameter rather than reusing $1: `org_id` is
        // uuid and `target_id` is text, and one placeholder across both types
        // fails Postgres's type inference with 42P08, which is a 500 on every
        // call to this endpoint.
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
              VALUES ($1, $2, $3, 'kpi.config_saved', 'organization', $4, $5::jsonb)`,
        [
          orgId,
          actor.type,
          actorUserId(actor) ?? orgId,
          orgId,
          JSON.stringify({ effectiveFrom, kpis, acknowledgeMissingData }),
        ],
      );

      return { saved: kpis.length, effectiveFrom };
    });
  }

  @Put("kpi/bands")
  @RequireOwnerRole("owner")
  async saveBands(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = BandsBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { effectiveFrom, bands } = parsed.data;

    // Half-open intervals have to tile the range with no gap and no overlap,
    // or an achievement lands in two bands or in none. Checked here because a
    // band set is only meaningful as a set - no per-row CHECK can see it.
    const sorted = [...bands].sort((a, b) => a.minPct - b.minPct);
    if (sorted[0].minPct !== 0) {
      throw new BadRequestException("the lowest band has to start at 0");
    }
    for (let i = 0; i < sorted.length - 1; i += 1) {
      if (sorted[i].maxPct === null) {
        throw new BadRequestException("only the highest band may be open-ended");
      }
      if (sorted[i].maxPct !== sorted[i + 1].minPct) {
        throw new BadRequestException(
          `bands must meet exactly: '${sorted[i].label}' ends at ${sorted[i].maxPct} but ` +
            `'${sorted[i + 1].label}' starts at ${sorted[i + 1].minPct}`,
        );
      }
    }
    if (sorted.at(-1)?.maxPct !== null) {
      throw new BadRequestException("the highest band has to be open-ended");
    }

    return this.db.withOrg(orgId, async (client) => {
      await client.query(
        `UPDATE org_kpi_bands SET effective_to = $2::date, updated_at = now()
          WHERE org_id = $1 AND effective_to IS NULL AND effective_from < $2::date`,
        [orgId, effectiveFrom],
      );
      await client.query(
        `DELETE FROM org_kpi_bands WHERE org_id = $1 AND effective_from = $2::date`,
        [orgId, effectiveFrom],
      );
      await client.query(
        `INSERT INTO org_kpi_bands (org_id, band_key, label, min_pct, max_pct, tone, sort, effective_from)
         SELECT $1, b.band_key, b.label, b.min_pct, b.max_pct, b.tone, b.sort, $2::date
           FROM unnest($3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::text[], $8::int[])
                  AS b(band_key, label, min_pct, max_pct, tone, sort)`,
        [
          orgId,
          effectiveFrom,
          sorted.map((b) => b.bandKey),
          sorted.map((b) => b.label),
          sorted.map((b) => b.minPct),
          sorted.map((b) => b.maxPct),
          sorted.map((b) => b.tone),
          sorted.map((_, i) => i + 1),
        ],
      );
      return { bands: sorted.length, effectiveFrom };
    });
  }

  // ── Dashboards (M5) ───────────────────────────────────────────────────────

  /** §8.2's overview: KPI cards, the org score, the funnel and freshness. */
  @Get("overview")
  @RequireOwnerRole("owner", "manager")
  async overview(@OrgId() orgId: string, @Query() query: unknown) {
    const q = WindowQuery.parse(query);
    const { window, clampedTo } = await this.clamp(orgId, { from: q.from, to: q.to });

    return this.db.withOrg(orgId, async (client) => {
      const settings = await this.settings(client);
      const [bands, live] = await Promise.all([
        loadBands(client, orgId, window.to),
        liveKpiKeys(client, orgId, window.to),
      ]);

      const orgRows = await loadSnapshots(client, {
        orgId,
        subjectKind: "org",
        window,
      });
      const org = summariseSubject(
        { kind: "org", id: null },
        orgRows.get("") ?? [],
        live,
        bands,
        settings.coverageFloor,
      );

      // Top and bottom performers (§8.2). Computed from the same snapshots the
      // leaderboard uses, so the two screens cannot disagree.
      const people = await this.summariseTelecallers(client, orgId, window, live, bands, settings.coverageFloor);
      const ranked = rank(people);
      const scored = ranked.filter((r) => r.rank !== null);

      // The two lists must not share a person.
      //
      // A plain slice(0,5)/slice(-5) overlaps whenever fewer than ten people
      // have a score, and on a five-person floor it returned the SAME five
      // twice - so the best performer on the floor appeared under "Behind",
      // badged "Excellent". A small team is the common case, not the edge one.
      //
      // Below ten, the floor is small enough to read whole, so "Ahead" takes
      // it and "Behind" is empty rather than a reversed duplicate. The page
      // drops an empty card, and the leaderboard already shows everyone in
      // order with the same numbers.
      const SPLIT_AT = 10;
      const half = Math.min(5, Math.floor(scored.length / 2));
      const top = scored.length < SPLIT_AT ? scored.slice(0, 5) : scored.slice(0, half);
      const bottom = scored.length < SPLIT_AT ? [] : scored.slice(-half).reverse();

      const [funnel, freshness, dispositions] = await Promise.all([
        this.funnel(client, orgId, window),
        this.freshness(client, orgId, settings.staleFeedHours),
        this.dispositionMix(client, orgId, window),
      ]);

      return {
        window,
        clampedTo,
        windowDays: windowDays(window),
        org,
        configured: live.length > 0,
        top,
        bottom,
        unranked: ranked.filter((r) => r.rank === null).length,
        funnel,
        dispositions,
        freshness,
        demoMode: settings.demoMode,
      };
    });
  }

  /** §8.3's leaderboard. */
  @Get("leaderboard")
  @RequireOwnerRole("owner", "manager", "telecaller", "sales", "marketing")
  async leaderboard(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Query() query: unknown) {
    const q = WindowQuery.parse(query);
    const { window, clampedTo } = await this.clamp(orgId, { from: q.from, to: q.to });
    const persona = resolveOwnerRole(req.principal?.ownerRole ?? null);

    return this.db.withOrg(orgId, async (client) => {
      const settings = await this.settings(client);
      const [bands, live] = await Promise.all([
        loadBands(client, orgId, window.to),
        liveKpiKeys(client, orgId, window.to),
      ]);
      const people = await this.summariseTelecallers(
        client,
        orgId,
        window,
        live,
        bands,
        settings.coverageFloor,
        q.team,
      );
      const ranked = rank(people);

      // §8.3's visibility setting, enforced at the API and not by hiding a
      // column. `maySeeOthersRank` lives in @aura/shared because three
      // surfaces ask it - this route, the drill-down and the page - and three
      // copies would be three chances to show a telecaller the whole floor
      // their owner switched off.
      if (!maySeeOthersRank(settings, persona)) {
        if (settings.leaderboardVisibility === "hidden") {
          throw new ForbiddenException("the leaderboard is switched off for this workspace");
        }
        const own = await this.ownTelecallerId(client, orgId, req);
        const mine = ranked.find((r) => r.subject.id === own);
        return {
          window,
          clampedTo,
          visibility: "own_rank" as const,
          total: ranked.length,
          rows: mine ? [mine] : [],
        };
      }

      return {
        window,
        clampedTo,
        visibility: "full" as const,
        total: ranked.length,
        rows: ranked,
      };
    });
  }

  /**
   * §8.3's drill-down, including the medians and 90th percentiles.
   *
   * Those two are computed from the facts rather than read from a snapshot,
   * because a percentile is not additive and so cannot be stored per day and
   * summed - `kpi-catalog.ts`'s header has the argument. The query is bounded
   * to one person and one window, which is what makes it affordable here and
   * unaffordable on the leaderboard.
   */
  @Get("telecallers/:id")
  @RequireOwnerRole("owner", "manager", "telecaller", "sales", "marketing")
  async telecaller(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
    @Query() query: unknown,
  ) {
    const q = WindowQuery.parse(query);
    const { window, clampedTo } = await this.clamp(orgId, { from: q.from, to: q.to });
    const persona = resolveOwnerRole(req.principal?.ownerRole ?? null);

    return this.db.withOrg(orgId, async (client) => {
      const settings = await this.settings(client);
      // A telecaller may always see their OWN numbers and never anybody
      // else's, whatever the leaderboard setting says - that setting is about
      // rankings, not about somebody else's scorecard.
      if (persona === "telecaller") {
        const own = await this.ownTelecallerId(client, orgId, req);
        if (own !== id) throw new ForbiddenException("you can only open your own performance");
      }

      const {
        rows: [person],
      } = await client.query<{ id: string; display_name: string; team_id: string | null; team: string | null }>(
        `SELECT t.id, t.display_name, t.team_id, tm.name AS team
           FROM telecallers t
           LEFT JOIN teams tm ON tm.id = t.team_id
          WHERE t.org_id = $1 AND t.id = $2`,
        [orgId, id],
      );
      if (!person) throw new NotFoundException("no such telecaller");

      const [bands, live] = await Promise.all([
        loadBands(client, orgId, window.to),
        liveKpiKeys(client, orgId, window.to),
      ]);
      const snapshots = await loadSnapshots(client, {
        orgId,
        subjectKind: "telecaller",
        subjectIds: [id],
        window,
      });
      const summary = summariseSubject(
        { kind: "telecaller", id },
        snapshots.get(id) ?? [],
        live,
        bands,
        settings.coverageFloor,
      );

      const [stats, byHour, byWeekday, trend, dispositions] = await Promise.all([
        this.durationStats(client, orgId, window, id),
        this.volumeByHour(client, orgId, window, id),
        this.volumeByWeekday(client, orgId, window, id),
        this.dailyTrend(client, orgId, window, id, live.map((l) => l.kpiKey)),
        this.dispositionMix(client, orgId, window, id),
      ]);

      return {
        window,
        clampedTo,
        telecaller: person,
        summary,
        stats,
        byHour,
        byWeekday,
        trend,
        dispositions,
      };
    });
  }

  /** §8.4's team roll-up. */
  @Get("teams")
  @RequireOwnerRole("owner", "manager")
  async teams(@OrgId() orgId: string, @Query() query: unknown) {
    const q = WindowQuery.parse(query);
    const { window, clampedTo } = await this.clamp(orgId, { from: q.from, to: q.to });
    const structure = await this.entitlements.variant(orgId, "team_structure");

    return this.db.withOrg(orgId, async (client) => {
      const settings = await this.settings(client);
      const [bands, live] = await Promise.all([
        loadBands(client, orgId, window.to),
        liveKpiKeys(client, orgId, window.to),
      ]);

      const { rows: teams } = await client.query<{
        id: string;
        name: string;
        parent_team_id: string | null;
        headcount: string;
        inactive: string;
      }>(
        `SELECT tm.id, tm.name, tm.parent_team_id,
                count(t.id) FILTER (WHERE t.status = 'active')   AS headcount,
                count(t.id) FILTER (WHERE t.status = 'archived') AS inactive
           FROM teams tm
           LEFT JOIN telecallers t ON t.team_id = tm.id AND t.org_id = tm.org_id
          WHERE tm.org_id = $1
          GROUP BY tm.id
          ORDER BY tm.name`,
        [orgId],
      );

      const snapshots = await loadSnapshots(client, {
        orgId,
        subjectKind: "team",
        subjectIds: teams.map((t) => t.id),
        window,
      });

      return {
        window,
        clampedTo,
        /** `flat` hides the whole page's hierarchy; `org_chart` links to it. */
        structure,
        teams: teams.map((team) => ({
          id: team.id,
          name: team.name,
          parentTeamId: team.parent_team_id,
          headcount: Number(team.headcount),
          inactive: Number(team.inactive),
          summary: summariseSubject(
            { kind: "team", id: team.id },
            snapshots.get(team.id) ?? [],
            live,
            bands,
            settings.coverageFloor,
          ),
        })),
      };
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Clamp a requested window to the retention the plan allows.
   *
   * `clampedTo` is returned rather than silently applied, because §9.2's
   * trigger - "Data older than 3 months is available on Growth" - needs to
   * know it happened. Silently narrowing would make the dashboard look wrong
   * rather than limited.
   */
  private async clamp(
    orgId: string,
    requested: DayWindow,
  ): Promise<{ window: DayWindow; clampedTo: string | null }> {
    const floor = await this.entitlements.retentionFloorFor(orgId);
    if (!floor) return { window: requested, clampedTo: null };
    const floorDay = floor.toISOString().slice(0, 10);
    if (requested.from >= floorDay) return { window: requested, clampedTo: null };
    return { window: { from: floorDay, to: requested.to }, clampedTo: floorDay };
  }

  private async settings(client: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  }) {
    const { rows } = await client.query(`SELECT * FROM insights_settings LIMIT 1`);
    return resolveInsightsSettings((rows[0] as never) ?? null);
  }

  /** The caller's own telecaller row, for the self-view checks. */
  private async ownTelecallerId(
    client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: { id: string }[] }> },
    orgId: string,
    req: PrincipalRequest,
  ): Promise<string | null> {
    const userId = actorUserId(auditActor(req));
    if (!userId) return null;
    const { rows } = await client.query(
      `SELECT id FROM telecallers WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId],
    );
    return rows[0]?.id ?? null;
  }

  private async summariseTelecallers(
    client: Parameters<typeof loadSnapshots>[0],
    orgId: string,
    window: DayWindow,
    live: { kpiKey: string; weightPct: number }[],
    bands: Awaited<ReturnType<typeof loadBands>>,
    coverageFloor: number,
    teamId?: string,
  ): Promise<
    (SubjectSummary & { name: string; teamId: string | null; unnamed: boolean })[]
  > {
    const { rows: people } = await client.query<{
      id: string;
      display_name: string;
      team_id: string | null;
      external_id: string | null;
    }>(
      `SELECT id, display_name, team_id, external_id
         FROM telecallers
        WHERE org_id = $1 AND status = 'active'
          AND ($2::uuid IS NULL OR team_id = $2::uuid)
        ORDER BY display_name`,
      [orgId, teamId ?? null],
    );
    const snapshots = await loadSnapshots(client, {
      orgId,
      subjectKind: "telecaller",
      subjectIds: people.map((p) => p.id),
      window,
    });
    return people.map((person) => ({
      ...summariseSubject(
        { kind: "telecaller", id: person.id },
        snapshots.get(person.id) ?? [],
        live,
        bands,
        coverageFloor,
      ),
      name: person.display_name,
      teamId: person.team_id,
      // A subject whose name IS its external id has never been given one.
      // insights-ops.controller.ts creates it that way on purpose - inventing
      // a friendlier name would be making up a person's name - but a
      // leaderboard then ranks "tc_991" as if that were somebody, between two
      // real people. The flag lets the console say "unnamed" instead of
      // pretending, and does not change the ranking: the figures behind it are
      // real calls and belong in the floor's numbers.
      unnamed: person.external_id !== null && person.display_name === person.external_id,
    }));
  }

  /**
   * How complete each fact table and column is, over the last 30 days.
   *
   * One statement. Four tables and six columns measured separately would be
   * ten round trips to a database ~125ms away, on a page an owner opens to
   * decide what to measure.
   */
  private async factCoverage(
    client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
    orgId: string,
  ) {
    const { rows } = await client.query(
      `SELECT
         (SELECT count(*) FROM insights_calls WHERE org_id = $1 AND env = 'live'
            AND day > current_date - 30)                                      AS calls,
         (SELECT count(connected) FROM insights_calls WHERE org_id = $1 AND env = 'live'
            AND day > current_date - 30)                                      AS calls_connected,
         (SELECT count(talk_time_sec) FROM insights_calls WHERE org_id = $1 AND env = 'live'
            AND day > current_date - 30)                                      AS calls_talk,
         (SELECT count(disposition) FROM insights_calls WHERE org_id = $1 AND env = 'live'
            AND day > current_date - 30)                                      AS calls_disposition,
         (SELECT count(lead_ref) FROM insights_calls WHERE org_id = $1 AND env = 'live'
            AND day > current_date - 30)                                      AS calls_lead_ref,
         (SELECT count(*) FROM insights_conversions WHERE org_id = $1 AND env = 'live'
            AND day > current_date - 30)                                      AS conversions,
         (SELECT count(value_minor) FROM insights_conversions WHERE org_id = $1 AND env = 'live'
            AND day > current_date - 30)                                      AS conversions_value,
         (SELECT count(*) FROM insights_payments WHERE org_id = $1 AND env = 'live'
            AND day > current_date - 30)                                      AS payments,
         (SELECT count(*) FROM insights_quality_reviews WHERE org_id = $1 AND env = 'live'
            AND day > current_date - 30)                                      AS quality,
         (SELECT count(*) FROM insights_attendance WHERE org_id = $1 AND env = 'live'
            AND day > current_date - 30)                                      AS attendance`,
      [orgId],
    );
    const r = (rows[0] ?? {}) as Record<string, string>;
    const n = (key: string) => Number(r[key] ?? 0);
    const calls = n("calls");
    return [
      { table: "insights_calls", rows: calls, present: calls },
      { table: "insights_calls", column: "connected", rows: calls, present: n("calls_connected") },
      { table: "insights_calls", column: "talk_time_sec", rows: calls, present: n("calls_talk") },
      { table: "insights_calls", column: "disposition", rows: calls, present: n("calls_disposition") },
      { table: "insights_calls", column: "lead_ref", rows: calls, present: n("calls_lead_ref") },
      { table: "insights_conversions", rows: n("conversions"), present: n("conversions") },
      {
        table: "insights_conversions",
        column: "value_minor",
        rows: n("conversions"),
        present: n("conversions_value"),
      },
      { table: "insights_payments", rows: n("payments"), present: n("payments") },
      { table: "insights_quality_reviews", rows: n("quality"), present: n("quality") },
      { table: "insights_attendance", rows: n("attendance"), present: n("attendance") },
    ];
  }

  /** §8.2's funnel. See the controller header for what step 3 is and is not. */
  private async funnel(
    client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
    orgId: string,
    window: DayWindow,
  ) {
    const { rows } = await client.query(
      `SELECT (SELECT count(*) FROM insights_calls c
                WHERE c.org_id = $1 AND c.env = 'live' AND c.day BETWEEN $2::date AND $3::date) AS dialed,
              (SELECT count(*) FROM insights_calls c
                WHERE c.org_id = $1 AND c.env = 'live' AND c.day BETWEEN $2::date AND $3::date
                  AND c.connected IS TRUE)                                                     AS connected,
              (SELECT count(DISTINCT c.lead_ref) FROM insights_calls c
                WHERE c.org_id = $1 AND c.env = 'live' AND c.day BETWEEN $2::date AND $3::date
                  AND c.lead_ref IS NOT NULL)                                                  AS people_worked,
              (SELECT count(*) FROM insights_conversions v
                WHERE v.org_id = $1 AND v.env = 'live' AND v.day BETWEEN $2::date AND $3::date) AS converted`,
      [orgId, window.from, window.to],
    );
    const r = (rows[0] ?? {}) as Record<string, string>;
    return {
      dialed: Number(r.dialed ?? 0),
      connected: Number(r.connected ?? 0),
      peopleWorked: Number(r.people_worked ?? 0),
      converted: Number(r.converted ?? 0),
    };
  }

  /** The customer's own dispositions, with their own counts. */
  private async dispositionMix(
    client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
    orgId: string,
    window: DayWindow,
    telecallerId?: string,
  ) {
    const { rows } = await client.query(
      `SELECT disposition, count(*) AS n
         FROM insights_calls
        WHERE org_id = $1 AND env = 'live' AND day BETWEEN $2::date AND $3::date
          AND disposition IS NOT NULL
          AND ($4::uuid IS NULL OR telecaller_id = $4::uuid)
        GROUP BY disposition
        ORDER BY n DESC
        LIMIT 12`,
      [orgId, window.from, window.to, telecallerId ?? null],
    );
    return rows.map((r) => ({ disposition: r.disposition as string, count: Number(r.n) }));
  }

  /**
   * §8.3's "median and 90th percentile, not just averages".
   *
   * Computed here and not stored, because a percentile is not additive over
   * days. Bounded to one person and one window.
   */
  private async durationStats(
    client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
    orgId: string,
    window: DayWindow,
    telecallerId: string,
  ) {
    const { rows } = await client.query(
      `SELECT count(*) AS calls,
              avg(duration_sec)::numeric(10,1)                                   AS avg_duration,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_sec)          AS median_duration,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_sec)          AS p90_duration,
              avg(talk_time_sec)::numeric(10,1)                                  AS avg_talk,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY talk_time_sec)         AS median_talk,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY talk_time_sec)         AS p90_talk
         FROM insights_calls
        WHERE org_id = $1 AND env = 'live' AND telecaller_id = $4::uuid
          AND day BETWEEN $2::date AND $3::date`,
      [orgId, window.from, window.to, telecallerId],
    );
    const r = (rows[0] ?? {}) as Record<string, string | null>;
    // `percentile_cont` over an empty set returns NULL, which is the answer we
    // want - a person with no calls has no median, not a median of 0.
    const num = (v: string | null) => (v === null ? null : Number(v));
    return {
      calls: Number(r.calls ?? 0),
      avgDurationSec: num(r.avg_duration),
      medianDurationSec: num(r.median_duration),
      p90DurationSec: num(r.p90_duration),
      avgTalkSec: num(r.avg_talk),
      medianTalkSec: num(r.median_talk),
      p90TalkSec: num(r.p90_talk),
    };
  }

  private async volumeByHour(
    client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
    orgId: string,
    window: DayWindow,
    telecallerId: string,
  ) {
    const { rows } = await client.query(
      // The hour in the ORG's timezone, not UTC - a 9am call on a Mumbai floor
      // must read as 9am. `reporting_timezone` is on the org row RLS has
      // already narrowed to one.
      `SELECT EXTRACT(hour FROM (c.started_at AT TIME ZONE o.reporting_timezone))::int AS hour,
              count(*) AS n
         FROM insights_calls c
         JOIN organizations o ON o.id = c.org_id
        WHERE c.org_id = $1 AND c.env = 'live' AND c.telecaller_id = $4::uuid
          AND c.day BETWEEN $2::date AND $3::date
        GROUP BY 1 ORDER BY 1`,
      [orgId, window.from, window.to, telecallerId],
    );
    return rows.map((r) => ({ hour: Number(r.hour), count: Number(r.n) }));
  }

  private async volumeByWeekday(
    client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
    orgId: string,
    window: DayWindow,
    telecallerId: string,
  ) {
    const { rows } = await client.query(
      `SELECT EXTRACT(isodow FROM day)::int AS weekday, count(*) AS n
         FROM insights_calls
        WHERE org_id = $1 AND env = 'live' AND telecaller_id = $4::uuid
          AND day BETWEEN $2::date AND $3::date
        GROUP BY 1 ORDER BY 1`,
      [orgId, window.from, window.to, telecallerId],
    );
    return rows.map((r) => ({ weekday: Number(r.weekday), count: Number(r.n) }));
  }

  /** The per-day series behind a sparkline, as numerator and denominator. */
  private async dailyTrend(
    client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
    orgId: string,
    window: DayWindow,
    telecallerId: string,
    kpiKeys: string[],
  ) {
    if (kpiKeys.length === 0) return [];
    const { rows } = await client.query(
      `SELECT kpi_key, to_char(day, 'YYYY-MM-DD') AS day, numerator, denominator
         FROM kpi_snapshots
        WHERE org_id = $1 AND subject_kind = 'telecaller' AND subject_id = $4::uuid
          AND day BETWEEN $2::date AND $3::date AND kpi_key = ANY($5::text[])
        ORDER BY day`,
      [orgId, window.from, window.to, telecallerId, kpiKeys],
    );
    return rows.map((r) => ({
      kpiKey: r.kpi_key as string,
      day: r.day as string,
      numerator: Number(r.numerator),
      denominator: r.denominator === null ? null : Number(r.denominator),
    }));
  }

  /**
   * §8.2's freshness stamp and §8.8's "last received per event type".
   *
   * The stamp is the honest answer to "is this dashboard current", and it is
   * the first thing on the overview for a reason: every number below it is
   * only as true as the last event that arrived.
   */
  private async freshness(
    client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
    orgId: string,
    staleAfterHours: number,
  ) {
    const { rows } = await client.query(
      `SELECT resource,
              max(received_at)                                           AS last_at,
              count(*) FILTER (WHERE received_at > now() - interval '24 hours') AS last_day
         FROM ingest_events
        WHERE org_id = $1 AND env = 'live'
        GROUP BY resource`,
      [orgId],
    );
    const {
      rows: [handset],
    } = await client.query(
      `SELECT max(created_at) AS last_at FROM insights_calls
        WHERE org_id = $1 AND origin = 'handset' AND env = 'live'`,
      [orgId],
    );

    const perResource = rows.map((r) => ({
      resource: r.resource as string,
      lastAt: r.last_at as Date | null,
      inLastDay: Number(r.last_day ?? 0),
    }));
    const newest = [
      ...perResource.map((p) => p.lastAt),
      (handset?.last_at as Date | null) ?? null,
    ].filter((d): d is Date => d instanceof Date);
    const lastAt = newest.length > 0 ? new Date(Math.max(...newest.map((d) => d.getTime()))) : null;
    const ageHours = lastAt ? (Date.now() - lastAt.getTime()) / 3_600_000 : null;

    return {
      lastEventAt: lastAt,
      ageHours,
      // `stale` is only true once something HAS arrived and then stopped. A
      // brand-new workspace that has never sent anything is `never`, not
      // stale - a warning about a feed that stopped would be wrong and would
      // teach the owner to ignore the banner.
      state: lastAt === null ? ("never" as const) : ageHours! > staleAfterHours ? ("stale" as const) : ("fresh" as const),
      staleAfterHours,
      perResource,
      handsetLastAt: (handset?.last_at as Date | null) ?? null,
    };
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
