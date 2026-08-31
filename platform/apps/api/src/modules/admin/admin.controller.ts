import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { PIPELINE_QUEUE, queueDepth } from "@aura/queue";
import { DEFAULT_PIPELINE_STAGES, OrgModule, PermissionObjectType } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrossTenant, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/** The 5 system roles seeded for every org — mirrors migration 0039's own seed. */
const SYSTEM_ROLES = [
  { key: "platform_admin", name: "Platform Admin" },
  { key: "org_admin", name: "Org Admin" },
  { key: "workspace_admin", name: "Workspace Admin" },
  { key: "workspace_member", name: "Workspace Member" },
  { key: "viewer", name: "Viewer" },
] as const;

/**
 * Give an org the same CRM defaults migrations 0034/0039/0041/0055/0059/0060
 * one-time-backfilled for orgs that already existed when each of them ran:
 * the 5 system roles with a full permission grid across every
 * `PermissionObjectType`, and a default deal pipeline. Called only when the
 * 'crm' module is being turned on for an org (createTenant's `enableCrm`
 * flag, or `PATCH tenants/:orgId/modules`) — never unconditionally. Without
 * it, an org with 'crm' enabled but never seeded would get:
 *  - zero CRM projection from calls (apps/worker/src/pipeline/pipeline.ts's
 *    "no default pipeline for org" — deals.controller.ts's resolvePipeline()
 *    throws the same way on an explicit create), and
 *  - a 403 on every contact/account/deal/... route for every real user,
 *    because CrmPermissionsGuard's `roles` join has nothing to match (a bare
 *    admin key with no asserted user is the only caller that still gets
 *    through — see crm-permissions.guard.ts).
 *
 * Object types are read from the shared `PermissionObjectType` enum rather
 * than hardcoded, so a future object type that widens that enum is seeded
 * here automatically instead of needing another one-time migration backfill.
 *
 * Idempotent by convention, not by construction: callers only invoke this
 * when `roles` has zero rows for the org (checked by the caller), so
 * flipping 'crm' off then on again never double-inserts.
 */
async function seedCrmDefaults(client: PoolClient, orgId: string): Promise<void> {
  await client.query(
    `INSERT INTO roles (org_id, key, name, is_system)
     SELECT $1, v.key, v.name, true
       FROM (VALUES ${SYSTEM_ROLES.map((_, i) => `($${i * 2 + 2}, $${i * 2 + 3})`).join(", ")})
         AS v(key, name)`,
    [orgId, ...SYSTEM_ROLES.flatMap((r) => [r.key, r.name])],
  );

  await client.query(
    `INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
     SELECT r.org_id, r.id, ot.object_type, a.action, 'all'
       FROM roles r
       CROSS JOIN unnest($2::text[]) AS ot(object_type)
       CROSS JOIN (VALUES ('view'), ('create'), ('edit'), ('delete'), ('export')) AS a(action)
      WHERE r.org_id = $1
        AND r.is_system
        AND (
          r.key IN ('platform_admin', 'org_admin', 'workspace_admin')
          OR (r.key = 'workspace_member' AND a.action IN ('view', 'create', 'edit'))
          OR (r.key = 'viewer' AND a.action = 'view')
        )`,
    [orgId, PermissionObjectType.options],
  );

  // FIND-or-create, not a bare INSERT.
  //
  // seedBoardDefaults (below) runs on every provisioning path and already
  // find-or-creates the org's default pipeline, because boards.pipeline_id is
  // NOT NULL. An unguarded INSERT here would therefore add a SECOND pipeline
  // with is_default = true — and "exactly one default per org" is only
  // app-enforced (0034 says so), so nothing in the database would stop it. The
  // same collision is reachable without boards at all: migration 0075 seeds a
  // pipeline for every org, so enabling 'crm' on a tenant created before this
  // change would double up too.
  //
  // One pipeline, shared by the board and the CRM, is also the correct
  // outcome: the board's deal_stage_key bridge points at that pipeline's
  // stages, and a second competing default is exactly the split B2's bug is.
  await client.query(
    `INSERT INTO deal_pipelines (org_id, name, stages, is_default)
     SELECT $1, 'Sales Pipeline', $2::jsonb, true
      WHERE NOT EXISTS (
        SELECT 1 FROM deal_pipelines p WHERE p.org_id = $1 AND p.status = 'active')`,
    [orgId, JSON.stringify(DEFAULT_PIPELINE_STAGES)],
  );
}

/**
 * Give an org the editable board every other org has (migration 0075).
 *
 * Delegates to the `seed_default_board(uuid)` SQL function rather than
 * reimplementing it here, and that is deliberate: 0075's own backfill calls
 * the SAME function for the orgs that already existed, so a CRM provisioned
 * from the admin dashboard today is structurally identical to one that
 * predates the migration. A TypeScript copy of that SQL would drift the first
 * time either side was edited, and the failure mode is a tenant whose board
 * quietly differs from every other tenant's — invisible until someone tries to
 * reshape it.
 *
 * Idempotent by CONSTRUCTION, not by convention (unlike seedCrmDefaults): the
 * function returns the existing default board untouched if there is one, so
 * every caller may invoke it unconditionally.
 *
 * Runs for EVERY tenant, not only CRM ones. `/owner/board` is the leads board
 * and every org has leads; `enabled_modules` is what gates CRM access, not the
 * presence of seeded rows — the same reasoning updateModules already applies
 * when it declines to delete anything on module removal.
 */
