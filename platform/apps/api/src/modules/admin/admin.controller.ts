import { BadRequestException, Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { PIPELINE_QUEUE, queueDepth } from "@aura/queue";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { CrossTenant, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

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
   * Provision a customer: organization (the RLS boundary) + default workspace +
   * first instance + its one-time enrollment key, atomically. Runs on the admin
   * pool because the org does not exist yet, so withOrg has nothing to scope to.
   * The raw key is returned EXACTLY ONCE — only its hash is stored.
   */
  @Post("tenants")
  async createTenant(@Body() body: unknown) {
    const parsed = CreateTenantBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");

    const client = await this.db.adminPool().connect();
    try {
      await client.query("BEGIN");

      const {
        rows: [org],
      } = await client.query(
        `INSERT INTO organizations (name, consent_policy, retention_days, region)
         VALUES ($1,
                 COALESCE($2, 'tone'),
                 COALESCE($3, 90),
                 COALESCE($4, 'ap-south-1'))
         RETURNING id, name, status, consent_policy, retention_days, region, created_at`,
        [p.name, p.consentPolicy ?? null, p.retentionDays ?? null, p.region ?? null],
      );

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
         VALUES ($1, 'user', 'dev-admin', 'tenant.create', 'organization', $2)`,
        [org.id, org.id],
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

  @Get("tenants")
  async tenants() {
    const admin = this.db.adminPool();
    const { rows } = await admin.query(
      `SELECT o.id, o.name, o.status, o.consent_policy, o.retention_days, o.region, o.created_at,
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
