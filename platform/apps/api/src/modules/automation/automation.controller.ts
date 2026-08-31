import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  AutomationRuleInput,
  AutomationTrigger,
  SWEEP_TRIGGERS,
  projectDryRun,
  type AutomationSubject,
  type AutomationTrigger as AutomationTriggerValue,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const RULE_COLUMNS = `id, name, description, trigger, conditions, actions, status,
  run_count, last_run_at, created_by, created_at, updated_at`;

const RunsQuery = z.object({
  ruleId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * A rule to preview. `conditions`/`actions` stay `unknown` here on purpose:
 * projectDryRun validates them with the SAME schemas the worker's
 * processEvent uses, and re-validating them at the edge would mean a preview
 * could reject a shape the executor accepts, or the reverse.
 */
const DryRunInput = z.object({
  trigger: AutomationTrigger,
  conditions: z.unknown().optional(),
  actions: z.unknown().optional(),
  /** How far back to replay. Capped — this reads raw events. */
  windowDays: z.coerce.number().int().min(1).max(90).default(30),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/**
 * Automation rules (PRD Layer 2, migration 0049).
 *
 * ── NO CRM PERMISSION GUARD ───────────────────────────────────────────────
 *
 * `CrmPermissionsGuard` gates records; this is org CONFIGURATION, in the same
 * class as pipelines, custom-field definitions and roles — all of which are
 * AdminKeyGuard + TenantGuard for exactly this reason and are pinned that way
 * in guard-mounting.spec.ts. Modelling "who may write an automation rule" as
 * a permission object is a real question, but it is the same question those
 * three already carry, and answering it for one surface and not the others
 * would be worse than answering it for none.
 *
 * A rule that changes records is not a way around a person's own grants,
 * because the executor is the worker and runs with the tenant's own context —
 * a rule cannot reach outside the org that wrote it.
 */
@Controller("automations")
@UseGuards(AdminKeyGuard, TenantGuard)
export class AutomationController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT ${RULE_COLUMNS} FROM automation_rules ORDER BY created_at DESC`,
      );
      return { rules: rows, triggers: AutomationTrigger.options, sweepTriggers: SWEEP_TRIGGERS };
    });
  }

  /**
   * What the engine has actually been doing.
   *
   * Includes rules that DIDN'T match, because "why didn't my rule fire?" is
   * the most common question anybody asks of an automation system, and a log
   * of successes alone cannot answer it.
   */
  @Get("runs")
  async runs(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = RunsQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { ruleId, limit } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT r.id, r.rule_id, a.name AS rule_name, r.subject_type, r.subject_id,
                r.matched, r.outcome, r.error, r.created_at
           FROM automation_runs r
           JOIN automation_rules a ON a.id = r.rule_id
          WHERE ($1::uuid IS NULL OR r.rule_id = $1::uuid)
          ORDER BY r.created_at DESC
          LIMIT $2`,
        [ruleId ?? null, limit],
      );
      return { runs: rows };
    });
  }

  /**
   * "If this rule had been live over the last N days, what would it have
   * done?"
   *
   * ── IT IS A POST THAT WRITES NOTHING ────────────────────────────────
   *
   * POST because the rule being previewed is a body, not a query string —
   * conditions and actions are nested objects, and a rule is normally
   * previewed BEFORE it is saved, so there is no id to GET by. The handler
   * only SELECTs; the projection itself is a pure function that has no
   * database access to misuse.
   *
   * The window is capped because this replays raw events: an unbounded
   * preview on a busy tenant is a table scan somebody triggers by holding
   * down a button.
   */
  @Post("dry-run")
  async dryRun(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = DryRunInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { trigger, conditions, actions, windowDays, limit } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{
        id: string;
        trigger: AutomationTriggerValue;
        subject_type: string | null;
        subject_id: string | null;
        payload: AutomationSubject;
        created_at: Date;
      }>(
        `SELECT id, trigger, subject_type, subject_id, payload, created_at
           FROM automation_events
          WHERE trigger = $1
            AND created_at >= now() - ($2 || ' days')::interval
          ORDER BY created_at DESC
          LIMIT $3`,
        [trigger, String(windowDays), limit],
      );

      const result = projectDryRun(
        { trigger, conditions, actions },
        rows.map((r) => ({
          id: r.id,
          trigger: r.trigger,
          subjectType: r.subject_type,
          subjectId: r.subject_id,
          payload: r.payload ?? {},
          occurredAt: r.created_at,
        })),
        new Date(),
      );

      // Stated rather than left for the reader to infer: a preview capped at
      // `limit` that says "8 matches" reads as "8 in the window", which it is
      // not. The count and the cap have to travel together.
      if (rows.length === limit) {
        result.approximations.push(
          `Only the most recent ${limit} events were replayed — there may be older ones in this window.`,
        );
      }
      return { ...result, windowDays };
    });
  }

  @Post()
  async create(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = AutomationRuleInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const rule = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [created],
      } = await client.query(
        `INSERT INTO automation_rules
           (org_id, name, description, trigger, conditions, actions, status, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
         RETURNING ${RULE_COLUMNS}`,
        [
          orgId,
          rule.name,
          rule.description ?? null,
          rule.trigger,
          JSON.stringify(rule.conditions),
          JSON.stringify(rule.actions),
          rule.status,
          actorUserId(req),
        ],
      );
      await this.audit(client, orgId, "automation.create", created.id, req);
      return { rule: created };
    });
  }

  @Patch(":id")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    // A partial update is re-validated as a WHOLE rule, by merging onto what
    // is stored. Validating the patch alone would let "change the trigger to
    // contact.created" leave a move_stage action behind that can never run —
    // the cross-field checks in AutomationRuleInput only mean anything
    // against the complete rule.
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [existing],
      } = await client.query<{
        name: string;
        description: string | null;
        trigger: string;
        conditions: unknown;
        actions: unknown;
        status: string;
      }>(`SELECT ${RULE_COLUMNS} FROM automation_rules WHERE id = $1`, [id]);
      if (!existing) throw new NotFoundException("automation rule not found");

      const merged = AutomationRuleInput.safeParse({
        name: existing.name,
        description: existing.description,
        trigger: existing.trigger,
        conditions: existing.conditions,
        actions: existing.actions,
        status: existing.status,
        ...(body as object),
      });
      if (!merged.success) throw new BadRequestException(merged.error.issues);
      const rule = merged.data;

      const {
        rows: [updated],
      } = await client.query(
        `UPDATE automation_rules
            SET name = $2, description = $3, trigger = $4,
                conditions = $5::jsonb, actions = $6::jsonb, status = $7
          WHERE id = $1
          RETURNING ${RULE_COLUMNS}`,
        [
          id,
          rule.name,
          rule.description ?? null,
          rule.trigger,
          JSON.stringify(rule.conditions),
          JSON.stringify(rule.actions),
          rule.status,
        ],
      );
      await this.audit(client, orgId, "automation.update", id, req);
      return { rule: updated };
    });
  }

  /**
   * Deleted, not archived — unlike a custom field.
   *
   * A field definition is archived because records still hold values that
   * refer to it. A rule holds nothing: its history lives in automation_runs,
   * which keeps its own copy of what happened. Leaving a paused rule around
   * forever would just be a list of things somebody has to read past.
   */
  @Delete(":id")
  async remove(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string, @Req() req: PrincipalRequest) {
    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(`DELETE FROM automation_rules WHERE id = $1`, [id]);
      if (!rowCount) throw new NotFoundException("automation rule not found");
      await this.audit(client, orgId, "automation.delete", id, req);
      return { deleted: true };
    });
  }

  private async audit(
    client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    orgId: string,
    action: string,
    targetId: string,
    req: PrincipalRequest,
  ) {
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
       VALUES ($1, 'user', $2, $3, 'automation_rule', $4)`,
      [orgId, req.principal?.userId ?? "dev-admin", action, targetId],
    );
  }
}

function actorUserId(req: PrincipalRequest): string | null {
  const parsed = z.string().uuid().safeParse(req.principal?.userId);
  return parsed.success ? parsed.data : null;
}