async function seedBoardDefaults(client: PoolClient, orgId: string): Promise<void> {
  await client.query(`SELECT seed_default_board($1)`, [orgId]);
}

/**
 * Each pipeline stage as the state machine expresses it: the status a call sits
 * in while the stage runs, and the terminal status it lands on when that stage
 * throws. Derived from the CHECK constraint in migration 0001 — keep in step
 * with it.
 */
const PIPELINE_STAGES = [
  { name: "transcode", active: "TRANSCODING", failed: "FAILED_TRANSCODE" },
  { name: "transcribe", active: "TRANSCRIBING", failed: "FAILED_ASR" },
  { name: "analyze", active: "ANALYZING", failed: "FAILED_ANALYZE" },
  { name: "crm_sync", active: "SYNCING", failed: "FAILED_CRM" },
] as const;

/**
 * How long a call may sit in one stage before the stage is called stalled.
 * A pipeline run is seconds-to-a-minute even on a long recording, so ten
 * minutes is far outside normal and means the worker died holding the call
 * rather than that it is busy.
 */
const STUCK_AFTER_MS = 10 * 60 * 1000;

const CreateTenantBody = z.object({
  /** Customer company name — this is what the web calls an "instance". */
  name: z.string().min(1).max(160),
  workspaceName: z.string().min(1).max(120).default("Default"),
  consentPolicy: z.enum(["none", "tone", "tone_and_tts", "prohibited"]).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  region: z.string().min(1).max(40).optional(),
  tokenTtlMinutes: z.number().int().min(5).max(1440).default(15),
  tokenMaxUses: z.number().int().min(1).max(500).default(1),
  /**
   * CRM must never be automatic — off by default. 'aura' is always included
   * (every tenant created here gets an instance/workspace/devices); this
   * flag decides whether 'crm' joins it. See org-modules.ts.
   */
  enableCrm: z.boolean().default(false),
});

const UpdateModulesBody = z.object({
  modules: z.array(OrgModule).min(1),
});

/**
 * Platform-operator (cross-tenant) surface. These endpoints span ALL orgs, so
 * they deliberately use the RLS-bypassing admin pool rather than withOrg — there
 * is no single org context. Guarded by the same dev AdminKeyGuard for now.
 */
@Controller("admin")
@UseGuards(AdminKeyGuard, TenantGuard)
@CrossTenant()
export class AdminController {
  constructor(private readonly db: DbService) {}

