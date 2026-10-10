import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  AUTONOMY_MIN_CASES,
  AUTONOMY_PRECISION_GATE,
  AgentIntentConfigInput,
  AgentIntentType,
  AgentToolName,
  CustomIntentConfigInput,
  DEFAULT_AUTO_THRESHOLD,
  DEFAULT_REVIEW_THRESHOLD,
  INTENT_CATALOG,
  MIN_CUSTOM_INTENT_EVAL_CASES,
  TOOL_CATALOG,
  autoThresholdFor,
  autonomyDecision,
  caseFromCorrection,
  intentSpec,
  modeIsVisibleToStaff,
  reviewThresholdFor,
  toolSpec,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { actorUserId, auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { FeatureGateGuard, RequireGatedFeature } from "../../common/feature-gate.guard";
import { FeatureGateService } from "../../common/feature-gate.service";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * §12's review inbox, §8.2's configuration, and §13's accuracy reporting.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY THE REVIEW INBOX IS GATED ON THE PERSONA AND NOT ON THE GRID
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §3A.3's access gate: "the telecaller sees their own results; managers see
 * their branch (using the org chart); owners and admins see all."
 *
 * There is no `agent_action` permission object, deliberately. Three gates
 * already stand between a person and an agent action - the `call_intel` module
 * (may this tenant read transcripts at all), the feature gate (is the assistant
 * on), and the persona (whose work is this) - and `permissions.ts`'s own header
 * argues against a fourth axis over one object: it is how "why can Priya not
 * see this" acquires four possible answers and no one of them is
 * authoritative.
 *
 * So the branch filter is INLINE, against the reporting line, and it is stated
 * here because grepping for a decorator will not find it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  APPROVING SOMETHING DOES NOT EXECUTE IT HERE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `POST /:id/approve` moves the action to `approved` and nothing else. The
 * executor - in the worker, behind its own gate re-check (§3A.4) - is what
 * runs it.
 *
 * That is not indirection for its own sake. An approval that executed inline
 * would do it on the API's connection, inside a request a person is waiting
 * on, with no retry and no idempotent claim - and a booking that half-happened
 * because a browser tab closed is exactly the "customer-visible half-done
 * state" §10 forbids.
 */

const FEATURE = "transcript_agent" as const;

const ReviewQuery = z.object({
  state: z.enum(["pending_review", "blocked", "recorded", "done", "failed", "rejected"]).optional(),
  tool: AgentToolName.optional(),
  intentType: z.string().max(60).optional(),
  tier: z.enum(["T0", "T1", "T2", "T3"]).optional(),
  telecallerId: z.string().uuid().optional(),
  language: z.string().max(20).optional(),
  minScore: z.coerce.number().min(0).max(1).optional(),
  /** "1" / "true" - never `z.coerce.boolean()`, which makes "false" truthy. */
  overdue: z.enum(["1", "true"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const RejectBody = z.object({
  /** §12: "edits and rejections store a REASON". Required, not optional. */
  reason: z.string().trim().min(1).max(1000),
});

const EditBody = z.object({
  params: z.record(z.string(), z.unknown()),
  reason: z.string().trim().min(1).max(1000),
});

const BulkApproveBody = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});

const SettingsBody = z.object({
  paused: z.boolean().optional(),
  disabledTools: z.array(AgentToolName).max(AgentToolName.options.length).optional(),
  autoThreshold: z.number().min(0).max(1).nullish(),
  reviewThreshold: z.number().min(0).max(1).nullish(),
  reviewSlaHours: z.number().min(0).max(240).optional(),
  slotMinutes: z.number().int().min(5).max(480).optional(),
  bufferMinutes: z.number().int().min(0).max(240).optional(),
  minNoticeMinutes: z.number().int().min(0).max(10_080).optional(),
  maxBookingsPerDay: z.number().int().min(0).max(200).optional(),
  assignmentStrategy: z.enum(["owner_first", "round_robin", "least_loaded", "skill"]).optional(),
  reason: z.string().trim().max(500).nullish(),
})
  .refine((b) => Object.keys(b).length > 0, "nothing to update")
  .refine(
    (b) =>
      b.autoThreshold === null ||
      b.autoThreshold === undefined ||
      b.reviewThreshold === null ||
      b.reviewThreshold === undefined ||
      b.autoThreshold >= b.reviewThreshold,
    { message: "the auto threshold cannot be below the review threshold" },
  );

@Controller("transcript-agent")
@UseGuards(AdminKeyGuard, TenantGuard, FeatureGateGuard, OwnerRoleGuard)
@RequireGatedFeature("transcript_agent")
export class TranscriptAgentController {
  constructor(
    private readonly db: DbService,
    private readonly gate: FeatureGateService,
  ) {}

  // ══ §12's review inbox ═══════════════════════════════════════════════════

  @Get("review")
  async review(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Query() query: unknown) {
    const q = ReviewQuery.parse(query);
    const visibility = await this.visibility(orgId, req);

    return this.db.withOrg(orgId, async (client) => {
      const params: unknown[] = [];
      const bind = (value: unknown) => {
        params.push(value);
        return `$${params.length}`;
      };
      const where: string[] = [`a.state = ${bind(q.state ?? "pending_review")}`];

      if (q.tool) where.push(`a.tool = ${bind(q.tool)}`);
      if (q.intentType) where.push(`i.type = ${bind(q.intentType)}`);
      if (q.tier) where.push(`a.tier = ${bind(q.tier)}`);
      if (q.telecallerId) where.push(`t.telecaller_id = ${bind(q.telecallerId)}`);
      if (q.language) where.push(`t.language = ${bind(q.language)}`);
      if (q.minScore !== undefined) where.push(`a.final_score >= ${bind(q.minScore)}`);
      // §12's SLA timer: the items that have waited too long, which is what a
      // manager opens the page to find.
      if (q.overdue) where.push("a.review_due_at IS NOT NULL AND a.review_due_at < now()");

      // The access gate (§3A.3), inline - see the header.
      if (visibility.kind === "own") {
        where.push(`t.telecaller_id = ${bind(visibility.telecallerId ?? NO_SUCH_UUID)}`);
      } else if (visibility.kind === "branch") {
        where.push(
          `t.telecaller_id = ANY(${bind(visibility.telecallerIds.length > 0 ? visibility.telecallerIds : [NO_SUCH_UUID])}::uuid[])`,
        );
      }

      const { rows } = await client.query(
        `SELECT a.id, a.tool, a.tier, a.capability, a.params, a.state, a.policy_code, a.reason,
                a.final_score, a.band, a.requested_at, a.review_due_at, a.review_escalated_at,
                a.idempotency_key, a.run_order, a.depends_on,
                i.id AS intent_id, i.type AS intent_type, i.status AS intent_status,
                i.confidence, i.slots, i.resolved, i.evidence, i.signals,
                r.id AS run_id, r.effective_mode, r.model, r.prompt_version,
                r.schema_version, r.resolver_version, r.output -> 'summary' AS summary,
                t.id AS transcript_id, t.call_id, t.language, t.telecaller_id,
                t.roles_inferred, t.stt_confidence, t.started_at,
                COALESCE(tc.display_name, u.name, u.email) AS telecaller_name,
                l.id AS lead_id, COALESCE(l.contact_name, l.title) AS lead_name
           FROM agent_actions a
           JOIN agent_runs r ON r.id = a.run_id
           JOIN agent_transcripts t ON t.id = r.transcript_id
           LEFT JOIN agent_intents i ON i.id = a.intent_id
           LEFT JOIN telecallers tc ON tc.id = t.telecaller_id
           LEFT JOIN users u ON u.id = tc.user_id
           LEFT JOIN leads l ON l.id = t.lead_id
          WHERE ${where.join(" AND ")}
          ORDER BY a.review_due_at NULLS LAST, a.requested_at
          LIMIT ${bind(q.limit)} OFFSET ${bind(q.offset)}`,
        params,
      );

      return {
        items: rows.map((row) => ({
          ...row,
          // §12: the review card shows a confidence BREAKDOWN, not a number.
          // "0.61" tells a reviewer nothing; "the date could be read two ways"
          // tells them what to check.
          confidenceBreakdown: row.signals,
          thresholds: row.intent_type
            ? {
                auto: autoThresholdFor(row.intent_type as AgentIntentType),
                review: reviewThresholdFor(row.intent_type as AgentIntentType),
              }
            : null,
        })),
        visibility: visibility.kind,
      };
    });
  }

  /**
   * One action in full, with the transcript window around its evidence.
   *
   * ── THE TRANSCRIPT IS SERVED NARROWED, NOT WHOLE ───────────────────────
   *
   * §12 wants "a transcript snippet with highlighted evidence and timestamp,
   * audio jump link". The whole transcript is behind the `call_intel` module
   * and the call-access rules (0122); what a reviewer needs is the sentence
   * being quoted. Serving the whole thing from here would be a second, ungated
   * door onto a word-for-word account of a customer's phone call.
   */
  @Get("review/:id")
  async reviewItem(
    @OrgId() orgId: string,
    @Req() req: PrincipalRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const visibility = await this.visibility(orgId, req);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT a.*, i.type AS intent_type, i.status AS intent_status, i.confidence,
                i.slots, i.resolved, i.evidence, i.signals,
                r.effective_mode, r.model, r.prompt_version, r.schema_version,
                r.resolver_version, r.gate_decision, r.mode_cap_reason,
                t.call_id, t.language, t.telecaller_id, t.roles_inferred,
                t.redacted_text, t.injection_signals
           FROM agent_actions a
           JOIN agent_runs r ON r.id = a.run_id
           JOIN agent_transcripts t ON t.id = r.transcript_id
           LEFT JOIN agent_intents i ON i.id = a.intent_id
          WHERE a.id = $1`,
        [id],
      );
      const row = rows[0];
      if (!row) throw new NotFoundException("that suggestion does not exist");
      this.assertVisible(visibility, row.telecaller_id as string | null);

      const evidence = Array.isArray(row.evidence) ? row.evidence : [];
      const transcript = typeof row.redacted_text === "string" ? row.redacted_text : "";

      return {
        action: {
          ...row,
          // Not returned: the whole transcript. Replaced by the windows below.
          redacted_text: undefined,
        },
        evidence: (evidence as Array<Record<string, unknown>>).map((item) => {
          const quote = typeof (item as { quote?: unknown }).quote === "string"
            ? (item as { quote: string }).quote
            : "";
          return { ...(item as object), window: snippetAround(transcript, quote) };
        }),
      };
    });
  }

  /**
   * §12's Approve.
   *
   * ── IT DOES NOT EXECUTE. SEE THE HEADER. ───────────────────────────────
   *
   * And it re-checks the gate before marking anything approvable, because an
   * owner may have switched the feature off since the suggestion was made -
   * §3A.5: "pending review items are FROZEN (not executable)". Approving a
   * frozen item would hand the executor something to run that the owner has
   * since withdrawn consent for.
   */
  @Post("review/:id/approve")
  async approve(
    @OrgId() orgId: string,
    @Req() req: PrincipalRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.decide(orgId, req, id, "approved", null, null);
  }

  /** §12's Reject. The reason becomes an eval case (§13.4). */
  @Post("review/:id/reject")
  async reject(
    @OrgId() orgId: string,
    @Req() req: PrincipalRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const { reason } = RejectBody.parse(body);
    return this.decide(orgId, req, id, "rejected", reason, null);
  }

  /** §12's Edit: approve, but with the person's own values. */
  @Post("review/:id/edit")
  async edit(
    @OrgId() orgId: string,
    @Req() req: PrincipalRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const input = EditBody.parse(body);
    return this.decide(orgId, req, id, "edited", input.reason, input.params);
  }

  /**
   * §12's bulk approve, "for high-confidence similar items".
   *
   * ── BOUNDED, AND EACH ITEM STILL DECIDED SEPARATELY ────────────────────
   *
   * A hundred at a time, and every one goes through the same `decide` path -
   * the same gate re-check, the same frozen check, the same audit row. A bulk
   * endpoint that took a shortcut would be the one place an owner could
   * approve something the gate had closed.
   */
  @Post("review/bulk-approve")
  async bulkApprove(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    const { ids } = BulkApproveBody.parse(body);
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const id of ids) {
      try {
        await this.decide(orgId, req, id, "approved", null, null);
        results.push({ id, ok: true });
      } catch (error) {
        results.push({
          id,
          ok: false,
          error: error instanceof Error ? error.message : "could not be approved",
        });
      }
    }
    return { approved: results.filter((r) => r.ok).length, results };
  }

  // ══ §8.2's configuration ═════════════════════════════════════════════════

  @Get("config")
  @RequireOwnerRole("owner", "manager")
  async config(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows: settings } = await client.query(
        `SELECT * FROM agent_settings LIMIT 1`,
      );
      const { rows: intents } = await client.query(
        `SELECT * FROM agent_intent_config`,
      );
      const { rows: custom } = await client.query(
        `SELECT * FROM agent_custom_intents ORDER BY key`,
      );

      const byType = new Map(intents.map((row) => [row.intent_type as string, row]));

      return {
        settings: settings[0] ?? null,
        defaults: {
          autoThreshold: DEFAULT_AUTO_THRESHOLD,
          reviewThreshold: DEFAULT_REVIEW_THRESHOLD,
          autonomyGate: { precision: AUTONOMY_PRECISION_GATE, minCases: AUTONOMY_MIN_CASES },
        },
        /**
         * The catalogue MERGED with the org's overrides, so the console renders
         * one list. Shipping the two separately would make the screen join them
         * - and a screen that has to join a catalogue to a settings table is a
         * screen that shows a stale default the first time the catalogue
         * changes.
         */
        intents: INTENT_CATALOG.map((spec) => {
          const override = byType.get(spec.type);
          const tier = (override?.tier as string | null) ?? spec.tier;
          const precision = override?.measured_precision as number | null | undefined;
          const reviewed = Number(override?.reviewed_cases ?? 0);
          return {
            type: spec.type,
            label: spec.label,
            meaning: spec.meaning,
            capability: spec.capability,
            tool: spec.tool,
            catalogueTier: spec.tier,
            tier,
            enabled: (override?.enabled as boolean | undefined) ?? true,
            autoEligible: spec.autoEligible,
            autoExecute: (override?.auto_execute as boolean | undefined) ?? false,
            autoThreshold:
              (override?.auto_threshold as number | null | undefined) ?? autoThresholdFor(spec.type),
            reviewThreshold:
              (override?.review_threshold as number | null | undefined) ??
              reviewThresholdFor(spec.type),
            measuredPrecision: precision ?? null,
            reviewedCases: reviewed,
            demotedAt: override?.demoted_at ?? null,
            demotedReason: override?.demoted_reason ?? null,
            // What the autonomy gate would do right now, so the screen can
            // explain why a switch is unavailable instead of just disabling it.
            autonomy: autonomyDecision({
              precision: precision ?? null,
              reviewedCases: reviewed,
              currentlyAuto: Boolean(override?.auto_execute),
              orgWantsAuto: Boolean(override?.auto_execute),
              eligible: spec.autoEligible && spec.tier !== "T3",
            }),
          };
        }),
        customIntents: custom,
        tools: TOOL_CATALOG.map((tool) => ({
          name: tool.name,
          tier: tool.tier,
          capability: tool.capability,
          customerVisible: tool.customerVisible,
          disabled: Array.isArray(settings[0]?.disabled_tools)
            ? (settings[0].disabled_tools as string[]).includes(tool.name)
            : false,
        })),
      };
    });
  }

  /** §10's global and per-tool kill switches, plus §8.1's booking rules. */
  @Put("settings")
  @RequireOwnerRole("owner")
  async setSettings(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    const input = SettingsBody.parse(body);
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO agent_settings
           (org_id, paused, paused_at, paused_by, paused_reason, disabled_tools,
            auto_threshold, review_threshold, review_sla_hours,
            slot_minutes, buffer_minutes, min_notice_minutes, max_bookings_per_day,
            assignment_strategy)
         VALUES ($1,
                 COALESCE($2, false),
                 CASE WHEN $2 THEN now() ELSE NULL END,
                 CASE WHEN $2 THEN $3::uuid ELSE NULL END,
                 CASE WHEN $2 THEN $4 ELSE NULL END,
                 COALESCE($5::text[], '{}'),
                 $6, $7, COALESCE($8, 4),
                 COALESCE($9, 30), COALESCE($10, 10), COALESCE($11, 30), COALESCE($12, 0),
                 COALESCE($13, 'owner_first'))
         ON CONFLICT (org_id) DO UPDATE SET
           -- COALESCE on every column, so a PATCH that omits a field LEAVES IT
           -- ALONE. The partial/default trap, which this codebase already has
           -- one live instance of: an UPDATE that wrote EXCLUDED unconditionally
           -- would reset the booking rules every time somebody toggled the
           -- pause switch.
           paused = COALESCE($2, agent_settings.paused),
           paused_at = CASE WHEN $2 IS NULL THEN agent_settings.paused_at
                            WHEN $2 THEN now() ELSE NULL END,
           paused_by = CASE WHEN $2 IS NULL THEN agent_settings.paused_by
                            WHEN $2 THEN $3::uuid ELSE NULL END,
           paused_reason = CASE WHEN $2 IS NULL THEN agent_settings.paused_reason
                                WHEN $2 THEN $4 ELSE NULL END,
           disabled_tools = COALESCE($5::text[], agent_settings.disabled_tools),
           auto_threshold = COALESCE($6, agent_settings.auto_threshold),
           review_threshold = COALESCE($7, agent_settings.review_threshold),
           review_sla_hours = COALESCE($8, agent_settings.review_sla_hours),
           slot_minutes = COALESCE($9, agent_settings.slot_minutes),
           buffer_minutes = COALESCE($10, agent_settings.buffer_minutes),
           min_notice_minutes = COALESCE($11, agent_settings.min_notice_minutes),
           max_bookings_per_day = COALESCE($12, agent_settings.max_bookings_per_day),
           assignment_strategy = COALESCE($13, agent_settings.assignment_strategy),
           updated_at = now()
         RETURNING *`,
        [
          orgId,
          input.paused ?? null,
          actorUserId(actor),
          input.reason ?? null,
          input.disabledTools ?? null,
          input.autoThreshold ?? null,
          input.reviewThreshold ?? null,
          input.reviewSlaHours ?? null,
          input.slotMinutes ?? null,
          input.bufferMinutes ?? null,
          input.minNoticeMinutes ?? null,
          input.maxBookingsPerDay ?? null,
          input.assignmentStrategy ?? null,
        ],
      );

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, $2, $3, 'transcript_agent.settings_updated', 'agent_settings', $4, $5::jsonb)`,
        // `orgId` is bound TWICE on purpose. `audit_log.org_id` is uuid and
        // `target_id` is text, so one placeholder used for both leaves
        // Postgres deducing two types for it and refusing the statement at
        // execution - which typecheck cannot see and only a PREPARE does.
        [orgId, actor.type, actor.id, orgId, JSON.stringify(input)],
      );

      return { settings: rows[0] };
    });
  }

  /**
   * §8.2's per-intent configuration.
   *
   * ── THE T3 RULE IS ENFORCED THREE TIMES, ON PURPOSE ────────────────────
   *
   * Here (a 403), in `AgentIntentConfigInput`'s tier enum, and in 0185's CHECK
   * on the column. §8.2 says the org "cannot lift T3 actions to automatic", and
   * that is the single most consequential rule in the module - a refund going
   * out by itself is not retractable. Three independent statements of it is the
   * right number for a rule whose failure mode is money leaving a business.
   */
  @Put("config/intents/:type")
  @RequireOwnerRole("owner")
  async setIntent(
    @OrgId() orgId: string,
    @Req() req: PrincipalRequest,
    @Param("type") type: string,
    @Body() body: unknown,
  ) {
    const input = AgentIntentConfigInput.parse(body);
    const parsedType = AgentIntentType.safeParse(type);

    if (parsedType.success) {
      const spec = intentSpec(parsedType.data);
      if (spec.tier === "T3" && input.autoExecute) {
        throw new ForbiddenException(
          "This always needs a person to decide. It cannot be switched to automatic.",
        );
      }
      if (!spec.autoEligible && input.autoExecute) {
        throw new ForbiddenException(
          "This kind of action always waits for a person, whatever the settings say.",
        );
      }
      // §13.3: an intent may only become automatic when its measured precision
      // meets the gate. Checked here so the switch REFUSES rather than being
      // stored and silently ignored by the planner - an owner who flipped it
      // and saw nothing change would reasonably conclude the product is broken.
      if (input.autoExecute) {
        await this.assertAccuracyGate(orgId, parsedType.data);
      }
    } else {
      // A custom intent. The tool restriction in 0185's CHECK already bounds it
      // to T0/T1, and §6 requires eval coverage before autonomous execution.
      if (input.autoExecute) await this.assertCustomIntentCoverage(orgId, type);
    }

    const actor = auditActor(req);
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO agent_intent_config
           (org_id, intent_type, enabled, tier, auto_threshold, review_threshold, auto_execute)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (org_id, intent_type) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           tier = EXCLUDED.tier,
           auto_threshold = EXCLUDED.auto_threshold,
           review_threshold = EXCLUDED.review_threshold,
           auto_execute = EXCLUDED.auto_execute,
           -- Cleared on a manual change: a demotion note that outlives the
           -- owner switching it back on reads as "still demoted" forever.
           demoted_at = NULL,
           demoted_reason = NULL,
           updated_at = now()
         RETURNING *`,
        [
          orgId,
          type,
          input.enabled,
          input.tier ?? null,
          input.autoThreshold ?? null,
          input.reviewThreshold ?? null,
          input.autoExecute,
        ],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, $2, $3, 'transcript_agent.intent_configured', 'agent_intent', $4, $5::jsonb)`,
        [orgId, actor.type, actor.id, type, JSON.stringify(input)],
      );
      return { config: rows[0] };
    });
  }

  /** §6's custom intents. */
  @Post("config/custom-intents")
  @RequireOwnerRole("owner")
  async createCustomIntent(
    @OrgId() orgId: string,
    @Req() req: PrincipalRequest,
    @Body() body: unknown,
  ) {
    const input = CustomIntentConfigInput.parse(body);
    if (input.autoExecute) {
      throw new BadRequestException(
        `A new intent cannot start out automatic. It needs ${MIN_CUSTOM_INTENT_EVAL_CASES} reviewed examples first.`,
      );
    }

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO agent_custom_intents
           (org_id, key, label, meaning, examples, tool, enabled, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
         ON CONFLICT (org_id, key) DO UPDATE SET
           label = EXCLUDED.label, meaning = EXCLUDED.meaning,
           examples = EXCLUDED.examples, tool = EXCLUDED.tool,
           enabled = EXCLUDED.enabled, updated_at = now()
         RETURNING *`,
        [
          orgId,
          input.key,
          input.label,
          input.meaning,
          JSON.stringify(input.examples),
          input.tool ?? null,
          input.enabled,
          actorUserId(auditActor(req)),
        ],
      );
      return { customIntent: rows[0] };
    });
  }

  // ══ §13's accuracy reporting ═════════════════════════════════════════════

  @Get("accuracy")
  @RequireOwnerRole("owner", "manager")
  async accuracy(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT i.type,
                count(*) FILTER (WHERE a.review_decision IS NOT NULL) AS reviewed,
                count(*) FILTER (WHERE a.review_decision = 'approved') AS approved,
                count(*) FILTER (WHERE a.review_decision = 'rejected') AS rejected,
                count(*) FILTER (WHERE a.review_decision = 'edited')   AS edited,
                count(*) FILTER (WHERE a.state = 'done')               AS executed,
                avg(a.final_score) FILTER (WHERE a.final_score IS NOT NULL) AS mean_score
           FROM agent_actions a
           JOIN agent_intents i ON i.id = a.intent_id
          WHERE a.created_at > now() - interval '90 days'
          GROUP BY i.type
          ORDER BY i.type`,
      );

      return {
        gate: { precision: AUTONOMY_PRECISION_GATE, minCases: AUTONOMY_MIN_CASES },
        perIntent: rows.map((row) => {
          const reviewed = Number(row.reviewed);
          const approved = Number(row.approved);
          return {
            type: row.type,
            reviewed,
            approved,
            rejected: Number(row.rejected),
            edited: Number(row.edited),
            executed: Number(row.executed),
            meanScore: row.mean_score === null ? null : Number(row.mean_score),
            // §13.3's measure. An EDIT counts against precision as much as a
            // rejection does: a reviewer who had to change the time was handed
            // the wrong time, and scoring an edit as a success is how a
            // measured 98% becomes a floor that corrects everything.
            precision: reviewed >= 20 ? approved / reviewed : null,
            meetsGate: reviewed >= AUTONOMY_MIN_CASES && approved / reviewed >= AUTONOMY_PRECISION_GATE,
          };
        }),
      };
    });
  }

  @Get("runs/:callId")
  async runsForCall(
    @OrgId() orgId: string,
    @Req() req: PrincipalRequest,
    @Param("callId", ParseUUIDPipe) callId: string,
  ) {
    const visibility = await this.visibility(orgId, req);
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT r.id, r.status, r.effective_mode, r.mode_cap_reason, r.model,
                r.prompt_version, r.schema_version, r.resolver_version, r.policy_version,
                r.latency_ms, r.cost_minor, r.escalated, r.escalation_reason, r.chunked,
                r.error, r.created_at, r.finished_at, r.gate_decision,
                t.telecaller_id, t.status AS transcript_status, t.status_reason,
                t.roles_inferred, t.injection_signals, t.redaction_counts
           FROM agent_runs r
           JOIN agent_transcripts t ON t.id = r.transcript_id
          WHERE r.call_id = $1
          ORDER BY r.created_at DESC`,
        [callId],
      );
      if (rows.length === 0) return { runs: [] };
      this.assertVisible(visibility, rows[0]!.telecaller_id as string | null);

      // §3A.2: shadow mode shows staff NOTHING. The run exists, it cost money,
      // and an owner can see it - but a telecaller must not, because a
      // suggestion they cannot act on is a suggestion that undermines the next
      // one they can.
      const ownerLevel = visibility.kind === "all";
      const visible = rows.filter(
        (row) => ownerLevel || modeIsVisibleToStaff((row.effective_mode as never) ?? "off"),
      );

      const { rows: intents } = await client.query(
        `SELECT i.* FROM agent_intents i
           JOIN agent_runs r ON r.id = i.run_id
          WHERE r.call_id = $1 ORDER BY i.position`,
        [callId],
      );
      const { rows: actions } = await client.query(
        `SELECT a.id, a.run_id, a.intent_id, a.tool, a.tier, a.state, a.policy_code,
                a.reason, a.final_score, a.band, a.executed_at, a.error,
                a.review_decision, a.review_reason, a.target_type, a.target_id
           FROM agent_actions a
           JOIN agent_runs r ON r.id = a.run_id
          WHERE r.call_id = $1 ORDER BY a.run_order, a.requested_at`,
        [callId],
      );

      const runIds = new Set(visible.map((r) => r.id));
      return {
        runs: visible,
        intents: intents.filter((i) => runIds.has(i.run_id)),
        actions: actions.filter((a) => runIds.has(a.run_id)),
      };
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async decide(
    orgId: string,
    req: PrincipalRequest,
    id: string,
    decision: "approved" | "rejected" | "edited",
    reason: string | null,
    params: Record<string, unknown> | null,
  ) {
    const visibility = await this.visibility(orgId, req);
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      // Locked before the decision is made, as its own statement - two people
      // can open the same review item, and a lazy CTE does not lock what it
      // looks like it locks (`resource-hold-sweep.ts` documents the trap).
      const { rows } = await client.query(
        `SELECT a.id, a.state, a.tool, a.tier, a.intent_id, a.params, a.run_id,
                r.transcript_id, t.telecaller_id, t.language, t.redacted_text,
                t.started_at, i.type AS intent_type, i.slots, i.resolved
           FROM agent_actions a
           JOIN agent_runs r ON r.id = a.run_id
           JOIN agent_transcripts t ON t.id = r.transcript_id
           LEFT JOIN agent_intents i ON i.id = a.intent_id
          WHERE a.id = $1
          FOR UPDATE OF a`,
        [id],
      );
      const action = rows[0];
      if (!action) throw new NotFoundException("that suggestion does not exist");
      this.assertVisible(visibility, action.telecaller_id as string | null);

      if (action.state === "frozen" || action.state === "expired") {
        // §3A.5: a frozen item is "not executable". Approving one would hand
        // the executor something the owner has withdrawn consent for.
        throw new ConflictException(
          "The assistant was switched off after this was suggested, so it cannot be approved. Switch it back on first.",
        );
      }
      if (action.state !== "pending_review") {
        throw new ConflictException(`this has already been ${action.state}`);
      }

      // §3A.4's re-check, at the moment of approval. The gate may have closed
      // in the hours a suggestion sat in the queue - and it has to be asked
      // TWICE, about two different people:
      //
      //   the REVIEWER, because approving is using the feature; and
      //   the TELECALLER whose call this was, because §3A.3's processing gate
      //   is keyed on them. An owner who switched one telecaller off must not
      //   find their suggestions still executing because a manager who IS
      //   switched on pressed Approve.
      //
      // The second is the one that is easy to leave out, and leaving it out
      // turns the review queue into a way around the gate.
      if (decision !== "rejected") {
        const capability = toolSpec(action.tool as never).capability;
        const reviewer = await this.gate.checkCapability(
          FEATURE,
          capability,
          await this.gate.subjectForUser(orgId, req.principal?.userId ?? ""),
          orgId,
        );
        if (!reviewer.allowed) {
          throw new ConflictException(
            "That part of the assistant is no longer switched on, so this cannot be approved.",
          );
        }

        const telecallerId = action.telecaller_id as string | null;
        if (telecallerId) {
          const subject = await this.gate.subjectForTelecaller(orgId, telecallerId);
          const owner = await this.gate.checkCapability(FEATURE, capability, subject, orgId);
          if (!owner.allowed) {
            throw new ConflictException(
              "The assistant has been switched off for the person who took this call, so this cannot be approved. Their open suggestions are frozen.",
            );
          }
        }
      }

      const nextState = decision === "rejected" ? "rejected" : "approved";
      await client.query(
        `UPDATE agent_actions
            SET state = $2,
                review_decision = $3,
                review_reason = $4,
                edited_params = $5::jsonb,
                reviewed_by = $6,
                reviewed_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [
          id,
          nextState,
          decision,
          reason,
          params === null ? null : JSON.stringify(params),
          actorUserId(actor),
        ],
      );

      // §12/§13.4: "every correction in the review queue becomes a labeled eval
      // case." Rejections AND edits - an edit is a correction with the right
      // answer attached, which makes it the more valuable of the two.
      if (decision !== "approved") {
        await this.recordEvalCase(client, orgId, actor, id, action, params, reason);
      }

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, $2, $3, $4, 'agent_action', $5, $6::jsonb)`,
        [
          orgId,
          actor.type,
          actor.id,
          `transcript_agent.review_${decision}`,
          id,
          JSON.stringify({ tool: action.tool, tier: action.tier, reason }),
        ],
      );

      return { id, state: nextState, decision };
    });
  }

  private async recordEvalCase(
    client: QueryClient,
    orgId: string,
    actor: { type: string; id: string },
    actionId: string,
    action: Record<string, unknown>,
    params: Record<string, unknown> | null,
    reason: string | null,
  ) {
    const transcript = typeof action.redacted_text === "string" ? action.redacted_text : "";
    if (!transcript) return;

    const expected = {
      intents: action.intent_type
        ? [
            {
              type: action.intent_type as string,
              // The person's own value, where they gave one. That is the LABEL,
              // and it is the whole reason an edit is worth more than a
              // rejection: a rejection says "not this", an edit says "that".
              dueAt:
                typeof params?.dueAt === "string"
                  ? params.dueAt
                  : typeof params?.due_at === "string"
                    ? (params.due_at as string)
                    : null,
            },
          ]
        : [],
      actions: [{ tool: action.tool as string, state: "blocked" as const }],
    };

    const built = caseFromCorrection(actionId, {
      transcript,
      reference: new Date((action.started_at as string) ?? Date.now()).toISOString(),
      // The org's own zone matters for a date label: "tomorrow at 5" is a
      // different instant in two zones, and a golden case resolved against the
      // wrong one would fail for ever.
      timeZone: "Asia/Kolkata",
      language: (action.language as string | null) ?? null,
      tags: [action.tool as string],
      expected,
    });

    await client.query(
      `INSERT INTO agent_eval_cases
         (org_id, source, transcript, expected, tags, language, created_from_action_id, created_by)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::text[], $6, $7, $8)
       -- One case per corrected action: a reviewer changing their mind twice
       -- must not produce two contradictory labels (0185's unique constraint).
       ON CONFLICT (created_from_action_id) DO UPDATE
         SET expected = EXCLUDED.expected, tags = EXCLUDED.tags`,
      [
        orgId,
        params ? "correction" : "rejection",
        JSON.stringify({ text: transcript, reason }),
        JSON.stringify(built.expected),
        built.tags,
        built.language,
        actionId,
        actor.type === "user" ? actor.id : null,
      ],
    );
  }

  /**
   * §13.3's gate, as a refusal.
   *
   * Reads the SAME numbers `/accuracy` reports, so an owner who can see "96%
   * over 240 cases" on the screen gets a refusal that says the same thing.
   */
  private async assertAccuracyGate(orgId: string, type: AgentIntentType) {
    const { reviewed, approved } = await this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{ reviewed: string; approved: string }>(
        `SELECT count(*) FILTER (WHERE a.review_decision IS NOT NULL) AS reviewed,
                count(*) FILTER (WHERE a.review_decision = 'approved') AS approved
           FROM agent_actions a
           JOIN agent_intents i ON i.id = a.intent_id
          WHERE i.type = $1 AND a.created_at > now() - interval '90 days'`,
        [type],
      );
      return { reviewed: Number(rows[0]?.reviewed ?? 0), approved: Number(rows[0]?.approved ?? 0) };
    });

    const precision = reviewed > 0 ? approved / reviewed : null;
    const decision = autonomyDecision({
      precision,
      reviewedCases: reviewed,
      currentlyAuto: false,
      orgWantsAuto: true,
      eligible: true,
    });
    if (decision.action !== "promote") {
      throw new ConflictException({
        code: "accuracy_gate_not_met",
        reviewedCases: reviewed,
        precision,
        required: { precision: AUTONOMY_PRECISION_GATE, minCases: AUTONOMY_MIN_CASES },
        message: `This cannot run on its own yet: ${decision.reason}.`,
      });
    }
  }

  private async assertCustomIntentCoverage(orgId: string, key: string) {
    const count = await this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM agent_eval_cases WHERE $1 = ANY(tags)`,
        [key],
      );
      return Number(rows[0]?.n ?? 0);
    });
    if (count < MIN_CUSTOM_INTENT_EVAL_CASES) {
      throw new ConflictException({
        code: "eval_coverage_required",
        have: count,
        need: MIN_CUSTOM_INTENT_EVAL_CASES,
        message: `Your own intents need ${MIN_CUSTOM_INTENT_EVAL_CASES} reviewed examples before they can run on their own. There are ${count}.`,
      });
    }
  }

  /**
   * §3A.3's access gate, resolved once per request.
   *
   * ── THE BRANCH IS THE ORG CHART'S SUBTREE, NOT A TEAM ──────────────────
   *
   * §3A.3: "managers see their branch (using the org chart)". A team is one
   * node; a branch is everything beneath the manager's seat, which is what a
   * manager with two team leads under them expects. `reporting_lines` (0177) is
   * the only place that shape exists, so the recursive walk is here rather than
   * a `team_id = ` shortcut that would silently exclude a sub-team.
   */
  private async visibility(
    orgId: string,
    req: PrincipalRequest,
  ): Promise<
    | { kind: "all" }
    | { kind: "own"; telecallerId: string | null }
    | { kind: "branch"; telecallerIds: string[] }
  > {
    const principal = req.principal;
    // An operator or a bare admin key sees everything. They are gated by
    // 0122's call-access rules for the transcript CONTENT, which is the
    // sensitive half; the plan and its reasons are support surface.
    if (!principal || principal.viaAdminKey) return { kind: "all" };

    const ownerRole = principal.ownerRole;
    if (ownerRole === "owner" || ownerRole === null) return { kind: "all" };

    if (ownerRole === "manager") {
      const telecallerIds = await this.db.withOrg(orgId, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `WITH RECURSIVE my_seats AS (
             SELECT p.id
               FROM position_assignments pa
               JOIN positions p ON p.id = pa.position_id
              WHERE pa.user_id = $1 AND pa.end_date IS NULL
             UNION
             SELECT rl.position_id
               FROM reporting_lines rl
               JOIN my_seats ms ON rl.manager_position_id = ms.id
              WHERE rl.effective_to IS NULL
           )
           SELECT DISTINCT t.id
             FROM my_seats ms
             JOIN position_assignments pa2 ON pa2.position_id = ms.id AND pa2.end_date IS NULL
             JOIN telecallers t ON t.user_id = pa2.user_id`,
          [principal.userId],
        );
        return rows.map((r) => r.id);
      });
      return { kind: "branch", telecallerIds };
    }

    // telecaller / sales / marketing: their own work only.
    const telecallerId = await this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM telecallers WHERE user_id = $1 LIMIT 1`,
        [principal.userId],
      );
      return rows[0]?.id ?? null;
    });
    return { kind: "own", telecallerId };
  }

  private assertVisible(
    visibility: Awaited<ReturnType<TranscriptAgentController["visibility"]>>,
    telecallerId: string | null,
  ): void {
    if (visibility.kind === "all") return;
    if (visibility.kind === "own") {
      if (telecallerId && telecallerId === visibility.telecallerId) return;
    } else if (telecallerId && visibility.telecallerIds.includes(telecallerId)) {
      return;
    }
    // A 404 and not a 403: the caller learns nothing about work they may not
    // see. Every other scoped read in this codebase makes the same choice.
    throw new NotFoundException("that suggestion does not exist");
  }
}

/** Matches nothing. Used where a scoped filter has no subject to bind. */
const NO_SUCH_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * §12's "transcript snippet with highlighted evidence".
 *
 * A window around the quote and nothing more. Serving the whole transcript from
 * the review endpoint would be a second, ungated door onto a word-for-word
 * account of a customer's phone call - the one artifact `org-modules.ts` says
 * is "the most privacy-sensitive thing this platform stores".
 */
export function snippetAround(transcript: string, quote: string, radius = 200): {
  before: string;
  match: string;
  after: string;
  found: boolean;
} {
  if (!transcript || !quote) return { before: "", match: quote, after: "", found: false };
  const index = transcript.toLowerCase().indexOf(quote.toLowerCase());
  if (index < 0) {
    // The quote did not verify. The reviewer is shown the quote WITHOUT a
    // window and told so, rather than being shown a window from somewhere else
    // in the call - which would read as corroboration of something fabricated.
    return { before: "", match: quote, after: "", found: false };
  }
  return {
    before: transcript.slice(Math.max(0, index - radius), index),
    match: transcript.slice(index, index + quote.length),
    after: transcript.slice(index + quote.length, index + quote.length + radius),
    found: true,
  };
}

interface QueryClient {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}
