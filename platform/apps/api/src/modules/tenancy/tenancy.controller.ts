import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Patch,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { orgIdFromHeader } from "../../common/org-context";
import { DbService } from "../../db/db.service";

const PolicyBody = z.object({
  consentPolicy: z.enum(["none", "tone", "tone_and_tts", "prohibited"]).optional(),
  onConsentFailure: z.enum(["record_and_flag", "do_not_record"]).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
});

/** Org-level compliance policy (§2.6): consent regime + retention window. */
@Controller("org")
@UseGuards(AdminKeyGuard)
export class TenancyController {
  constructor(private readonly db: DbService) {}

  @Get()
  async get(@Headers("x-org-id") orgHeader: string | undefined) {
    const orgId = orgIdFromHeader(orgHeader);
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [org],
      } = await client.query(
        `SELECT id, name, status, consent_policy, on_consent_failure, retention_days, region
           FROM organizations WHERE id = $1`,
        [orgId],
      );
      return org;
    });
  }

  @Patch("policy")
  async updatePolicy(@Headers("x-org-id") orgHeader: string | undefined, @Body() body: unknown) {
    const orgId = orgIdFromHeader(orgHeader);
    const parsed = PolicyBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [org],
      } = await client.query(
        `UPDATE organizations SET
           consent_policy = COALESCE($2, consent_policy),
           on_consent_failure = COALESCE($3, on_consent_failure),
           retention_days = COALESCE($4, retention_days)
         WHERE id = $1
         RETURNING consent_policy, on_consent_failure, retention_days`,
        [orgId, p.consentPolicy ?? null, p.onConsentFailure ?? null, p.retentionDays ?? null],
      );
      // Policy changes must reach devices: bump every instance's config version.
      await client.query(
        "UPDATE instances SET config_version = config_version + 1 WHERE org_id = $1",
        [orgId],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', 'dev-admin', 'org.policy_update', 'organization', $2, $3::jsonb)`,
        [orgId, orgId, JSON.stringify(p)],
      );
      return org;
    });
  }

  /** Immutable audit ledger (§2.6) for the web Compliance page. */
  @Get("audit")
  async audit(@Headers("x-org-id") orgHeader: string | undefined) {
    const orgId = orgIdFromHeader(orgHeader);
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, actor_type, actor_id, action, target_type, target_id, ip, meta, created_at
           FROM audit_log ORDER BY created_at DESC LIMIT 200`,
      );
      return { entries: rows };
    });
  }
}
