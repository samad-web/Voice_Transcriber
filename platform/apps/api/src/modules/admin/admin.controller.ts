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
import { z } from "zod";
import { PIPELINE_QUEUE, queueDepth } from "@aura/queue";
import { OrgModule, WhatsAppProvider } from "@aura/shared";
import {
  provisionTenant,
  seedBoardDefaults,
  seedCrmDefaults,
  seedRoleDefaults,
} from "./provisioning";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrossTenant, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { auditActor } from "../../common/audit-actor";


/**
 * Each pipeline stage as the state machine expresses it: the status a call sits
 * in while the stage runs, and the terminal status it lands on when that stage
 * throws. Derived from the CHECK constraint in migration 0001 - keep in step
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
  /** Customer company name - this is what the web calls an "instance". */
  name: z.string().min(1).max(160),
  workspaceName: z.string().min(1).max(120).default("Default"),
  consentPolicy: z.enum(["none", "tone", "tone_and_tts", "prohibited"]).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  region: z.string().min(1).max(40).optional(),
  tokenTtlMinutes: z.number().int().min(5).max(1440).default(15),
  tokenMaxUses: z.number().int().min(1).max(500).default(1),
  /**
   * CRM must never be automatic - off by default. 'aura' is always included
   * (every tenant created here gets an instance/workspace/devices); this
   * flag decides whether 'crm' joins it. See org-modules.ts.
   */
  enableCrm: z.boolean().default(false),
  /**
   * The full module set, when the caller wants more than the enableCrm
   * shorthand can express - `call_intel`, or Wasi, or a combination.
   *
   * `enableCrm` is kept rather than replaced: it is what every existing caller
   * and script sends, and breaking those to gain one field would be a change
   * nobody asked for. When both are present `modules` wins and `enableCrm` is
   * ignored, which is the only ordering that lets a precise caller be precise.
   */
  modules: z.array(OrgModule).min(1).optional(),
  whatsappProvider: WhatsAppProvider.optional(),
});

/**
 * Modules and the WhatsApp provider in one request.
 *
 * FEATURES ARE NOT HERE, and that is the point of migration 0101. A module is
 * the commercial entitlement an operator sells; a feature is the client's own
 * decision inside it, stored per-org in `org_feature_settings` and edited by
 * the client on /owner/features. An operator reaching into that table would be
 * overruling a choice the customer is entitled to make - and the entitlement
 * gate in `org_feature_enabled` already makes a module the harder boundary.
 */
const UpdateProvisioningBody = z
  .object({
    modules: z.array(OrgModule).min(1).optional(),
    whatsappProvider: WhatsAppProvider.optional(),
  })
  .refine(
    (b) => b.modules !== undefined || b.whatsappProvider !== undefined,
    { message: "nothing to update - send modules or whatsappProvider" },
  );

/**
 * PATCH /admin/tenants/:orgId/storage-quota. Whole bytes; null clears it.
 * Capped at 1 PiB, which is a typo guard rather than a policy.
 */
const StorageQuotaBody = z.object({
  quotaBytes: z.number().int().positive().max(1024 ** 5).nullable(),
});

/**
 * Platform-operator (cross-tenant) surface. These endpoints span ALL orgs, so
 * they deliberately use the RLS-bypassing admin pool rather than withOrg - there
 * is no single org context. Guarded by the same dev AdminKeyGuard for now.
 */
@Controller("admin")
@UseGuards(AdminKeyGuard, TenantGuard)
@CrossTenant()
export class AdminController {
  constructor(private readonly db: DbService) {}

