import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { ASR_LANGUAGES, ASR_MODES, Branding } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { hashAppLockPassword } from "../../common/app-lock-hash";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgRoleGuard, RequireOrgRole } from "../../common/org-role.guard";
import { OperatorMayCall, OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { S3Service } from "../../s3/s3.service";
import { auditActor } from "../../common/audit-actor";

/**
 * What a branding image is allowed to be, for the presigned-upload endpoint
 * below. The extension drives the stored object's key, which is why this is a
 * map rather than a plain enum - `image/x-icon` and
 * `image/vnd.microsoft.icon` are both "a .ico file" as far as a browser's
 * file picker is concerned, and both need to land on the same extension.
 */
const BRANDING_CONTENT_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

const BrandingUploadBody = z.object({
  kind: z.enum(["logo", "favicon", "banner", "sidebarIcon", "loginBackground"]),
  contentType: z.enum(
    Object.keys(BRANDING_CONTENT_TYPES) as [string, ...string[]],
  ),
});

/**
 * Per-tenant logo/colors (Kailash gap Milestone 4). One jsonb column
 * (migration 0065), same "tenant config as jsonb on organizations" precedent
 * as lead_stages/lead_rules - this is too small to earn its own table.
 *
 * The shape is `@aura/shared`'s `Branding` rather than a Zod object written out
 * here. It used to be declared three times by hand - here, and again as
 * `BrandingView` and `BrandingPatch` in the console - which is exactly the
 * drift the shared package exists to stop. The console now renders its form
 * from the same definition this endpoint validates against - see branding.ts
 * for what each field is and why `loginBackgroundUrl` round-trips without
 * being rendered anywhere yet.
 */
const BrandingBody = Branding;

const PolicyBody = z.object({
  consentPolicy: z.enum(["none", "tone", "tone_and_tts", "prohibited"]).optional(),
  onConsentFailure: z.enum(["record_and_flag", "do_not_record"]).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  /**
   * Opt in to retaining the counterparty's full number (0011). Off by default:
   * without it the platform keeps only a prefix, the last 3 digits and a hash,
   * which is enough to label and dedup a call but not to ring anyone back. Turn
   * it on for a tenant whose CRM hand-off has to produce callable leads.
   */
  storeFullNumber: z.boolean().optional(),
  /**
   * Off keeps ingesting this instance's calls but skips ASR and analysis (0014).
   * Distinct from suspending the org, which refuses the upload entirely.
   */
  transcriptionEnabled: z.boolean().optional(),
  /**
   * Read inbound WhatsApp threads and propose leads from them (0080).
   *
   * OFF by default and deliberately a tenant decision, not a deployment one:
   * turning it on sends this tenant's own customer conversations to an LLM
   * provider. It lives beside transcriptionEnabled because it is the same kind
   * of switch - "may this platform read our customers' words" - and belongs
   * wherever a tenant already goes to answer that question.
   *
   * Turning it OFF stops the sweep for this org on its next tick. It does not
   * delete verdicts already written; qualificationRetentionDays ages those out,
   * and a tenant who wants them gone sooner sets that lower.
   */
  whatsappQualificationEnabled: z.boolean().optional(),
  /** How long a decided qualification verdict is kept (0082). Default 90 days. */
  qualificationRetentionDays: z.number().int().min(1).max(3650).optional(),
  /**
   * What this instance's agents actually speak (0016). Auto-detect is only
   * right when we genuinely don't know - it has mislabelled a Tamil call as
   * Spanish, losing the whole transcript. `unknown` forces auto-detect back on.
   */
  asrLanguage: z.enum(ASR_LANGUAGES).nullable().optional(),
  /**
   * Saaras output format. `codemix` is the one that keeps an English brand name
   * out of Indic script - "RD Interlock" instead of "ஆர்டி இன்டர்லாக்".
   */
  asrMode: z.enum(ASR_MODES).nullable().optional(),
  /**
   * Proper nouns and domain terms in their correct spelling. Handed to the
   * analyse stages, not to ASR - the batch speech API takes no hotword list.
   */
  vocabulary: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
  /**
   * The mobile app-lock password (raw, over HTTPS - hashed below before it
   * ever touches the database). `null` clears the lock for every device
   * under this org; omitted leaves whatever is set untouched.
   */
  appLockPassword: z.string().min(4).max(72).nullable().optional(),
});

/**
 * The `PolicyBody` fields a tenant's own console may set - the three the
 * Transcription page edits. Everything else in `PolicyBody` (consent regime,
 * retention, full-number storage, transcription on/off, WhatsApp
 * qualification and its retention, the app-lock password) is set by the
 * platform operator today, and no owner-console page sends it. A new console
 * page that needs one of them adds it here, deliberately.
 */
const CONSOLE_POLICY_FIELDS: ReadonlySet<string> = new Set(["asrLanguage", "asrMode", "vocabulary"]);

/**
 * A real person the owner console proxies for (admin key + `x-caller-user-id`),
 * or a Bearer session - as opposed to the bare admin key, whose principal is
 * the literal "admin-key" and has no person behind it.
 */
function isConsolePerson(req: PrincipalRequest): boolean {
  return z.string().uuid().safeParse(req.principal?.userId).success;
}

/** Org-level compliance policy (§2.6): consent regime + retention window. */
@Controller("org")
@UseGuards(AdminKeyGuard, TenantGuard)
export class TenancyController {
  constructor(
    private readonly db: DbService,
    private readonly s3: S3Service,
  ) {}

  @Get()
  async get(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [org],
      } = await client.query(
        `SELECT id, name, status, consent_policy, on_consent_failure, retention_days, region,
                store_full_number, transcription_enabled, asr_language, asr_mode, vocabulary, branding,
                enabled_modules, whatsapp_qualification_enabled, qualification_retention_days,
                (app_lock_password_hash IS NOT NULL) AS app_lock_enabled,
                -- Doc 27 §6.4: the operator's instance page shows a Storage
                -- vital. The worker's hourly snapshot (0128), one row; null
                -- until its first sweep.
                storage_quota_bytes::text AS storage_quota_bytes,
                (SELECT jsonb_build_object(
                          'recordingBytes', s.recording_bytes::text,
                          'recordingCount', s.recording_count,
                          'dbBytesEstimate', s.db_bytes_estimate::text,
                          'computedAt', s.computed_at)
                   FROM org_storage_usage s WHERE s.org_id = organizations.id) AS storage_usage
           FROM organizations WHERE id = $1`,
        [orgId],
      );
      return org;
    });
  }

  /**
   * Doc 27 §4.4's fix. `@RequireOrgRole("org_admin")` alone was inert for the
   * owner console: the admin key makes every console request `platform_admin`,
   * which OrgRoleGuard waves through (org-role.guard.ts), so any persona's
   * server action could repaint the workspace. OwnerRoleGuard reads the
   * persona from `memberships` and cannot be talked past; the three personas
   * are the ones the nav offers the Branding page to.
   */
  @Patch("branding")
  @UseGuards(OrgRoleGuard, OwnerRoleGuard)
  @RequireOrgRole("org_admin")
  @RequireOwnerRole("owner", "manager", "marketing")
  async updateBranding(
    @OrgId() orgId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = BrandingBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    if (Object.keys(p).length === 0) throw new BadRequestException("nothing to update");

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [org],
      } = await client.query(
        // Merged into the existing jsonb rather than replaced, so patching
        // just the primary color doesn't blank a logo set earlier.
        `UPDATE organizations SET branding = branding || $2::jsonb WHERE id = $1
         RETURNING branding`,
        [orgId, JSON.stringify(p)],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, $5, $2, 'org.branding_update', 'organization', $3, $4::jsonb)`,
        [orgId, auditActor(req).id, orgId, JSON.stringify(p), auditActor(req).type],
      );
      return org;
    });
  }

  /**
   * A presigned PUT for one branding image, mirroring `S3Service`'s existing
   * device-upload pattern (calls.controller.ts) rather than accepting the file
   * body here: the bytes go straight from the browser to S3, never through this
   * process. Same guards as the PATCH above - only a persona that may change
   * branding may mint one of these.
   *
   * The key is `org/<orgId>/branding/<kind>-<uuid>.<ext>` - the uuid is what
   * makes the resulting URL safe to cache forever (a re-upload gets a new
   * name, it never overwrites the old object in place) and what
   * `branding-assets.controller.ts` trusts when it later serves the object
   * back with no auth of its own: guessing a filename gets you nothing but
   * another tenant's PUBLIC logo, which was never a secret.
   *
   * Returns a path, not a full URL - the browser reaches this asset through
   * the WEB app's own `/branding-assets/...` route (a same-origin proxy to
   * `branding-assets.controller.ts`), not this API directly, because nothing
   * else in this console is ever loaded straight off `API_URL` from a browser.
   */
  @Post("branding/upload-url")
  @UseGuards(OrgRoleGuard, OwnerRoleGuard)
  @RequireOrgRole("org_admin")
  @RequireOwnerRole("owner", "manager", "marketing")
  async brandingUploadUrl(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = BrandingUploadBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { kind, contentType } = parsed.data;
    const ext = BRANDING_CONTENT_TYPES[contentType];
    const filename = `${kind}-${randomUUID()}.${ext}`;
    const key = `org/${orgId}/branding/${filename}`;
    const uploadUrl = await this.s3.presignedPutUrl(key, contentType);
    return { uploadUrl, assetPath: `/branding-assets/${orgId}/${filename}` };
  }

  /**
   * Doc 31 §2 X8 - the same hole doc 27 §4.4 closed for branding, still open
   * here. `@RequireOrgRole("org_admin")` is inert for every console request
   * (all arrive as `platform_admin`), so the owner console's transcription
   * page was the only thing refusing a telecaller - in its server action, not
   * here. And the body carries fields that are the PROVIDER's to set.
   *
   * Now two gates, both enforced by the API:
   *  - who: a person the console proxies for must be owner or manager, read
   *    from memberships. The operator console and ops tooling send no person
   *    (the bare admin key), which `@OperatorMayCall` lets through as before.
   *  - what: a person may send only the transcription fields; consent,
   *    retention, full-number storage, transcription on/off and the app-lock
   *    password stay operator-only (see CONSOLE_POLICY_FIELDS below).
   */
  @Patch("policy")
  @UseGuards(OrgRoleGuard, OwnerRoleGuard)
  @RequireOrgRole("org_admin")
  @OperatorMayCall()
  @RequireOwnerRole("owner", "manager")
  async updatePolicy(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = PolicyBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    if (isConsolePerson(req)) {
      const refused = Object.keys(p).filter(
        (k) => p[k as keyof typeof p] !== undefined && !CONSOLE_POLICY_FIELDS.has(k),
      );
      if (refused.length > 0) {
        throw new ForbiddenException(
          `only the platform operator can change: ${refused.sort().join(", ")}`,
        );
      }
    }

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [org],
      } = await client.query(
        // asr_language and asr_mode use CASE, not COALESCE: NULL is a MEANINGFUL
        // value for them ("follow the deployment default"), so COALESCE would
        // make clearing a setting impossible - the write would silently keep
        // the old one. The boolean says whether the field was sent at all.
        `UPDATE organizations SET
           consent_policy = COALESCE($2, consent_policy),
           on_consent_failure = COALESCE($3, on_consent_failure),
           retention_days = COALESCE($4, retention_days),
           store_full_number = COALESCE($5, store_full_number),
           transcription_enabled = COALESCE($6, transcription_enabled),
           whatsapp_qualification_enabled = COALESCE($14, whatsapp_qualification_enabled),
           qualification_retention_days = COALESCE($15, qualification_retention_days),
           asr_language = CASE WHEN $7::boolean THEN $8::text ELSE asr_language END,
           asr_mode = CASE WHEN $9::boolean THEN $10::text ELSE asr_mode END,
           vocabulary = COALESCE($11::text[], vocabulary),
           app_lock_password_hash = CASE WHEN $12::boolean THEN $13::text ELSE app_lock_password_hash END
         WHERE id = $1
         RETURNING consent_policy, on_consent_failure, retention_days, store_full_number,
                   transcription_enabled, asr_language, asr_mode, vocabulary,
                   whatsapp_qualification_enabled, qualification_retention_days,
                   (app_lock_password_hash IS NOT NULL) AS app_lock_enabled`,
        [
          orgId,
          p.consentPolicy ?? null,
          p.onConsentFailure ?? null,
          p.retentionDays ?? null,
          p.storeFullNumber ?? null,
          p.transcriptionEnabled ?? null,
          p.asrLanguage !== undefined,
          p.asrLanguage ?? null,
          p.asrMode !== undefined,
          p.asrMode ?? null,
          p.vocabulary ?? null,
          p.appLockPassword !== undefined,
          p.appLockPassword ? hashAppLockPassword(p.appLockPassword) : null,
          p.whatsappQualificationEnabled ?? null,
          p.qualificationRetentionDays ?? null,
        ],
      );
      // Policy changes must reach devices: bump every instance's config version.
      await client.query(
        "UPDATE instances SET config_version = config_version + 1 WHERE org_id = $1",
        [orgId],
      );
      // Never let the raw app-lock password reach the audit log - record only
      // that it changed, the same way a "set" is visible without the value.
      const auditMeta =
        p.appLockPassword !== undefined
          ? { ...p, appLockPassword: p.appLockPassword ? "(set)" : "(cleared)" }
          : p;
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, $5, $2, 'org.policy_update', 'organization', $3, $4::jsonb)`,
        [orgId, auditActor(req).id, orgId, JSON.stringify(auditMeta), auditActor(req).type],
      );
      return org;
    });
  }

  /**
   * Immutable audit ledger (§2.6). Read by the operator console's instance
   * page on the bare admin key.
   *
   * Doc 31 §2 X9: this had no gate beyond tenant membership, so any console
   * person whose request reached it could read who did what across the whole
   * org - role changes, exports, recording playback. A person must be the
   * OWNER; the operator console keeps its access through `@OperatorMayCall`.
   */
  @Get("audit")
  @UseGuards(OwnerRoleGuard)
  @OperatorMayCall()
  @RequireOwnerRole("owner")
  async audit(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, actor_type, actor_id, action, target_type, target_id, ip, meta, created_at
           FROM audit_log ORDER BY created_at DESC LIMIT 200`,
      );
      return { entries: rows };
    });
  }
}
