import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { ASR_LANGUAGES, ASR_MODES } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { hashAppLockPassword } from "../../common/app-lock-hash";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgRoleGuard, RequireOrgRole } from "../../common/org-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * Per-tenant logo/colors (Kailash gap Milestone 4). One jsonb column
 * (migration 0065), same "tenant config as jsonb on organizations" precedent
 * as lead_stages/lead_rules - this is too small to earn its own table.
 */
const BrandingBody = z.object({
  logoUrl: z.string().url().max(500).nullish(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/u).nullish(),
  secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/u).nullish(),
  browserTitle: z.string().max(120).nullish(),
});

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

/** Org-level compliance policy (§2.6): consent regime + retention window. */
@Controller("org")
@UseGuards(AdminKeyGuard, TenantGuard)
export class TenancyController {
  constructor(private readonly db: DbService) {}

  @Get()
  async get(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [org],
      } = await client.query(
        `SELECT id, name, status, consent_policy, on_consent_failure, retention_days, region,
                store_full_number, transcription_enabled, asr_language, asr_mode, vocabulary, branding,
                enabled_modules,
                (app_lock_password_hash IS NOT NULL) AS app_lock_enabled
           FROM organizations WHERE id = $1`,
        [orgId],
      );
      return org;
    });
  }

  @Patch("branding")
  @UseGuards(OrgRoleGuard)
  @RequireOrgRole("org_admin")
  async updateBranding(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
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
         VALUES ($1, 'user', $2, 'org.branding_update', 'organization', $3, $4::jsonb)`,
        [orgId, req.principal?.userId ?? "dev-admin", orgId, JSON.stringify(p)],
      );
      return org;
    });
  }

  @Patch("policy")
  @UseGuards(OrgRoleGuard)
  @RequireOrgRole("org_admin")
  async updatePolicy(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = PolicyBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

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
           asr_language = CASE WHEN $7::boolean THEN $8::text ELSE asr_language END,
           asr_mode = CASE WHEN $9::boolean THEN $10::text ELSE asr_mode END,
           vocabulary = COALESCE($11::text[], vocabulary),
           app_lock_password_hash = CASE WHEN $12::boolean THEN $13::text ELSE app_lock_password_hash END
         WHERE id = $1
         RETURNING consent_policy, on_consent_failure, retention_days, store_full_number,
                   transcription_enabled, asr_language, asr_mode, vocabulary,
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
         VALUES ($1, 'user', $2, 'org.policy_update', 'organization', $3, $4::jsonb)`,
        [orgId, req.principal?.userId ?? "dev-admin", orgId, JSON.stringify(auditMeta)],
      );
      return org;
    });
  }

  /** Immutable audit ledger (§2.6) for the web Compliance page. */
  @Get("audit")
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