  /**
   * Provision a customer: organization (the RLS boundary) + default workspace
   * + first instance + its one-time enrollment key, all atomically. CRM
   * (system roles/grants + a default deal pipeline, via seedCrmDefaults) is
   * seeded only when `enableCrm` is explicitly set — never automatic; see
   * org-modules.ts. Runs on the admin pool because the org does not exist
   * yet, so withOrg has nothing to scope to. The raw key is returned EXACTLY
   * ONCE — only its hash is stored.
   */
  @Post("tenants")
  async createTenant(@Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = CreateTenantBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const modules: OrgModule[] = p.enableCrm ? ["aura", "crm"] : ["aura"];

    const client = await this.db.adminPool().connect();
    try {
      await client.query("BEGIN");

      const {
        rows: [org],
      } = await client.query(
        `INSERT INTO organizations (name, consent_policy, retention_days, region, enabled_modules)
         VALUES ($1,
                 COALESCE($2, 'tone'),
                 COALESCE($3, 90),
                 COALESCE($4, 'ap-south-1'),
                 $5)
         RETURNING id, name, status, consent_policy, retention_days, region, enabled_modules, created_at`,
        [p.name, p.consentPolicy ?? null, p.retentionDays ?? null, p.region ?? null, modules],
      );

      // Board first: it find-or-creates the org's one default pipeline, which
      // seedCrmDefaults then reuses rather than competing with.
      await seedBoardDefaults(client, org.id);
      if (modules.includes("crm")) await seedCrmDefaults(client, org.id);

      const {
        rows: [workspace],
      } = await client.query(
        `INSERT INTO workspaces (org_id, name) VALUES ($1, $2) RETURNING id, name`,
        [org.id, p.workspaceName],
      );

      const {
        rows: [instance],
      } = await client.query(
        `INSERT INTO instances (org_id, workspace_id, name)
         VALUES ($1, $2, $3)
         RETURNING id, name, config_version, created_at`,
        [org.id, workspace.id, p.name],
      );

      const {
        rows: [token],
      } = await client.query(
        `INSERT INTO enrollment_tokens (org_id, instance_id, token_hash, expires_at, max_uses)
         VALUES ($1, $2, $3, now() + make_interval(mins => $4), $5)
         RETURNING id, expires_at, max_uses`,
        [org.id, instance.id, tokenHash, p.tokenTtlMinutes, p.tokenMaxUses],
      );

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'tenant.create', 'organization', $3)`,
        [org.id, req.principal?.userId ?? "dev-admin", org.id],
      );

      await client.query("COMMIT");

      return {
        tenant: { ...org, workspace, instance },
        enrollment: {
          orgId: org.id,
          instanceId: instance.id,
          // Shown once, never retrievable again — only the hash is stored.
          adminKey: rawToken,
          expiresAt: token.expires_at,
          maxUses: token.max_uses,
        },
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Replace an org's module entitlement wholesale — the lever both "enable
   * CRM for an existing client" and, later, "a plan upgrade" use (a plan
   * assignment will just call this with the plan's module set). If 'crm' is
   * newly present and the org has never been seeded, seedCrmDefaults runs
   * inline; if 'crm' is being removed, existing roles/pipeline rows are left
   * alone — CrmPermissionsGuard's `enabled_modules` check is what actually
   * revokes access, not deleting data, so re-enabling later needs no reseed.
   */
  @Patch("tenants/:orgId/modules")
  async updateModules(
    @Param("orgId", ParseUUIDPipe) orgId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = UpdateModulesBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { modules } = parsed.data;

    const client = await this.db.adminPool().connect();
    try {
      await client.query("BEGIN");

      const {
        rows: [org],
      } = await client.query(
        `UPDATE organizations SET enabled_modules = $2 WHERE id = $1
         RETURNING id, enabled_modules`,
        [orgId, modules],
      );
      if (!org) throw new NotFoundException("tenant not found");

      if (modules.includes("crm")) {
        // Unconditional and safe: seed_default_board returns the existing
        // board untouched. It is here as well as in createTenant so a tenant
        // provisioned before migration 0075 — or one whose board was archived
        // — is repaired the moment someone touches its modules, rather than
        // staying the one org in the fleet with no board.
        await seedBoardDefaults(client, orgId);

        const { rows: existingRoles } = await client.query(
          `SELECT 1 FROM roles WHERE org_id = $1 LIMIT 1`,
          [orgId],
        );
        if (existingRoles.length === 0) await seedCrmDefaults(client, orgId);
      }

      await client.query(
        // `target_id` repeats orgId as its OWN parameter ($3), not a second
        // reference to $1 — org_id is uuid and target_id is text, and reusing
        // one placeholder for both types fails Postgres's parameter-type
        // inference ("inconsistent types deduced for parameter $1", 42P08).
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, 'tenant.modules_update', 'organization', $3, $4)`,
        [orgId, req.principal?.userId ?? "dev-admin", orgId, JSON.stringify({ modules })],
      );

      await client.query("COMMIT");
      return { orgId: org.id, enabledModules: org.enabled_modules };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  @Get("tenants")
  async tenants() {
    const admin = this.db.adminPool();
    const { rows } = await admin.query(
      `SELECT o.id, o.name, o.status, o.consent_policy, o.retention_days, o.region,
              o.enabled_modules, o.created_at,
              (SELECT count(*)::int FROM calls c     WHERE c.org_id = o.id) AS call_count,
              (SELECT count(*)::int FROM devices d   WHERE d.org_id = o.id) AS device_count,
              (SELECT count(*)::int FROM instances i WHERE i.org_id = o.id) AS instance_count
         FROM organizations o
        ORDER BY o.created_at DESC`,
    );
    return { tenants: rows };
  }

  /**
   * Pipeline health across every tenant.
   *
   * Each stage is judged on what the state machine actually holds right now:
   * how many calls sit in that stage, how many failed there, and whether
   * anything has been stuck in it beyond `STUCK_AFTER`. A stage with failures
   * is `degraded`; one holding a call longer than a pipeline run could
   * plausibly take is `stalled` — that is the signal worth paging on, because
   * it means the worker died mid-call rather than merely erroring.
   */
  @Get("health")
  async health() {
    const admin = this.db.adminPool();

    const { rows: live } = await admin.query(
      `SELECT status,
              count(*)::int AS n,
              min(updated_at) AS oldest
         FROM calls
        GROUP BY status`,
    );
    const by = new Map(live.map((r) => [r.status as string, r]));
    const countOf = (status: string) => Number(by.get(status)?.n ?? 0);
    const oldestOf = (status: string) => by.get(status)?.oldest as Date | undefined;

    const now = Date.now();
    const stuck = (status: string) => {
      const oldest = oldestOf(status);
      return oldest ? now - new Date(oldest).getTime() > STUCK_AFTER_MS : false;
    };

    const stages = PIPELINE_STAGES.map(({ name, active, failed }) => {
      const inFlight = countOf(active);
      const failures = countOf(failed);
      const stalled = stuck(active);
      return {
        name,
        status: stalled ? "stalled" : failures > 0 ? "degraded" : "ok",
        inFlight,
        failed: failures,
        oldestInFlight: oldestOf(active) ?? null,
      };
    });

    const depth = await queueDepth();

    return {
      stages,
      queue: { name: PIPELINE_QUEUE, depth, reachable: depth !== null },
      awaitingAudio: countOf("AWAITING_AUDIO"),
      stuckAfterSeconds: STUCK_AFTER_MS / 1000,
    };
  }
}
