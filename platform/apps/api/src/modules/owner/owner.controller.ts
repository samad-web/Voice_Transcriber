import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { parseLeadStages, parsePipelineStages } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { DbService } from "../../db/db.service";

const WindowQuery = z.object({
  /** Reporting window. 30 days matches the usage page's default period. */
  days: z.coerce.number().int().min(1).max(365).default(30),
});

const TelecallerBody = z.object({
  /** Empty string clears it, falling the console back to the device label. */
  name: z.string().max(120),
  // True when this handset now belongs to a genuinely different person -
  // mints a new telecaller identity instead of renaming the existing one.
  // False (the default) is for correcting a typo in the current holder's
  // own name.
  reassign: z.boolean().default(false),
});

/**
 * The customer owner's view of their own instance (§4.2).
 *
 * Everything here is a rollup of data the tenant already owns - calls, leads
 * and the handsets they came from - scoped by RLS to the org on the request.
 * The owner console reads only these endpoints plus /v1/leads, which is why it
 * can be given to a customer without exposing the operator surface.
 */
@Controller("owner")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
export class OwnerController {
  constructor(private readonly db: DbService) {}

  @Get("overview")
  async overview(
    @OrgId() orgId: string,
    @Query() query: unknown,
  ) {
    const parsed = WindowQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { days } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [org],
      } = await client.query("SELECT id, name, lead_stages FROM organizations LIMIT 1");
      if (!org) throw new NotFoundException("organization not found");