  /**
   * Provision a customer: organization (the RLS boundary) + default workspace
   * + first instance + its one-time enrollment key, all atomically. The
   * system roles and permission grid (seedRoleDefaults) are seeded for EVERY
   * tenant - they gate far more than CRM objects, and an org without them
   * 403s everywhere. Only the default deal pipeline (seedCrmDefaults) waits
   * on `enableCrm` being explicitly set - never automatic; see
   * org-modules.ts. Runs on the admin pool because the org does not exist
   * yet, so withOrg has nothing to scope to. The raw key is returned EXACTLY
   * ONCE - only its hash is stored.
   */
  @Post("tenants")
  async createTenant(@Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = CreateTenantBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    const client = await this.db.adminPool().connect();
    try {
      await client.query("BEGIN");

      // The shared path, not a copy of it. Self-serve signup calls the same
      // function - see provisioning.ts for why a second caller is exactly the
      // condition under which an inline body becomes dangerous.
      const { org, workspace, instance, enrollment } = await provisionTenant(
        client,
        {
          name: p.name,
          workspaceName: p.workspaceName,
          modules: p.modules,
          enableCrm: p.enableCrm,
          consentPolicy: p.consentPolicy ?? null,
          retentionDays: p.retentionDays ?? null,
          region: p.region ?? null,
          whatsappProvider: p.whatsappProvider,
          tokenTtlMinutes: p.tokenTtlMinutes,
          tokenMaxUses: p.tokenMaxUses,
        },
        auditActor(req),
      );

      await client.query("COMMIT");

      return {
        tenant: { ...org, workspace, instance },
        enrollment,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * An org's whole provisioning state: modules, the features inside them, and
   * which platform its WhatsApp goes through.
   *
   * Replaces `PATCH tenants/:orgId/modules`. Same path, wider body - the
   * `modules` field is unchanged and a caller sending only that behaves
   * exactly as before, which is what keeps the operator console's existing
   * module toggles working without touching them.
   *
   * ── WHAT EACH FIELD MEANS WHEN OMITTED ────────────────────────────────
   *
   * Omitted is "leave alone", not "clear". All three are independent, and an
   * operator flipping a WhatsApp provider must not silently reset a feature
   * grid they never opened. The one exception is the interaction the body's
   * own refinement documents: changing `modules` reconciles `features` against
   * the new set, because a feature whose module has gone is not a feature any
   * more.
   *
   * ── WHAT IT STILL WILL NOT DELETE ─────────────────────────────────────
   *
   * Nothing. An org with no roles gets its grid repaired inline whatever its
   * modules are (seedRoleDefaults), and a newly-present 'crm' gets its board
   * and pipeline; if 'crm' is being removed, roles and pipelines are left
   * exactly where they are. CrmPermissionsGuard's
   * `enabled_modules` check is what revokes access, not deleting data, so
   * re-enabling later needs no reseed and loses no history. A feature turned
   * off is the same promise one level down: the Invoices page disappears, the
   * invoices do not.
   */
  @Patch("tenants/:orgId/modules")
  async updateProvisioning(
    @Param("orgId", ParseUUIDPipe) orgId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = UpdateProvisioningBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const patch = parsed.data;

    const client = await this.db.adminPool().connect();
    try {
      await client.query("BEGIN");

      // Read first, under FOR UPDATE, because two of the three fields are
      // decided by combining what was sent with what is already there -
      // `features` has to be reconciled against the module set that will be in
      // force after this write, which may be the one in the body or the one in
      // the row. Locking the row makes that read-modify-write safe against a
      // concurrent provisioning change rather than merely unlikely to collide.
      const {
        rows: [current],
      } = await client.query(
        `SELECT enabled_modules, whatsapp_provider
           FROM organizations WHERE id = $1 FOR UPDATE`,
        [orgId],
      );
      if (!current) throw new NotFoundException("tenant not found");

      const modules: OrgModule[] = (patch.modules ?? current.enabled_modules) as OrgModule[];
      const whatsappProvider = patch.whatsappProvider ?? current.whatsapp_provider;

      // Doc 27 §7.4: a module ADDED brings new setup steps with it, so a
      // finished setup guide re-opens to show them. Only on an addition - a
      // removal cannot create work - and never `guide_dismissed_at`: a guide
      // an owner chose to hide stays hidden, whatever the operator sells them.
      const previous = new Set<string>(current.enabled_modules ?? []);
      const moduleAdded = modules.some((m) => !previous.has(m));

      const {
        rows: [org],
      } = await client.query(
        `UPDATE organizations
            SET enabled_modules = $2, whatsapp_provider = $3,
                guide_completed_at = CASE WHEN $4::boolean THEN NULL ELSE guide_completed_at END
          WHERE id = $1
         RETURNING id, enabled_modules, whatsapp_provider`,
        [orgId, modules, whatsappProvider, moduleAdded],
      );

      // Outside the 'crm' branch on purpose: a tenant that never had the CRM
      // still needs its grid, and this is the repair path for the ones that
      // were provisioned before seedRoleDefaults was split out of
      // seedCrmDefaults. Guarded on the row count, so it never double-inserts.
      const { rows: existingRoles } = await client.query(
        `SELECT 1 FROM roles WHERE org_id = $1 LIMIT 1`,
        [orgId],
      );
      if (existingRoles.length === 0) await seedRoleDefaults(client, orgId);

      if (modules.includes("crm")) {
        // Unconditional and safe: seed_default_board returns the existing
        // board untouched. It is here as well as in createTenant so a tenant
        // provisioned before migration 0075 - or one whose board was archived
        // - is repaired the moment someone touches its modules, rather than
        // staying the one org in the fleet with no board.
        await seedBoardDefaults(client, orgId);
        await seedCrmDefaults(client, orgId);
      }

      await client.query(
        // `target_id` repeats orgId as its OWN parameter ($3), not a second
        // reference to $1 - org_id is uuid and target_id is text, and reusing
        // one placeholder for both types fails Postgres's parameter-type
        // inference ("inconsistent types deduced for parameter $1", 42P08).
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, $5, $2, 'tenant.modules_update', 'organization', $3, $4)`,
        [
          orgId,
          auditActor(req).id,
          orgId,
          // The RESOLVED state, not the patch. An entry reading
          // `{"whatsappProvider":"wasi"}` tells a reader what one person
          // touched; one reading the whole pair tells them what the tenant
          // then had - which is the question anybody reading an audit log six
          // months later is actually asking.
          JSON.stringify({ modules, whatsappProvider }),
          auditActor(req).type,
        ],
      );

      await client.query("COMMIT");
      return {
        orgId: org.id,
        enabledModules: org.enabled_modules,
        whatsappProvider: org.whatsapp_provider,
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
      `SELECT o.id, o.name, o.status, o.consent_policy, o.retention_days, o.region,
              o.enabled_modules, o.whatsapp_provider, o.created_at,
              (SELECT count(*)::int FROM calls c     WHERE c.org_id = o.id) AS call_count,
              -- Live handsets only (0087) - matches devices.controller's LIVE
              -- filter, so this list's count never disagrees with the fleet
              -- table an operator lands on after clicking through.
              (SELECT count(*)::int FROM devices d
                WHERE d.org_id = o.id AND d.removed_at IS NULL) AS device_count,
              (SELECT count(*)::int FROM instances i WHERE i.org_id = o.id) AS instance_count,
              -- Doc 27 §6.4: storage per tenant, from the worker's hourly
              -- snapshot (0128) - a join, not a sum over recordings, so this
              -- list stays one cheap query however much audio the fleet holds.
              -- Text for the bigints, which exceed a JS number's exact range
              -- only in theory but arrive as strings from pg regardless.
              s.recording_bytes::text AS storage_bytes,
              s.recording_count       AS storage_recordings,
              s.computed_at           AS storage_computed_at,
              o.storage_quota_bytes::text AS storage_quota_bytes
         FROM organizations o
         LEFT JOIN org_storage_usage s ON s.org_id = o.id
        ORDER BY o.created_at DESC`,
    );
    return { tenants: rows };
  }

  /**
   * Set or clear a tenant's storage quota (doc 27 §6.4). Bytes, 1024-based -
   * the console's GB field converts with the same factor the meter uses.
   *
   * Separate from the modules PATCH on purpose: that route reconciles features
   * against modules in one transaction, and a quota has nothing to do with
   * either. A quota is display-and-warn only; nothing refuses an upload for
   * crossing it.
   *
   * Clearing or raising it also clears `last_quota_alert_pct`, so an owner
   * whose limit was raised is told again if they climb back past 80 %.
   */
  @Patch("tenants/:orgId/storage-quota")
  async setStorageQuota(
    @Param("orgId", ParseUUIDPipe) orgId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = StorageQuotaBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const quotaBytes = parsed.data.quotaBytes;

    const client = await this.db.adminPool().connect();
    try {
      await client.query("BEGIN");
      const {
        rows: [org],
      } = await client.query<{ id: string; storage_quota_bytes: string | null }>(
        `UPDATE organizations SET storage_quota_bytes = $2 WHERE id = $1
         RETURNING id, storage_quota_bytes::text`,
        [orgId, quotaBytes],
      );
      if (!org) throw new NotFoundException("tenant not found");
      await client.query(
        `UPDATE org_storage_usage SET last_quota_alert_pct = NULL WHERE org_id = $1`,
        [orgId],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, $5, $2, 'org.storage_quota_set', 'organization', $3, $4::jsonb)`,
        [orgId, req.principal?.operatorEmail ?? auditActor(req).id, orgId, JSON.stringify({ quotaBytes }), auditActor(req).type],
      );
      await client.query("COMMIT");
      return { orgId, quotaBytes: org.storage_quota_bytes === null ? null : Number(org.storage_quota_bytes) };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Pipeline health across every tenant.
   *
   * Each stage is judged on what the state machine actually holds right now:
   * how many calls sit in that stage, how many failed there, and whether
   * anything has been stuck in it beyond `STUCK_AFTER`. A stage with failures
   * is `degraded`; one holding a call longer than a pipeline run could
   * plausibly take is `stalled` - that is the signal worth paging on, because
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
      // Not folded into `stages`: STUCK_AFTER_MS (10 min) is calibrated to a
      // pipeline run, not to a handset's upload, which can legitimately take
      // far longer to retry over a bad connection - see
      // PIPELINE_AWAITING_AUDIO_STALL_MS (6h) in the worker's retry.ts, which
      // is what actually moves a call from AWAITING_AUDIO to FAILED_UPLOAD.
      failedUpload: countOf("FAILED_UPLOAD"),
      stuckAfterSeconds: STUCK_AFTER_MS / 1000,
    };
  }
}
