import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { computeTotals } from "@aura/db";
import {
  ADVISOR_RULES,
  type AdvisorRuleCode,
  type AdvisorSeverity,
  AlertStatus,
  COLLECTION_PRIORS,
  DateOnly,
  type ForecastInflowItem,
  advisorRule,
  agingBucket,
  alertMovable,
  collectionProbabilities,
  forecast,
  rankLeaks,
  toMajor,
  toMinor,
  weightedRunRate,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { loadFinanceSettings, orgToday } from "./finance-settings";

/**
 * §12's Finance Advisor: the alert inbox, the rules, the forecast, the leak
 * report.
 *
 * ── THE PRINCIPLE, AND HOW IT IS KEPT ───────────────────────────────────────
 *
 * §12 is a MUST: "rules and statistics decide; language only explains. No LLM
 * call may create, suppress or re-rank an alert."
 *
 * There is no model call in this file, in the worker's detectors, or anywhere
 * else under `finance/`. The deciding code is `finance-stats.ts` and
 * `finance-advisor.ts` in `@aura/shared` - pure functions that take no client
 * and cannot reach a network - and every alert's `explain` payload is written
 * by the detector that fired it. `rankLeaks` sorts by rupees then severity,
 * both stored. That is what makes §12's "every advisory must be reproducible
 * from data" literally true rather than aspirational.
 *
 * ── AND WHAT THE ADVISOR IS NOT ALLOWED TO DO ───────────────────────────────
 *
 * §12.5: "notify-only by default. It must not message customers or move money
 * unless the owner enables a specific action." No route here sends anything to
 * anybody outside the workspace, and no route moves money. The escalation
 * ladder raises an in-app notification and the due ladder creates a task -
 * both for STAFF. The repo's standing rule, held in the one module where
 * breaking it would cost a customer relationship.
 */

const AlertListQuery = z.object({
  status: AlertStatus.optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  ruleCode: z.string().trim().max(60).optional(),
  assigneeId: z.string().uuid().optional(),
  /** §12.6's leak report ordering: by rupees at risk rather than by time. */
  order: z.enum(["newest", "at_risk"]).default("newest"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

interface AlertRow {
  id: string;
  rule_code: string;
  subject_type: string;
  subject_ref: string;
  severity: string;
  status: string;
  amount_at_risk: string | null;
  currency: string;
  assignee_id: string | null;
  assigned_role: string | null;
  due_at: Date | null;
  escalated_at: Date | null;
  escalated_to: string | null;
  resolved_reason: string | null;
  explain: Record<string, unknown>;
  message: string;
  first_seen_at: Date;
  last_seen_at: Date;
  snooze_until: Date | null;
  dismiss_count: number;
  assignee_name?: string | null;
}

function presentAlert(row: AlertRow) {
  // The catalogue supplies everything an alert's PRESENTATION needs - the
  // label, the recommended action, whether it is statistical. Stored per alert
  // it would be seventeen copies of the same sentence, out of date the first
  // time the wording improved.
  let spec: ReturnType<typeof advisorRule> | null = null;
  try {
    spec = advisorRule(row.rule_code as AdvisorRuleCode);
  } catch {
    // A code in the table that the catalogue no longer has - a rule removed in
    // a deploy while its alerts were still open. Rendered with what the row
    // itself holds rather than 500-ing the whole inbox.
    spec = null;
  }
  return {
    id: row.id,
    ruleCode: row.rule_code,
    ruleLabel: spec?.label ?? row.rule_code,
    recommendedAction: spec?.recommendedAction ?? null,
    statistical: spec?.statistical ?? false,
    subjectType: row.subject_type,
    subjectRef: row.subject_ref,
    severity: row.severity,
    status: row.status,
    amountAtRisk: row.amount_at_risk === null ? null : Number(row.amount_at_risk),
    currency: row.currency,
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_name ?? null,
    assignedRole: row.assigned_role,
    dueAt: row.due_at,
    escalatedAt: row.escalated_at,
    escalatedTo: row.escalated_to,
    resolvedReason: row.resolved_reason,
    /** §12.6's explain panel: the formula, the inputs and the records. */
    explain: row.explain,
    message: row.message,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    snoozeUntil: row.snooze_until,
    dismissCount: row.dismiss_count,
  };
}

const ALERT_COLUMNS = `a.id, a.rule_code, a.subject_type, a.subject_ref, a.severity, a.status,
  a.amount_at_risk::text AS amount_at_risk, a.currency, a.assignee_id, a.assigned_role,
  a.due_at, a.escalated_at, a.escalated_to, a.resolved_reason, a.explain, a.message,
  a.first_seen_at, a.last_seen_at, a.snooze_until, a.dismiss_count`;

const AUDIT_SQL = `INSERT INTO audit_log
   (org_id, actor_type, actor_id, action, target_type, target_id, meta)
 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`;

@Controller("finance/advisor")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class AdvisorController {
  constructor(private readonly db: DbService) {}

  // ── The inbox ────────────────────────────────────────────────────────────

  @Get("alerts")
  @RequireCrmPermission("finance", "view")
  async alerts(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = AlertListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const q = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (clause: string, value: unknown) => {
        params.push(value);
        where.push(clause.replace(/\$\?/g, `$${params.length}`));
      };
      if (q.status) add("a.status = $?", q.status);
      else where.push("a.status IN ('open', 'acknowledged')");
      if (q.severity) add("a.severity = $?", q.severity);
      if (q.ruleCode) add("a.rule_code = $?", q.ruleCode);
      if (q.assigneeId) add("a.assignee_id = $?", q.assigneeId);
      // A snoozed alert is hidden until its time, which is §12.5's control -
      // not deleted, and it reappears on its own.
      where.push("(a.snooze_until IS NULL OR a.snooze_until <= now())");

      params.push(q.limit, q.offset);
      const { rows } = await client.query<AlertRow & { total: string }>(
        `SELECT ${ALERT_COLUMNS}, u.name AS assignee_name, count(*) OVER() AS total
           FROM advisor_alerts a
           LEFT JOIN users u ON u.id = a.assignee_id
          WHERE ${where.join(" AND ")}
          ORDER BY ${
            q.order === "at_risk"
              ? "a.amount_at_risk DESC NULLS LAST, a.severity"
              : "a.last_seen_at DESC"
          }
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      const { rows: counts } = await client.query<{ severity: string; n: string }>(
        `SELECT severity, count(*)::text AS n
           FROM advisor_alerts
          WHERE status IN ('open', 'acknowledged')
          GROUP BY 1`,
      );

      return {
        alerts: rows.map(({ total: _t, ...row }) => presentAlert(row as AlertRow)),
        total: rows.length > 0 ? Number(rows[0].total) : 0,
        openBySeverity: Object.fromEntries(counts.map((c) => [c.severity, Number(c.n)])),
        limit: q.limit,
        offset: q.offset,
      };
    });
  }

  @Get("alerts/:id")
  @RequireCrmPermission("finance", "view")
  async alert(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<AlertRow>(
        `SELECT ${ALERT_COLUMNS}, u.name AS assignee_name
           FROM advisor_alerts a LEFT JOIN users u ON u.id = a.assignee_id
          WHERE a.id = $1`,
        [id],
      );
      if (!rows[0]) throw new NotFoundException("alert not found");

      const { rows: events } = await client.query<{
        kind: string;
        actor_id: string | null;
        target_role: string | null;
        note: string | null;
        at: Date;
        actor_name: string | null;
      }>(
        `SELECT e.kind, e.actor_id, e.target_role, e.note, e.at, u.name AS actor_name
           FROM alert_events e LEFT JOIN users u ON u.id = e.actor_id
          WHERE e.alert_id = $1 ORDER BY e.at`,
        [id],
      );

      return {
        ...presentAlert(rows[0]),
        /** §12.5: "record each step in alert_event" - the whole trail. */
        history: events.map((e) => ({
          kind: e.kind,
          actorId: e.actor_id,
          actorName: e.actor_name,
          targetRole: e.target_role,
          note: e.note,
          at: e.at,
        })),
      };
    });
  }

  /**
   * §12.5's lifecycle: `open → acknowledged → resolved | dismissed`.
   *
   * ── A DISMISSAL REQUIRES A REASON, AND THAT REASON IS THE FEEDBACK LOOP ────
   *
   * §12.5 says "dismissed (reason required)" and then asks for the dismissal
   * reasons to feed suggested threshold changes. Both halves are here: the
   * reason is mandatory, and the dismissal increments the RULE's
   * `dismiss_count`, which the nightly sweep turns into a suggestion an owner
   * approves. Nothing applies a threshold change automatically - §12.5's
   * "thresholds are never changed silently" is why `advisor_suggestions` is a
   * table rather than an UPDATE.
   */
  @Patch("alerts/:id")
  @RequireCrmPermission("finance", "edit")
  async updateAlert(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
    @Body() body: unknown,
  ) {
    const parsed = z
      .object({
        status: z.enum(["acknowledged", "resolved", "dismissed"]).optional(),
        reason: z.string().trim().max(500).optional(),
        snoozeHours: z.number().int().min(1).max(24 * 90).optional(),
      })
      .refine((b) => b.status || b.snoozeHours, "nothing to do")
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{ id: string; status: string; rule_code: string }>(
        `SELECT id, status, rule_code FROM advisor_alerts WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const alert = rows[0];
      if (!alert) throw new NotFoundException("alert not found");

      if (input.snoozeHours) {
        await client.query(
          `UPDATE advisor_alerts SET snooze_until = now() + ($1 || ' hours')::interval WHERE id = $2`,
          [input.snoozeHours, id],
        );
        await client.query(
          `INSERT INTO alert_events (org_id, alert_id, kind, actor_id, note)
           VALUES ($1, $2, 'snoozed', $3, $4)`,
          [orgId, id, actor.type === "user" ? actor.id : null, `${input.snoozeHours}h`],
        );
      }

      if (input.status) {
        if (!alertMovable(alert.status as AlertStatus, input.status)) {
          throw new ConflictException(`a ${alert.status} alert cannot become ${input.status}`);
        }
        if (input.status === "dismissed" && !input.reason) {
          throw new BadRequestException("say why you are dismissing this");
        }

        await client.query(
          `UPDATE advisor_alerts
              SET status = $1,
                  resolved_reason = COALESCE($2, resolved_reason),
                  dismiss_count = dismiss_count + CASE WHEN $1 = 'dismissed' THEN 1 ELSE 0 END
            WHERE id = $3`,
          [input.status, input.reason ?? null, id],
        );
        await client.query(
          `INSERT INTO alert_events (org_id, alert_id, kind, actor_id, note)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            orgId,
            id,
            input.status === "acknowledged" ? "ack" : input.status,
            actor.type === "user" ? actor.id : null,
            input.reason ?? null,
          ],
        );

        if (input.status === "dismissed") {
          // The rule's running total, which the nightly sweep reads to decide
          // whether to propose a looser threshold. Upserted because a rule
          // with no overrides has no row.
          await client.query(
            `INSERT INTO advisor_rules (org_id, code, dismiss_count)
             VALUES ($1, $2, 1)
             ON CONFLICT (org_id, code)
             DO UPDATE SET dismiss_count = advisor_rules.dismiss_count + 1`,
            [orgId, alert.rule_code],
          );
        }

        await client.query(AUDIT_SQL, [
          orgId,
          actor.type,
          actor.id,
          `finance.alert.${input.status}`,
          "advisor_alert",
          id,
          JSON.stringify({ ruleCode: alert.rule_code, reason: input.reason ?? null }),
        ]);
      }

      return { id, status: input.status ?? alert.status };
    });
  }

  // ── The rules ────────────────────────────────────────────────────────────

  /**
   * The catalogue, merged with this org's overrides.
   *
   * ── WHY THE CATALOGUE IS THE SOURCE AND THE TABLE IS THE EXCEPTION ─────────
   *
   * `advisor_rules` holds only what somebody CHANGED, so a rule's wording,
   * severity and routing can improve in a deploy without a migration, while a
   * tuned threshold survives one. A fully-seeded table would mean seventeen
   * rows per org that have to be migrated every time a rule's default moves -
   * and the migration would have to decide whether an org's stored value was a
   * deliberate choice or an old default.
   */
  @Get("rules")
  @RequireCrmPermission("finance", "view")
  async rules(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const settings = await loadFinanceSettings(client, orgId);
      const { rows } = await client.query<{
        code: string;
        params: Record<string, number>;
        severity: string | null;
        route_to_role: string | null;
        enabled: boolean;
        snooze_until: Date | null;
        dismiss_count: number;
      }>(
        `SELECT code, params, severity, route_to_role, enabled, snooze_until, dismiss_count
           FROM advisor_rules`,
      );
      const overrides = new Map(rows.map((r) => [r.code, r]));

      return {
        minStatisticalSample: settings.minStatisticalSample,
        rules: ADVISOR_RULES.map((spec) => {
          const override = overrides.get(spec.code);
          return {
            code: spec.code,
            label: spec.label,
            blurb: spec.blurb,
            schedule: spec.schedule,
            statistical: spec.statistical,
            recommendedAction: spec.recommendedAction,
            escalationPath: spec.escalationPath,
            // Merged, not replaced: a rule that grows a second param next
            // quarter must not read it as 0 for every org that tuned the first.
            params: { ...spec.params, ...(override?.params ?? {}) },
            defaultParams: spec.params,
            severity: (override?.severity ?? spec.severity) as AdvisorSeverity,
            routeTo: override?.route_to_role ?? spec.routeTo,
            enabled: override?.enabled ?? true,
            snoozeUntil: override?.snooze_until ?? null,
            dismissCount: override?.dismiss_count ?? 0,
            overridden: Boolean(override),
          };
        }),
      };
    });
  }

  @Patch("rules/:code")
  @RequireCrmPermission("finance", "create")
  async updateRule(
    @OrgId() orgId: string,
    @Param("code") code: string,
    @Req() req: PrincipalRequest,
    @Body() body: unknown,
  ) {
    const spec = ADVISOR_RULES.find((r) => r.code === code);
    if (!spec) throw new NotFoundException("no such rule");

    const parsed = z
      .object({
        enabled: z.boolean().optional(),
        severity: z.enum(["low", "medium", "high", "critical"]).optional(),
        routeTo: z.enum(["telecaller", "manager", "owner", "finance_handler"]).optional(),
        params: z.record(z.string(), z.number()).optional(),
        snoozeDays: z.number().int().min(0).max(365).optional(),
      })
      .refine((b) => Object.keys(b).length > 0, "nothing to update")
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;

    // A param the rule does not have is a typo, not a new knob. Accepting it
    // would store a key the detector never reads, and the rules screen would
    // show a tuned threshold that does nothing.
    for (const key of Object.keys(input.params ?? {})) {
      if (!(key in spec.params)) {
        throw new BadRequestException(`${code} has no parameter called ${key}`);
      }
    }

    const actor = auditActor(req);
    return this.db.withOrg(orgId, async (client) => {
      await client.query(
        `INSERT INTO advisor_rules (org_id, code, params, severity, route_to_role, enabled, snooze_until)
         VALUES ($1, $2, COALESCE($3::jsonb, '{}'::jsonb), $4, $5, COALESCE($6, true),
                 CASE WHEN $7::int IS NULL THEN NULL
                      WHEN $7::int = 0 THEN NULL
                      ELSE now() + ($7 || ' days')::interval END)
         ON CONFLICT (org_id, code) DO UPDATE SET
           -- Params MERGE into whatever is stored, so tuning one threshold
           -- does not clear another.
           params = advisor_rules.params || COALESCE($3::jsonb, '{}'::jsonb),
           severity = COALESCE($4, advisor_rules.severity),
           route_to_role = COALESCE($5, advisor_rules.route_to_role),
           enabled = COALESCE($6, advisor_rules.enabled),
           snooze_until = CASE WHEN $7::int IS NULL THEN advisor_rules.snooze_until
                               WHEN $7::int = 0 THEN NULL
                               ELSE now() + ($7 || ' days')::interval END`,
        [
          orgId,
          code,
          input.params ? JSON.stringify(input.params) : null,
          input.severity ?? null,
          input.routeTo ?? null,
          input.enabled ?? null,
          input.snoozeDays ?? null,
        ],
      );
      await client.query(AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "finance.advisor_rule.updated",
        "advisor_rule",
        null,
        JSON.stringify({ code, ...input }),
      ]);
      return { code, ...input };
    });
  }

  // ── §12.5's feedback loop ────────────────────────────────────────────────

  @Get("suggestions")
  @RequireCrmPermission("finance", "view")
  async suggestions(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{
        id: string;
        rule_code: string;
        param: string;
        from_value: string;
        to_value: string;
        reason: string;
        created_at: Date;
      }>(
        `SELECT id, rule_code, param, from_value::text, to_value::text, reason, created_at
           FROM advisor_suggestions WHERE status = 'pending' ORDER BY created_at DESC`,
      );
      return {
        suggestions: rows.map((r) => ({
          id: r.id,
          ruleCode: r.rule_code,
          ruleLabel: ADVISOR_RULES.find((s) => s.code === r.rule_code)?.label ?? r.rule_code,
          param: r.param,
          from: Number(r.from_value),
          to: Number(r.to_value),
          reason: r.reason,
          createdAt: r.created_at,
        })),
      };
    });
  }

  /**
   * §12.5: "The owner approves; thresholds are never changed silently."
   *
   * This route is the ONLY path from a suggestion to a stored threshold.
   * Nothing in the worker may apply one - which is why the suggestion is a row
   * with a `status` rather than a computed hint the sweep could act on.
   */
  @Patch("suggestions/:id")
  @RequireCrmPermission("finance", "create")
  async decideSuggestion(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
    @Body() body: unknown,
  ) {
    const parsed = z.object({ decision: z.enum(["approved", "declined"]) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{
        rule_code: string;
        param: string;
        to_value: string;
        status: string;
      }>(
        `SELECT rule_code, param, to_value::text, status
           FROM advisor_suggestions WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const suggestion = rows[0];
      if (!suggestion) throw new NotFoundException("suggestion not found");
      if (suggestion.status !== "pending") {
        throw new ConflictException("this suggestion has already been decided");
      }

      await client.query(
        `UPDATE advisor_suggestions SET status = $1, decided_by = $2, decided_at = now() WHERE id = $3`,
        [parsed.data.decision, actor.type === "user" ? actor.id : null, id],
      );

      if (parsed.data.decision === "approved") {
        await client.query(
          `INSERT INTO advisor_rules (org_id, code, params)
           VALUES ($1, $2, jsonb_build_object($3::text, $4::numeric))
           ON CONFLICT (org_id, code)
           DO UPDATE SET params = advisor_rules.params || jsonb_build_object($3::text, $4::numeric),
                         -- The dismissals that produced this suggestion are
                         -- spent. Leaving the count would re-suggest the same
                         -- change on the next sweep, forever.
                         dismiss_count = 0`,
          [orgId, suggestion.rule_code, suggestion.param, Number(suggestion.to_value)],
        );
      }

      await client.query(AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        `finance.advisor_suggestion.${parsed.data.decision}`,
        "advisor_suggestion",
        id,
        JSON.stringify({
          ruleCode: suggestion.rule_code,
          param: suggestion.param,
          to: Number(suggestion.to_value),
        }),
      ]);
      return { id, decision: parsed.data.decision };
    });
  }

  // ── §12.6 the leak report ────────────────────────────────────────────────

  @Get("leaks")
  @RequireCrmPermission("finance", "view")
  async leaks(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<AlertRow>(
        `SELECT ${ALERT_COLUMNS}, u.name AS assignee_name
           FROM advisor_alerts a LEFT JOIN users u ON u.id = a.assignee_id
          WHERE a.status IN ('open', 'acknowledged')`,
      );

      const alerts = rows.map((row) => ({
        ...presentAlert(row),
        amountAtRiskMinor: row.amount_at_risk === null ? null : toMinor(row.amount_at_risk),
        severity: row.severity as AdvisorSeverity,
      }));

      // §12.6: "leaks ranked by estimated ₹/month with rule, owner and
      // action." Money first, severity as the tie-break - see `rankLeaks`.
      const ranked = rankLeaks(alerts);
      const byRule = new Map<string, { atRisk: number; alerts: number }>();
      for (const alert of ranked) {
        const existing = byRule.get(alert.ruleCode) ?? { atRisk: 0, alerts: 0 };
        byRule.set(alert.ruleCode, {
          atRisk: existing.atRisk + (alert.amountAtRiskMinor ?? 0),
          alerts: existing.alerts + 1,
        });
      }

      return {
        totalAtRisk: toMajor(
          ranked.reduce((sum, a) => sum + (a.amountAtRiskMinor ?? 0), 0),
        ),
        byRule: [...byRule.entries()]
          .map(([code, v]) => ({
            code,
            label: ADVISOR_RULES.find((s) => s.code === code)?.label ?? code,
            action: ADVISOR_RULES.find((s) => s.code === code)?.recommendedAction ?? null,
            routeTo: ADVISOR_RULES.find((s) => s.code === code)?.routeTo ?? null,
            atRisk: toMajor(v.atRisk),
            alerts: v.alerts,
          }))
          .sort((a, b) => b.atRisk - a.atRisk),
        leaks: ranked.slice(0, 50),
      };
    });
  }

  // ── §12.2 the cash-flow forecast ─────────────────────────────────────────

  /**
   * 30 / 60 / 90 days, as low / base / high scenarios.
   *
   * ── IT IS COMPUTED ON READ, AND CACHED BY ITS INPUTS ───────────────────────
   *
   * §12.2 asks for the run to be persisted with an `inputs_hash`. That hash
   * earns its place twice over: it lets the same forecast be served again
   * without recomputing, and it is the honest answer to "why did the forecast
   * change?" - a different hash means different inputs, while the same hash
   * with a different output means the code changed.
   *
   * ── AND IT SAYS WHEN IT DOES NOT KNOW ──────────────────────────────────────
   *
   * `lowConfidence` is true until the org's own collection history is thick
   * enough to beat the priors. §12.2 requires the label and it is the most
   * important field in the response: a forecast an owner acts on is worse than
   * no forecast when its confidence is fictional.
   */
  @Get("forecast")
  @RequireCrmPermission("finance", "view")
  async forecast(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = z
      .object({ horizonDays: z.coerce.number().int().min(7).max(365).default(90) })
      .safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const horizonDays = parsed.data.horizonDays;

    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const settings = await loadFinanceSettings(client, orgId);

      // ── What is scheduled, bucketed by how late it already is ───────────
      const { rows: scheduled } = await client.query<{
        due_date: string;
        amount: string;
      }>(
        `SELECT to_char(ps.due_date, 'YYYY-MM-DD') AS due_date,
                (ps.amount - ps.paid_amount)::text AS amount
           FROM payment_schedules ps
          WHERE ps.status <> 'cancelled'
            AND ps.paid_amount < ps.amount
            -- Everything already overdue lands on day 0: it is collectable now
            -- or not at all, and spreading it forward would forecast cash on a
            -- date that has passed.
            AND ps.due_date <= ($1::date + $2::int)`,
        [today, horizonDays],
      );

      const items: ForecastInflowItem[] = scheduled.map((row) => ({
        dueDate: row.due_date < today ? today : row.due_date,
        amountMinor: toMinor(row.amount),
        bucket: agingBucket(row.due_date, today),
      }));

      // ── P(collected | bucket), learned from this org's own history ───────
      const { rows: history } = await client.query<{
        bucket: string;
        billed: string;
        collected: string;
      }>(
        `SELECT CASE
                  WHEN fp.received_at::date <= ps.due_date THEN 'current'
                  WHEN fp.received_at::date - ps.due_date <= 30 THEN '0_30'
                  WHEN fp.received_at::date - ps.due_date <= 60 THEN '31_60'
                  WHEN fp.received_at::date - ps.due_date <= 90 THEN '61_90'
                  ELSE '90_plus'
                END AS bucket,
                sum(ps.amount)::text AS billed,
                sum(fp.amount)::text AS collected
           FROM finance_payments fp
           JOIN payment_schedules ps ON ps.id = fp.schedule_item_id
          WHERE fp.status IN ('received', 'cheque_cleared', 'partially_refunded')
            AND fp.received_at >= $1::date - interval '12 months'
          GROUP BY 1`,
        [today],
      );

      const probabilities = collectionProbabilities(
        history.map((h) => ({
          bucket: h.bucket as keyof typeof COLLECTION_PRIORS,
          billedMinor: toMinor(h.billed),
          collectedMinor: toMinor(h.collected),
        })),
      );

      // ── New sales, as a weighted run rate over recent weeks ─────────────
      const { rows: weeks } = await client.query<{ amount: string }>(
        `SELECT COALESCE(sum(d.amount), 0)::text AS amount
           FROM generate_series(0, 11) AS w
           LEFT JOIN deals d
             ON d.status = 'won'
            AND d.finance_closed_on >= $1::date - ((w + 1) * 7)
            AND d.finance_closed_on <  $1::date - (w * 7)
          GROUP BY w ORDER BY w DESC`,
        [today],
      );
      const runRate = weightedRunRate(weeks.map((w) => toMinor(w.amount))) ?? 0;

      // ── What goes out: recurring fixed costs, expanded over the horizon ──
      const { rows: fixed } = await client.query<{ amount: string; day: number }>(
        `SELECT (e.amount - e.tax)::text AS amount,
                EXTRACT(DAY FROM e.incurred_on)::int AS day
           FROM expenses e
          WHERE e.is_fixed AND e.recurs = 'monthly' AND e.approved_at IS NOT NULL
            AND e.incurred_on >= $1::date - interval '2 months'
            AND e.reverses_id IS NULL`,
        [today],
      );
      const outflows = [];
      for (let offset = 0; offset < horizonDays; offset += 1) {
        const date = addDays(today, offset);
        const dayOfMonth = Number(date.slice(8, 10));
        for (const cost of fixed) {
          if (cost.day === dayOfMonth) {
            outflows.push({ on: date, amountMinor: toMinor(cost.amount) });
          }
        }
      }

      const cashMinor = await this.cash(client, orgId);
      const scenarios = forecast({
        from: today,
        horizonDays,
        openingBalanceMinor: cashMinor,
        scheduled: items,
        outflows,
        probabilities,
        newSalesPerDayMinor: Math.round(runRate / 7),
      });

      const inputsHash = hashInputs({
        today,
        horizonDays,
        cashMinor,
        items: items.length,
        scheduledMinor: items.reduce((s, i) => s + i.amountMinor, 0),
        outflowMinor: outflows.reduce((s, o) => s + o.amountMinor, 0),
        probabilities: probabilities.byBucket,
        runRate,
      });

      await client.query(
        `INSERT INTO forecast_runs (org_id, horizon_days, inputs_hash, output, low_confidence)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [
          orgId,
          horizonDays,
          inputsHash,
          JSON.stringify({ scenarios, probabilities }),
          probabilities.lowConfidence,
        ],
      );

      const base = scenarios.find((s) => s.key === "base");
      return {
        from: today,
        horizonDays,
        openingBalance: toMajor(cashMinor),
        /** §12.2's label. The most important field in this response. */
        lowConfidence: probabilities.lowConfidence,
        inputsHash,
        scenarios: scenarios.map((s) => ({
          key: s.key,
          trough: toMajor(s.troughMinor),
          troughOn: s.troughOn,
          points: s.points.map((p) => ({
            date: p.date,
            inflow: toMajor(p.inflowMinor),
            outflow: toMajor(p.outflowMinor),
            balance: toMajor(p.balanceMinor),
          })),
        })),
        /** §12.2: "plus the table of assumptions". */
        assumptions: {
          collectionProbabilities: probabilities.byBucket,
          learnedBuckets: probabilities.learned,
          priors: COLLECTION_PRIORS,
          newSalesPerWeek: toMajor(Math.round(runRate)),
          recurringOutflows: outflows.length,
          minimumCash: toMajor(settings.minimumCashMinor),
        },
        /** Whether the base case crosses the owner's floor inside the horizon. */
        breachesMinimum:
          base !== undefined && base.troughMinor < settings.minimumCashMinor,
      };
    });
  }

  /**
   * A period's totals straight from the rollup, for a report that wants the
   * figures without the dashboard's framing.
   *
   * Exists because §12 says the Advisor calls the metrics layer, and this is
   * that call made visible: it is the same `computeTotals` the snapshot builder
   * and the dashboard use, so an advisory citing "collected" cites the number
   * the dashboard shows.
   */
  @Get("totals")
  @RequireCrmPermission("finance", "view")
  async totals(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = z.object({ from: DateOnly, to: DateOnly }).safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.db.withOrg(orgId, async (client) => {
      const totals = await computeTotals(client, orgId, parsed.data);
      return {
        period: parsed.data,
        totals: {
          booked: toMajor(totals.bookedMinor),
          billed: toMajor(totals.billedMinor),
          collected: toMajor(totals.collectedMinor),
          refunded: toMajor(totals.refundedMinor),
          fees: toMajor(totals.feesMinor),
          costs: toMajor(totals.costsMinor),
          incentive: toMajor(totals.incentiveMinor),
          outstanding: toMajor(totals.outstandingMinor),
          dealsClosed: totals.dealsClosed,
          newCustomers: totals.newCustomers,
        },
      };
    });
  }

  private async cash(
    client: Parameters<typeof computeTotals>[0],
    orgId: string,
  ): Promise<number> {
    const { rows } = await client.query<{ balance: string }>(
      `SELECT COALESCE(sum(debit) - sum(credit), 0)::text AS balance
         FROM ledger_entries WHERE org_id = $1 AND account = 'cash'`,
      [orgId],
    );
    return toMinor(rows[0].balance);
  }
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * §12.2's `inputs_hash`.
 *
 * A stable digest of the forecast's inputs. `JSON.stringify` of an object with
 * keys written in a fixed order - not a crypto hash of a Map, whose iteration
 * order would depend on insertion and make the same inputs hash differently
 * between two runs.
 */
function hashInputs(inputs: Record<string, unknown>): string {
  const canonical = JSON.stringify(inputs, Object.keys(inputs).sort());
  let hash = 0;
  for (let i = 0; i < canonical.length; i += 1) {
    hash = (hash * 31 + canonical.charCodeAt(i)) | 0;
  }
  return `h${(hash >>> 0).toString(36)}`;
}