      const {
        rows: [leads],
      } = await client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'open')::int AS open,
                count(*) FILTER (WHERE status = 'won')::int  AS won,
                count(*) FILTER (WHERE status = 'lost')::int AS lost,
                count(*) FILTER (WHERE created_at > now() - make_interval(days => $1))::int AS created_in_window,
                COALESCE(sum(value_num) FILTER (WHERE status = 'open'), 0)::float AS pipeline_value,
                COALESCE(sum(value_num) FILTER (WHERE status = 'won'),  0)::float AS won_value
           FROM leads`,
        [days],
      );

      const {
        rows: [calls],
      } = await client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'COMPLETE')::int AS complete,
                COALESCE(sum(duration_s), 0)::int AS total_seconds
           FROM calls
          WHERE started_at > now() - make_interval(days => $1)`,
        [days],
      );

      // Board shape: every stage, including the empty ones, so the funnel does
      // not silently change width as leads move.
      const { rows: stageRows } = await client.query(
        `SELECT stage, count(*)::int AS count, COALESCE(sum(value_num), 0)::float AS value
           FROM leads GROUP BY stage`,
      );
      const stages = parseLeadStages(org.lead_stages);
      const funnel = stages.map((s) => {
        const row = stageRows.find((r) => r.stage === s.key);
        return { ...s, count: row?.count ?? 0, value: row?.value ?? 0 };
      });

      /**
       * Per-telecaller performance. Attribution follows the handset: a lead
       * belongs to whoever's phone first qualified it, so credit does not move
       * when a colleague later picks up the follow-up call.
       *
       * Every active device is listed even with no activity - "made no calls
       * this month" is exactly what an owner needs to see. A retired handset is
       * hidden only once it has nothing in the window either; its calls are in
       * the totals above, so dropping it unconditionally would leave the
       * leaderboard failing to add up to the KPI row.
       */
      const { rows: telecallers } = await client.query(
        `SELECT d.id, d.label, d.telecaller_name, d.status, d.last_seen_at,
                COALESCE(c.calls, 0)         AS calls,
                COALESCE(c.talk_seconds, 0)  AS talk_seconds,
                c.last_call_at,
                COALESCE(l.leads, 0)         AS leads,
                COALESCE(l.won, 0)           AS won,
                COALESCE(l.pipeline_value, 0)::float AS pipeline_value
           FROM devices d
           LEFT JOIN (
             SELECT device_id, telecaller_id,
                    count(*)::int AS calls,
                    COALESCE(sum(duration_s), 0)::int AS talk_seconds,
                    max(started_at) AS last_call_at
               FROM calls
              WHERE started_at > now() - make_interval(days => $1)
              GROUP BY device_id, telecaller_id
           -- Reassignment-safe (0068): a call only counts toward THIS device's
           -- row if it was made while attributed to the SAME telecaller this
           -- device currently points at - so a phone handed to a new hire
           -- stops inheriting the previous holder's history. IS NOT DISTINCT
           -- FROM (not =) so an org that has never assigned a telecaller at
           -- all still sees its devices' plain call counts, matching NULL to
           -- NULL rather than dropping them.
           ) c ON c.device_id = d.id AND c.telecaller_id IS NOT DISTINCT FROM d.telecaller_id
           LEFT JOIN (
             SELECT telecaller_device_id,
                    count(*)::int AS leads,
                    count(*) FILTER (WHERE status = 'won')::int AS won,
                    COALESCE(sum(value_num) FILTER (WHERE status = 'open'), 0) AS pipeline_value
               FROM leads
              WHERE created_at > now() - make_interval(days => $1)
              GROUP BY telecaller_device_id
           ) l ON l.telecaller_device_id = d.id
          WHERE d.status <> 'wiped' OR COALESCE(c.calls, 0) > 0 OR COALESCE(l.leads, 0) > 0
          ORDER BY COALESCE(l.leads, 0) DESC, COALESCE(c.calls, 0) DESC, d.label ASC`,
        [days],
      );

      // Calls and leads share one series so the dashboard can draw them on the
      // same axis; days with neither are absent and the client fills the gap.
      const { rows: byDay } = await client.query(
        `SELECT day, sum(calls)::int AS calls, sum(leads)::int AS leads FROM (
           SELECT date_trunc('day', started_at)::date AS day, count(*)::int AS calls, 0 AS leads
             FROM calls  WHERE started_at > now() - make_interval(days => $1) GROUP BY 1
           UNION ALL
           SELECT date_trunc('day', created_at)::date AS day, 0 AS calls, count(*)::int AS leads
             FROM leads  WHERE created_at > now() - make_interval(days => $1) GROUP BY 1
         ) series GROUP BY day ORDER BY day`,
        [days],
      );

      const { rows: recent } = await client.query(
        `SELECT l.id, l.title, l.stage, l.status, l.value_num, l.last_activity_at,
                COALESCE(d.telecaller_name, d.label) AS telecaller
           FROM leads l
           LEFT JOIN devices d ON d.id = l.telecaller_device_id
          ORDER BY l.last_activity_at DESC
          LIMIT 8`,
      );

      return {
        org: { id: org.id, name: org.name },
        window: { days },
        leads,
        calls,
        funnel,
        stages,
        telecallers,
        byDay,
        recent,
      };
    });
  }

  /**
   * A6, Milestone 4: the same dashboard, read from `deals`/`contacts`/
   * `deal_pipelines` instead of `leads`. Deliberately returns the exact same
   * shape `overview()` does (including the `leads`/`byDay[].leads` field
   * names) so `owner/page.tsx` can call either endpoint and render with the
   * same JSX - only the data source forks, not the page. See
   * `/owner/reports` for forecast/funnel/rep-performance detail; this is
   * only the KPI-row-plus-recent-activity shape that endpoint doesn't cover.
   */
  @Get("crm-overview")
  async crmOverview(
    @OrgId() orgId: string,
    @Query() query: unknown,
  ) {
    const parsed = WindowQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { days } = parsed.data;

    // RLS scopes every query below to `orgId`; no explicit filter is needed
    // (matches overview()'s own convention).
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [org],
      } = await client.query("SELECT id, name FROM organizations LIMIT 1");
      if (!org) throw new NotFoundException("organization not found");

      const {
        rows: [pipeline],
      } = await client.query<{ stages: unknown }>(
        "SELECT stages FROM deal_pipelines WHERE is_default = true LIMIT 1",
      );
      // No default pipeline yet (see crm-objects.ts's own no-op branch): the
      // KPI/telecaller/activity rows below still work off `deals` directly,
      // only the stage-shaped funnel has nothing to group by.
      const stages = pipeline ? parsePipelineStages(pipeline.stages) : [];

      const {
        rows: [deals],
      } = await client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'open')::int AS open,
                count(*) FILTER (WHERE status = 'won')::int  AS won,
                count(*) FILTER (WHERE status = 'lost')::int AS lost,
                count(*) FILTER (WHERE created_at > now() - make_interval(days => $1))::int AS created_in_window,
                COALESCE(sum(amount) FILTER (WHERE status = 'open'), 0)::float AS pipeline_value,
                COALESCE(sum(amount) FILTER (WHERE status = 'won'),  0)::float AS won_value
           FROM deals`,
        [days],
      );

      const {
        rows: [calls],
      } = await client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'COMPLETE')::int AS complete,
                COALESCE(sum(duration_s), 0)::int AS total_seconds
           FROM calls
          WHERE started_at > now() - make_interval(days => $1)`,
        [days],
      );

      const { rows: stageRows } = await client.query(
        `SELECT stage, count(*)::int AS count, COALESCE(sum(amount), 0)::float AS value
           FROM deals GROUP BY stage`,
      );
      const funnel = stages.map((s) => {
        const row = stageRows.find((r) => r.stage === s.key);
        return { ...s, count: row?.count ?? 0, value: row?.value ?? 0 };
      });

      // Same device-level call stats as overview()'s telecaller rollup, but
      // the deal aggregate joins on `telecaller_id` (a `telecallers` row -
      // what deals.telecaller_id already is, copied from the lead at
      // projection time) rather than `telecaller_device_id`, since that is
      // the identity a deal actually carries.
      const { rows: telecallers } = await client.query(
        `SELECT d.id, d.label, d.telecaller_name, d.status, d.last_seen_at,
                COALESCE(c.calls, 0)         AS calls,
                COALESCE(c.talk_seconds, 0)  AS talk_seconds,
                c.last_call_at,
                COALESCE(dl.deals, 0)        AS leads,
                COALESCE(dl.won, 0)          AS won,
                COALESCE(dl.pipeline_value, 0)::float AS pipeline_value
           FROM devices d
           LEFT JOIN (
             SELECT device_id, telecaller_id,
                    count(*)::int AS calls,
                    COALESCE(sum(duration_s), 0)::int AS talk_seconds,
                    max(started_at) AS last_call_at
               FROM calls
              WHERE started_at > now() - make_interval(days => $1)
              GROUP BY device_id, telecaller_id
           -- Reassignment-safe (0068) - see overview()'s identical join for why.
           ) c ON c.device_id = d.id AND c.telecaller_id IS NOT DISTINCT FROM d.telecaller_id
           LEFT JOIN (
             SELECT telecaller_id,
                    count(*)::int AS deals,
                    count(*) FILTER (WHERE status = 'won')::int AS won,
                    COALESCE(sum(amount) FILTER (WHERE status = 'open'), 0) AS pipeline_value
               FROM deals
              WHERE created_at > now() - make_interval(days => $1)
              GROUP BY telecaller_id
           ) dl ON dl.telecaller_id = d.telecaller_id
          WHERE d.status <> 'wiped' OR COALESCE(c.calls, 0) > 0 OR COALESCE(dl.deals, 0) > 0
          ORDER BY COALESCE(dl.deals, 0) DESC, COALESCE(c.calls, 0) DESC, d.label ASC`,
        [days],
      );

      const { rows: byDay } = await client.query(
        `SELECT day, sum(calls)::int AS calls, sum(leads)::int AS leads FROM (
           SELECT date_trunc('day', started_at)::date AS day, count(*)::int AS calls, 0 AS leads
             FROM calls  WHERE started_at > now() - make_interval(days => $1) GROUP BY 1
           UNION ALL
           SELECT date_trunc('day', created_at)::date AS day, 0 AS calls, count(*)::int AS leads
             FROM deals  WHERE created_at > now() - make_interval(days => $1) GROUP BY 1
         ) series GROUP BY day ORDER BY day`,
        [days],
      );

      const { rows: recent } = await client.query(
        `SELECT d.id, d.name AS title, d.stage, d.status, d.amount AS value_num, d.last_activity_at,
                t.display_name AS telecaller
           FROM deals d
           LEFT JOIN telecallers t ON t.id = d.telecaller_id
          ORDER BY d.last_activity_at DESC
          LIMIT 8`,
      );

      return {
        org: { id: org.id, name: org.name },
        window: { days },
        leads: deals,
        calls,
        funnel,
        stages,
        telecallers,
        byDay,
        recent,
      };
    });
  }

  /**
   * Name the person behind a handset.
   *
   * The device label is hardware ("Nokia G21 #2"); this is who is holding it,
   * and it is what the dashboard ranks. Kept here rather than on the devices
   * controller because it is the one device field an owner may edit.
   *
   * Also keeps the `telecallers` identity table (0017) in sync: a device gets
   * linked to a telecaller row the first time it is named, and that row's
   * display name is updated on every rename after. Clearing the name (empty
   * string) leaves the linkage untouched - the identity persists even if the
   * label is temporarily blanked.
   *
   * `reassign: true` is for the other case - a genuinely different person now
   * holds this handset. Without it, renaming would relabel the existing
   * telecaller's identity row in place, silently moving their whole call
   * history onto the new name (0068). `reassign` always mints a fresh
   * `telecallers` row and re-points the device, leaving the old identity and
   * its history untouched.
   */
  @Patch("telecallers/:deviceId")
  @RequireOwnerRole("owner", "manager")
  async setTelecaller(
    @OrgId() orgId: string,
    @Param("deviceId", ParseUUIDPipe) deviceId: string,
    @Body() body: unknown,
  ) {
    const parsed = TelecallerBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const name = parsed.data.name.trim() || null;
    const reassign = parsed.data.reassign;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [before],
      } = await client.query(
        `SELECT telecaller_id FROM devices WHERE id = $1`,
        [deviceId],
      );
      if (!before) throw new NotFoundException("device not found in this org");

      if (name) {
        if (before.telecaller_id && !reassign) {
          await client.query(`UPDATE telecallers SET display_name = $2 WHERE id = $1`, [
            before.telecaller_id,
            name,
          ]);
        } else {
          await client.query(
            `WITH inserted AS (
               INSERT INTO telecallers (org_id, display_name) VALUES ($1, $2) RETURNING id
             )
             UPDATE devices SET telecaller_id = (SELECT id FROM inserted) WHERE id = $3`,
            [orgId, name, deviceId],
          );
        }
      }

      const {
        rows: [device],
      } = await client.query(
        `UPDATE devices SET telecaller_name = $2 WHERE id = $1
         RETURNING id, label, telecaller_name, telecaller_id`,
        [deviceId, name],
      );
      return { device };
    });
  }
}
