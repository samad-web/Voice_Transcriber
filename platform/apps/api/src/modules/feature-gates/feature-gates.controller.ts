import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  AGENT_CAPABILITY_BLURBS,
  AGENT_CAPABILITY_LABELS,
  AGENT_MODE_BLURBS,
  AGENT_MODE_LABELS,
  AgentCapability,
  AgentMode,
  GATED_FEATURES,
  GateBackfillInput,
  GateBulkInput,
  GateOrgSettingInput,
  GateSubjectSettingInput,
  GatedFeatureKey,
  evaluateCaps,
  gatedFeatureSpec,
  lowerMode,
  modeRank,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { actorUserId, auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { FeatureGateService } from "../../common/feature-gate.service";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * §3A.8's admin API - the owner's switchboard for a gated feature.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  OWNER AND ADMIN ONLY, AND THAT IS `OwnerRoleGuard`, NOT THE GRID
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §18: "who can change toggles: owner and admin only." Enforced with
 * `@RequireOwnerRole("owner")` rather than a `role_permissions` cell, for the
 * same reason the finance module keeps connector credentials off the grid: a
 * grid cell that can be ticked is the wrong shape for "nobody but the owner,
 * ever". A manager who could enable the feature for their own team could
 * enable `messaging` for it, and messaging reaches customers.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  NO ROUTE HERE CARRIES `@RequireGatedFeature`
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Deliberately, and it is the one exception in the whole module. Gating the
 * screen that turns the feature on behind the feature being on is a workspace
 * one click from needing an operator with a SQL prompt to recover - the same
 * class of refusal `features.ts` makes for its two `locked` entries and
 * `guardLastOwner` makes for the last owner. `agent-gate-coverage.spec.ts`
 * carries this controller as its single documented exemption.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  EVERY WRITE IS CLAMPED, AUDITED AND INVALIDATES THE CACHE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §3A.8: "all writes require the owner/admin role, are validated against the
 * org maximum, and are audit-logged." Three things, and the middle one is the
 * one a reader should check for: a per-user write that exceeded the org's
 * maximum would be stored and then silently clamped by the resolver, so the
 * admin screen would show a mode the product does not honour. It is clamped
 * HERE, at the write, so the stored value is the true one.
 */

const FEATURE = "transcript_agent" as const;

const EffectiveQuery = z.object({
  userId: z.string().uuid().optional(),
  feature: GatedFeatureKey.optional(),
});

const AuditQuery = z.object({
  feature: GatedFeatureKey.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const DefaultsInput = z.object({
  /** `role` defaults by persona, `team` defaults by org-chart team. */
  scope: z.enum(["role", "team"]),
  scopeId: z.string().min(1).max(64),
  setting: GateSubjectSettingInput,
});

const ConsentInput = z.object({
  noticeVersion: z.string().trim().min(1).max(40),
  acknowledged: z.literal(true),
});

@Controller("features/gated")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
export class FeatureGatesController {
  constructor(
    private readonly db: DbService,
    private readonly gate: FeatureGateService,
  ) {}

  // ── reads ────────────────────────────────────────────────────────────────

  /**
   * The catalogue, with every mode and capability's plain-language blurb.
   *
   * §3A.6: "with a plain-language explanation of each." Served from the API
   * rather than duplicated in the console, so the words an owner reads when
   * deciding and the words in an audit row are the same words.
   */
  @Get("catalogue")
  catalogue() {
    return {
      features: GATED_FEATURES.map((spec) => ({
        key: spec.key,
        name: spec.name,
        description: spec.description,
        module: spec.module,
        modes: spec.modes.map((mode) => ({
          key: mode,
          label: AGENT_MODE_LABELS[mode],
          blurb: AGENT_MODE_BLURBS[mode],
        })),
        capabilities: spec.capabilities.map((capability) => ({
          key: capability,
          label: AGENT_CAPABILITY_LABELS[capability],
          blurb: AGENT_CAPABILITY_BLURBS[capability],
        })),
        defaultModeOnEnable: spec.defaultModeOnEnable,
        defaultCapabilitiesOnEnable: spec.defaultCapabilitiesOnEnable,
        consentNoticeVersion: spec.consentNoticeVersion,
      })),
    };
  }

  /** `GET /features/transcript-agent/effective?userId=` (§3A.8). */
  @Get("effective")
  @RequireOwnerRole("owner", "manager")
  async effective(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Query() query: unknown) {
    const { userId, feature } = EffectiveQuery.parse(query);
    const key = feature ?? FEATURE;
    // Absent `userId` means "for me", which is what a console drawing its own
    // nav asks. A manager asking about somebody else is the configuration case
    // and needs the owner/manager persona this route already requires.
    const target = userId ?? req.principal?.userId;
    if (!target) throw new BadRequestException("no user to resolve");

    const subject = await this.gate.subjectForUser(orgId, target);
    const decision = await this.gate.check(key, subject, orgId);
    const caps = await this.gate.capsFor(orgId, key);

    return {
      feature: key,
      enabled: decision.enabled,
      mode: decision.mode,
      capabilities: decision.capabilities,
      lockedByPlan: decision.lockedByPlan,
      reason: decision.reason,
      // §3A.4's snapshot, returned so the admin screen can say WHICH scope
      // decided - "off because your team is excluded" is a different fix from
      // "off because nobody switched you on".
      scopes: decision.scopes,
      caps,
    };
  }

  /** §3A.6's users table. */
  @Get("users")
  @RequireOwnerRole("owner", "manager")
  async users(@OrgId() orgId: string, @Query() query: unknown) {
    const { feature } = EffectiveQuery.parse(query);
    const key = feature ?? FEATURE;
    const period = new Date().toISOString().slice(0, 7);

    return this.db.withOrg(orgId, async (client) => {
      /**
       * ONE statement for the whole table.
       *
       * The screen needs, per person: their name, their seat and team from the
       * org chart, their stored setting, their usage this period, their last
       * activity and their measured accuracy. Six reads per row against a
       * database ~125ms away is how a page with forty telecallers on it takes
       * twelve seconds.
       *
       * ── IT STARTS FROM `telecallers`, NOT FROM `users` ────────────────────
       *
       * The processing gate's subject is the telecaller who handled the call,
       * and `telecallers.user_id` is nullable - so a table built from `users`
       * would omit most of a floor and an owner would have no way to switch
       * the feature on for them. The FULL OUTER shape here is a UNION: every
       * telecaller, plus any console member who is not one (an owner who takes
       * the occasional call through the web dialer).
       */
      const { rows } = await client.query(
        `WITH people AS (
           SELECT t.id AS telecaller_id, t.user_id, COALESCE(t.display_name, u.name, u.email) AS name
             FROM telecallers t
             LEFT JOIN users u ON u.id = t.user_id
            WHERE t.status = 'active'
           UNION
           SELECT NULL::uuid, m.user_id, COALESCE(u.name, u.email)
             FROM memberships m
             JOIN users u ON u.id = m.user_id
            WHERE NOT EXISTS (SELECT 1 FROM telecallers t2 WHERE t2.user_id = m.user_id)
         ),
         seats AS (
           SELECT pa.user_id, p.title, p.team_id, tm.name AS team_name
             FROM position_assignments pa
             JOIN positions p ON p.id = pa.position_id
             LEFT JOIN teams tm ON tm.id = p.team_id
            WHERE pa.end_date IS NULL
         )
         SELECT pe.telecaller_id, pe.user_id, pe.name,
                s.title AS position, s.team_id, s.team_name,
                m.owner_role,
                fs.state, fs.mode, fs.capabilities, fs.effective_from, fs.effective_to,
                COALESCE(fu.transcripts, 0)      AS transcripts,
                COALESCE(fu.audio_minutes, 0)    AS audio_minutes,
                COALESCE(fu.model_cost_minor, 0) AS model_cost_minor,
                (SELECT max(r.created_at) FROM agent_runs r
                   JOIN agent_transcripts at2 ON at2.id = r.transcript_id
                  WHERE at2.telecaller_id = pe.telecaller_id) AS last_activity_at,
                -- §3A.7: "accuracy for that user", beside the cost, so an
                -- owner can decide where the feature pays off. Reviewed
                -- actions only: an unreviewed action is not evidence either
                -- way, and counting it as correct is how a floor nobody checks
                -- scores 100%.
                (SELECT count(*) FROM agent_actions a
                   JOIN agent_runs r2 ON r2.id = a.run_id
                   JOIN agent_transcripts at3 ON at3.id = r2.transcript_id
                  WHERE at3.telecaller_id = pe.telecaller_id
                    AND a.review_decision IS NOT NULL) AS reviewed_cases,
                (SELECT count(*) FROM agent_actions a
                   JOIN agent_runs r3 ON r3.id = a.run_id
                   JOIN agent_transcripts at4 ON at4.id = r3.transcript_id
                  WHERE at4.telecaller_id = pe.telecaller_id
                    AND a.review_decision = 'approved') AS approved_cases
           FROM people pe
           LEFT JOIN seats s ON s.user_id = pe.user_id
           LEFT JOIN memberships m ON m.user_id = pe.user_id
           LEFT JOIN feature_settings fs
                  ON fs.feature_key = $1
                 AND fs.effective_to IS NULL
                 AND ((fs.scope_type = 'user' AND fs.scope_id = pe.user_id)
                   OR (fs.scope_type = 'user' AND fs.scope_id = pe.telecaller_id))
           LEFT JOIN feature_usage fu
                  ON fu.feature_key = $1 AND fu.period = $2
                 AND (fu.user_id = pe.user_id OR fu.telecaller_id = pe.telecaller_id)
          ORDER BY pe.name NULLS LAST`,
        [key, period],
      );

      const spec = gatedFeatureSpec(key);
      const orgRow = await this.orgSetting(client, key);
      const maxMode: AgentMode = (orgRow?.mode as AgentMode | null) ?? spec.defaultModeOnEnable;

      return {
        feature: key,
        org: orgRow,
        users: rows.map((row) => {
          const reviewed = Number(row.reviewed_cases ?? 0);
          const approved = Number(row.approved_cases ?? 0);
          const stored = (row.mode as AgentMode | null) ?? null;
          return {
            userId: row.user_id,
            telecallerId: row.telecaller_id,
            name: row.name ?? "(unnamed)",
            position: row.position,
            teamId: row.team_id,
            teamName: row.team_name,
            ownerRole: row.owner_role,
            state: row.state ?? "inherit",
            // The EFFECTIVE mode, clamped - never the stored one. A screen
            // showing a mode the product does not honour is worse than no
            // screen.
            mode: stored ? lowerMode(stored, maxMode) : maxMode,
            capabilities: Array.isArray(row.capabilities) ? row.capabilities : null,
            effectiveFrom: row.effective_from,
            effectiveTo: row.effective_to,
            lastActivityAt: row.last_activity_at,
            usage: {
              transcripts: Number(row.transcripts),
              audioMinutes: Number(row.audio_minutes),
              modelCostMinor: Number(row.model_cost_minor),
            },
            // NULL below a floor: a precision of 1.0 over two decisions is a
            // number that misleads, and §13.3's gate needs 200.
            precision: reviewed >= 20 ? approved / reviewed : null,
            reviewedCases: reviewed,
          };
        }),
      };
    });
  }

  /** §3A.6's audit tab. */
  @Get("audit")
  @RequireOwnerRole("owner")
  async audit(@OrgId() orgId: string, @Query() query: unknown) {
    const { feature, limit, offset } = AuditQuery.parse(query);
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT a.id, a.feature_key, a.actor_id, a.actor_type, a.scope_type, a.scope_id,
                a.scope_role, a.event, a.before, a.after, a.reason, a.created_at,
                COALESCE(u.name, u.email) AS actor_name
           FROM feature_audit a
           LEFT JOIN users u ON u.id = a.actor_id
          WHERE ($1::text IS NULL OR a.feature_key = $1)
          ORDER BY a.created_at DESC
          LIMIT $2 OFFSET $3`,
        [feature ?? null, limit, offset],
      );
      return { entries: rows };
    });
  }

  // ── writes ───────────────────────────────────────────────────────────────

  /** `PUT /features/transcript-agent/org` - the master switch (§3A.8). */
  @Put("org")
  @RequireOwnerRole("owner")
  async setOrg(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    const input = GateOrgSettingInput.parse(body);
    const spec = gatedFeatureSpec(FEATURE);

    return this.db.withOrg(orgId, async (client) => {
      const before = await this.orgSetting(client, FEATURE);

      // §3A.5: "first enablement shows the owner a consent and notice
      // acknowledgement... stored with who and when."
      //
      // Checked HERE and not in the console, because the console is not the
      // enforcement point for anything else in this module either. Turning the
      // feature on means a model starts reading recordings of customer phone
      // calls, and an acknowledgement that can be skipped by calling the API
      // directly is not an acknowledgement.
      if (input.state === "on" && (!before || before.state !== "on")) {
        const { rowCount } = await client.query(
          `SELECT 1 FROM feature_consents
            WHERE feature_key = $1 AND notice_version = $2 LIMIT 1`,
          [FEATURE, spec.consentNoticeVersion],
        );
        if ((rowCount ?? 0) === 0) {
          throw new ConflictException({
            code: "consent_required",
            noticeVersion: spec.consentNoticeVersion,
            message:
              "Before this can be switched on, somebody has to acknowledge what it does with call recordings and customer data.",
          });
        }
      }

      await this.closeOpenSetting(client, FEATURE, "org", null, null, input.effectiveFrom);

      const { rows } = await client.query(
        `INSERT INTO feature_settings
           (org_id, feature_key, scope_type, scope_id, state, mode, capabilities,
            effective_from, effective_to, set_by, reason)
         VALUES ($1, $2, 'org', NULL, $3, $4, $5::jsonb, COALESCE($6, now()), $7, $8, $9)
         RETURNING id, state, mode, capabilities, effective_from, effective_to`,
        [
          orgId,
          FEATURE,
          input.state,
          input.maxMode,
          JSON.stringify(input.capabilities),
          input.effectiveFrom ?? null,
          input.effectiveTo ?? null,
          actorUserId(auditActor(req)),
          input.reason ?? null,
        ],
      );

      await this.recordAudit(client, orgId, req, {
        event: input.state === "on" ? "org_enabled" : "org_disabled",
        scopeType: "org",
        before,
        after: rows[0],
        reason: input.reason ?? null,
      });

      // §3A.4's invalidation, in the same request that wrote the change.
      this.gate.invalidate(orgId, FEATURE);

      return {
        setting: rows[0],
        // §3A.5's "what happens on turning off", computed so the console can
        // show it in the confirmation rather than guessing.
        consequences:
          input.state === "off" ? await this.switchOffConsequences(client) : null,
      };
    });
  }

  /** `PUT /features/transcript-agent/users/:userId` (§3A.8). */
  @Put("users/:userId")
  @RequireOwnerRole("owner")
  async setUser(
    @OrgId() orgId: string,
    @Req() req: PrincipalRequest,
    @Param("userId") userId: string,
    @Body() body: unknown,
  ) {
    const input = GateSubjectSettingInput.parse(body);
    if (!z.string().uuid().safeParse(userId).success) {
      throw new BadRequestException("userId must be a uuid");
    }
    return this.writeSubjectSetting(orgId, req, "user", userId, null, input);
  }

  /** `POST /features/transcript-agent/users/bulk` (§3A.8). */
  @Post("users/bulk")
  @RequireOwnerRole("owner")
  async bulk(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    const input = GateBulkInput.parse(body);

    if (input.target.kind === "users") {
      const results = [];
      for (const userId of input.target.userIds) {
        results.push(
          await this.writeSubjectSetting(orgId, req, "user", userId, null, input.setting),
        );
      }
      return { applied: results.length };
    }

    if (input.target.kind === "team") {
      // ── A TEAM ROW, NOT A ROW PER MEMBER ─────────────────────────────────
      //
      // §3A.6 offers "bulk select by team, department or position", and the
      // obvious implementation is to expand the team and write a user row for
      // each. That is wrong in a way that shows up weeks later: a person who
      // JOINS the team afterwards would not be covered, and §3A.5's "apply to
      // new joiners in this team or role" would then need a second mechanism.
      // One team row covers the team as it is and as it becomes.
      await this.writeSubjectSetting(orgId, req, "team", input.target.teamId, null, input.setting);
      return { applied: 1, scope: "team" };
    }

    await this.writeSubjectSetting(orgId, req, "role", null, input.target.ownerRole, input.setting);
    return { applied: 1, scope: "role" };
  }

  /** `PUT /features/transcript-agent/defaults` - team/role defaults (§3A.8). */
  @Put("defaults")
  @RequireOwnerRole("owner")
  async defaults(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    const input = DefaultsInput.parse(body);
    if (input.scope === "team" && !z.string().uuid().safeParse(input.scopeId).success) {
      throw new BadRequestException("a team default needs a team id");
    }
    return this.writeSubjectSetting(
      orgId,
      req,
      input.scope,
      input.scope === "team" ? input.scopeId : null,
      input.scope === "role" ? input.scopeId : null,
      input.setting,
    );
  }

  /** §3A.5's consent acknowledgement. */
  @Post("consent")
  @RequireOwnerRole("owner")
  async consent(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    const input = ConsentInput.parse(body);
    const spec = gatedFeatureSpec(FEATURE);
    if (input.noticeVersion !== spec.consentNoticeVersion) {
      // A stale console acknowledging last month's notice is not an
      // acknowledgement of this one.
      throw new ConflictException({
        code: "notice_superseded",
        noticeVersion: spec.consentNoticeVersion,
        message: "The notice has changed since this page was opened. Reload and read it again.",
      });
    }
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO feature_consents
           (org_id, feature_key, acknowledged_by, acknowledged_by_label, notice_version, ip)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, notice_version, created_at`,
        [
          orgId,
          FEATURE,
          actorUserId(auditActor(req)),
          req.principal?.operatorEmail ?? null,
          input.noticeVersion,
          req.ip ?? null,
        ],
      );
      await this.recordAudit(client, orgId, req, {
        event: "consent_acknowledged",
        scopeType: "org",
        before: null,
        after: rows[0],
        reason: null,
      });
      return { consent: rows[0] };
    });
  }

  /**
   * `POST /features/transcript-agent/backfill` (§3A.8).
   *
   * ── PREVIEW BY DEFAULT, AND THE MODE IS NOT A PARAMETER ────────────────────
   *
   * §3A.5: a backfill "shows a preview with counts and estimated cost, limits
   * the age range (default max 7 days), and forces `suggest` mode with NO
   * customer messages."
   *
   * All four constraints are structural rather than checked: `GateBackfillInput`
   * caps `days` at 7 and has no `mode` or `sendMessages` field at all, so there
   * is nothing for a caller to set and nothing for this handler to validate. A
   * field that can be set to true is a field somebody sets to true.
   */
  @Post("backfill")
  @RequireOwnerRole("owner")
  async backfill(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    const input = GateBackfillInput.parse(body);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{
        calls: string;
        minutes: string;
      }>(
        `SELECT count(*)::text AS calls,
                COALESCE(ceil(sum(c.duration_s) / 60.0), 0)::text AS minutes
           FROM calls c
           JOIN telecallers t ON t.id = c.telecaller_id
           JOIN transcripts tr ON tr.call_id = c.id
          WHERE t.user_id = ANY($1::uuid[])
            AND c.ended_at >= now() - ($2 || ' days')::interval
            AND tr.text IS NOT NULL
            AND char_length(btrim(tr.text)) > 40
            -- Nothing already processed. A backfill is for the gap before the
            -- feature was switched on, and re-reading a call that already has
            -- a run would pay a provider twice for the same answer.
            AND NOT EXISTS (
              SELECT 1 FROM agent_transcripts at2 WHERE at2.call_id = c.id
            )`,
        [input.userIds, String(input.days)],
      );

      const calls = Number(rows[0]?.calls ?? 0);
      const minutes = Number(rows[0]?.minutes ?? 0);
      // A deliberately coarse estimate, from the measured per-call cost in
      // `agent_runs`, falling back to a documented constant. Shown as a RANGE
      // in the console rather than a figure, because a precise-looking
      // estimate of somebody else's bill is worse than an honest band.
      const { rows: costRows } = await client.query<{ avg: string | null }>(
        `SELECT avg(cost_minor)::text AS avg FROM agent_runs
          WHERE cost_minor IS NOT NULL AND created_at > now() - interval '30 days'`,
      );
      const perCallMinor = Math.round(Number(costRows[0]?.avg ?? 0)) || DEFAULT_COST_PER_CALL_MINOR;

      const preview = {
        calls,
        audioMinutes: minutes,
        estimatedCostMinor: calls * perCallMinor,
        perCallMinor,
        days: input.days,
        mode: "suggest" as const,
        customerMessages: false as const,
      };

      if (!input.confirm) return { preview, started: false };

      await client.query(
        `INSERT INTO agent_transcripts
           (org_id, call_id, source, external_call_id, version, lead_id, telecaller_id,
            caller_user_id, direction, started_at, ended_at, duration_sec, language,
            stt_provider, stt_confidence, status, status_reason)
         SELECT c.org_id, c.id, 'backfill', c.id::text, 1, l.id, c.telecaller_id, t.user_id,
                c.direction, c.started_at, c.ended_at, c.duration_s, tr.language,
                tr.engine, tr.confidence, 'ready',
                'backfilled by an owner when the feature was switched on'
           FROM calls c
           JOIN telecallers t ON t.id = c.telecaller_id
           JOIN transcripts tr ON tr.call_id = c.id
           LEFT JOIN leads l ON l.id = (SELECT lead_id FROM calls WHERE id = c.id)
          WHERE t.user_id = ANY($1::uuid[])
            AND c.ended_at >= now() - ($2 || ' days')::interval
            AND tr.text IS NOT NULL AND char_length(btrim(tr.text)) > 40
            AND NOT EXISTS (SELECT 1 FROM agent_transcripts at2 WHERE at2.call_id = c.id)
         ON CONFLICT (org_id, source, external_call_id, version) DO NOTHING`,
        [input.userIds, String(input.days)],
      );

      await this.recordAudit(client, orgId, req, {
        event: "backfill_started",
        scopeType: "org",
        before: null,
        after: preview,
        reason: null,
      });

      return { preview, started: true };
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async writeSubjectSetting(
    orgId: string,
    req: PrincipalRequest,
    scopeType: "user" | "team" | "role",
    scopeId: string | null,
    scopeRole: string | null,
    input: z.infer<typeof GateSubjectSettingInput>,
  ) {
    const spec = gatedFeatureSpec(FEATURE);

    return this.db.withOrg(orgId, async (client) => {
      const orgRow = await this.orgSetting(client, FEATURE);
      const maxMode: AgentMode = (orgRow?.mode as AgentMode | null) ?? spec.defaultModeOnEnable;
      const orgCapabilities: readonly AgentCapability[] = Array.isArray(orgRow?.capabilities)
        ? (orgRow.capabilities as AgentCapability[])
        : spec.defaultCapabilitiesOnEnable;

      // ── CLAMPED AT THE WRITE, NOT AT THE READ ──────────────────────────
      //
      // The resolver clamps too (§3A.1 step 5), so this is belt and braces -
      // but without it the STORED value would be a mode the product does not
      // honour, and the admin screen would show it. An owner who sets a
      // telecaller to `auto` while the org maximum is `suggest` should see
      // `suggest`, not a promise that is quietly broken.
      const requestedMode = (input.mode ?? null) as AgentMode | null;
      const mode = requestedMode ? lowerMode(requestedMode, maxMode) : null;
      const clamped = requestedMode !== null && mode !== requestedMode;

      const capabilities =
        input.capabilities === null || input.capabilities === undefined
          ? null
          : input.capabilities.filter((c) => orgCapabilities.includes(c));

      const before = await this.subjectSetting(client, FEATURE, scopeType, scopeId, scopeRole);
      await this.closeOpenSetting(
        client,
        FEATURE,
        scopeType,
        scopeId,
        scopeRole,
        input.effectiveFrom,
      );

      const { rows } = await client.query(
        `INSERT INTO feature_settings
           (org_id, feature_key, scope_type, scope_id, scope_kind, scope_role, state, mode,
            capabilities, effective_from, effective_to, set_by, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, COALESCE($10, now()), $11, $12, $13)
         RETURNING id, scope_type, scope_id, scope_role, state, mode, capabilities,
                   effective_from, effective_to`,
        [
          orgId,
          FEATURE,
          scopeType,
          scopeId,
          scopeType === "user" ? "user" : scopeType === "team" ? "team" : null,
          scopeRole,
          input.state,
          mode,
          capabilities === null ? null : JSON.stringify(capabilities),
          input.effectiveFrom ?? null,
          input.effectiveTo ?? null,
          actorUserId(auditActor(req)),
          input.reason ?? null,
        ],
      );

      await this.recordAudit(client, orgId, req, {
        event: `_`,
        scopeType,
        scopeId,
        scopeRole,
        before,
        after: rows[0],
        reason: input.reason ?? null,
      });

      this.gate.invalidate(orgId, FEATURE);

      return {
        setting: rows[0],
        // Surfaced rather than silent: the console shows "set to suggest, the
        // most this workspace allows" instead of appearing to ignore the
        // choice.
        clampedToOrgMaximum: clamped ? maxMode : null,
      };
    });
  }

  private async orgSetting(client: QueryClient, feature: string) {
    const { rows } = await client.query(
      `SELECT id, state, mode, capabilities, effective_from, effective_to
         FROM feature_settings
        WHERE feature_key = $1 AND scope_type = 'org' AND effective_to IS NULL
        LIMIT 1`,
      [feature],
    );
    return rows[0] ?? null;
  }

  private async subjectSetting(
    client: QueryClient,
    feature: string,
    scopeType: string,
    scopeId: string | null,
    scopeRole: string | null,
  ) {
    const { rows } = await client.query(
      `SELECT id, state, mode, capabilities, effective_from, effective_to
         FROM feature_settings
        WHERE feature_key = $1 AND scope_type = $2 AND effective_to IS NULL
          AND scope_id IS NOT DISTINCT FROM $3
          AND scope_role IS NOT DISTINCT FROM $4
        LIMIT 1`,
      [feature, scopeType, scopeId, scopeRole],
    );
    return rows[0] ?? null;
  }

  /**
   * Close the currently-open row before inserting the new one.
   *
   * ── WHY NOT AN UPSERT ───────────────────────────────────────────────────
   *
   * §10A.6-style effective dating: the HISTORY is the point. An upsert would
   * overwrite what was true last month, and §3A.6's audit tab promises "from
   * what to what". The partial unique index in 0184 refuses a second open row,
   * so closing first is also the only way the insert succeeds.
   *
   * `effective_to` is set to the new row's `effective_from`, not to `now()` -
   * so a change SCHEDULED for next Monday leaves today's row in force until
   * then, which is what §3A.5's scheduled changes mean.
   */
  private async closeOpenSetting(
    client: QueryClient,
    feature: string,
    scopeType: string,
    scopeId: string | null,
    scopeRole: string | null,
    effectiveFrom: string | null | undefined,
  ) {
    await client.query(
      `UPDATE feature_settings
          SET effective_to = GREATEST(COALESCE($5::timestamptz, now()), effective_from + interval '1 microsecond'),
              updated_at = now()
        WHERE feature_key = $1 AND scope_type = $2 AND effective_to IS NULL
          AND scope_id IS NOT DISTINCT FROM $3
          AND scope_role IS NOT DISTINCT FROM $4`,
      [feature, scopeType, scopeId, scopeRole, effectiveFrom ?? null],
    );
  }

  /**
   * §3A.5's "what happens on turning off", counted rather than described.
   *
   * The console shows these numbers in the confirmation dialog, because "12
   * suggestions will be frozen and 3 call-backs will become ordinary tasks" is
   * a decision an owner can make and "this will turn the feature off" is not.
   */
  private async switchOffConsequences(client: QueryClient) {
    const { rows } = await client.query(
      `SELECT
         (SELECT count(*) FROM agent_actions WHERE state = 'pending_review') AS pending_review,
         (SELECT count(*) FROM agent_runs WHERE status IN ('queued', 'running')) AS in_flight,
         (SELECT count(*) FROM callbacks
           WHERE status IN ('scheduled','due','reminded','in_progress','missed','escalated'))
           AS open_callbacks,
         (SELECT count(*) FROM agent_actions
           WHERE state = 'done' AND target_id IS NOT NULL) AS created_so_far`,
    );
    const row = rows[0] ?? {};
    return {
      pendingReviewFrozen: Number(row.pending_review ?? 0),
      runsHeld: Number(row.in_flight ?? 0),
      callbacksConvertedToTasks: Number(row.open_callbacks ?? 0),
      // §3A.5: "bookings, tasks and records already created STAY (no silent
      // deletion). Offer the owner a 'review what the agent created' list with
      // bulk cancel."
      alreadyCreatedKept: Number(row.created_so_far ?? 0),
    };
  }

  private async recordAudit(
    client: QueryClient,
    orgId: string,
    req: PrincipalRequest,
    entry: {
      event: string;
      scopeType: string;
      scopeId?: string | null;
      scopeRole?: string | null;
      before: unknown;
      after: unknown;
      reason: string | null;
    },
  ) {
    const actor = auditActor(req);
    // BOTH trails. `feature_audit` is the per-feature, per-scope history the
    // admin screen reads; `audit_log` is the org's flat governance stream. One
    // write to each, in the same transaction as the change, so neither can
    // disagree with what actually happened. 0184's header argues the split.
    await client.query(
      `INSERT INTO feature_audit
         (org_id, feature_key, actor_id, actor_type, scope_type, scope_id, scope_role,
          event, before, after, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11)`,
      [
        orgId,
        FEATURE,
        actorUserId(actor),
        actor.type,
        entry.scopeType,
        entry.scopeId ?? null,
        entry.scopeRole ?? null,
        entry.event,
        entry.before === null || entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === null || entry.after === undefined ? null : JSON.stringify(entry.after),
        entry.reason,
      ],
    );
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
       VALUES ($1, $2, $3, $4, 'feature', $5, $6::jsonb)`,
      [
        orgId,
        actor.type,
        actor.id,
        `feature_gate.${entry.event}`,
        FEATURE,
        JSON.stringify({ scopeType: entry.scopeType, scopeId: entry.scopeId ?? null }),
      ],
    );
  }
}

/**
 * The fallback per-call cost for a backfill estimate, in paise.
 *
 * ~₹0.60, which is the measured order of magnitude for one understanding pass
 * on the fast model plus its share of a repair. Used only when the org has no
 * runs to average over - which is exactly the case a backfill is for, since the
 * feature was off - so it is load-bearing for the number an owner is shown.
 * Stated as a constant with this comment rather than buried in the query, and
 * shown to the owner as part of the preview so they can judge it.
 */
const DEFAULT_COST_PER_CALL_MINOR = 60;

/** The narrow surface these helpers need - see `org-features.ts` for the shape. */
interface QueryClient {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}
