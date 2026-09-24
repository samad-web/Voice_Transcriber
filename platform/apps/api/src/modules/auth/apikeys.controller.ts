import { createHash, randomBytes } from "node:crypto";
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { ApiScope } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgRoleGuard, RequireOrgRole } from "../../common/org-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { auditActor } from "../../common/audit-actor";

const CreateApiKeyBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  /**
   * Required, and with no default. A key minted without stating what it is for
   * can do nothing (0076 defaults `scopes` to the empty set), and silently
   * handing out a dead credential is worse than refusing to mint one - the
   * holder discovers it only when their integration 403s in production.
   */
  scopes: z.array(ApiScope).min(1),
  /** Days until the key stops working. Omit for a key that never expires. */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

/**
 * Programmatic API keys. The raw `cik_live_...` key is returned EXACTLY ONCE at
 * creation - only its sha256 hash is stored, alongside a 12-char display prefix
 * so the UI can identify keys without ever holding the secret again.
 */
@Controller("apikeys")
@UseGuards(AdminKeyGuard, TenantGuard)
export class ApiKeysController {
  constructor(private readonly db: DbService) {}

  @Post()
  @UseGuards(OrgRoleGuard)
  @RequireOrgRole("org_admin")
  async create(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = CreateApiKeyBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { name, description, scopes, expiresInDays } = parsed.data;

    const key = `cik_live_${randomBytes(32).toString("base64url")}`;
    const keyHash = createHash("sha256").update(key).digest("hex");
    const prefix = key.slice(0, 12);

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query(
        `INSERT INTO api_keys (org_id, name, description, key_hash, prefix, scopes, created_by,
                               expires_at)
         VALUES ($1, $2, $3, $4, $5, $6,
                 $7,
                 CASE WHEN $8::int IS NULL THEN NULL
                      ELSE now() + make_interval(days => $8::int) END)
         RETURNING id, prefix, name, scopes, expires_at`,
        [
          orgId,
          name,
          description ?? null,
          keyHash,
          prefix,
          scopes,
          // `created_by` FKs to users; the dev admin key has no user row behind
          // it, so anything that is not a uuid is stored as NULL rather than
          // failing the insert.
          z.string().uuid().safeParse(req.principal?.userId).success ? req.principal?.userId : null,
          expiresInDays ?? null,
        ],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, $4, $2, 'apikey.create', 'api_key', $3)`,
        [orgId, auditActor(req).id, row.id, auditActor(req).type],
      );
      // `key` is shown once, never retrievable again - only the hash is stored.
      return {
        id: row.id,
        prefix: row.prefix,
        name: row.name,
        scopes: row.scopes,
        expiresAt: row.expires_at,
        key,
      };
    });
  }

  @Get()
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, name, description, prefix, scopes, last_used_at, expires_at, revoked_at,
                created_at,
                (revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())) AS active
           FROM api_keys ORDER BY created_at DESC`,
      );
      return { keys: rows };
    });
  }

  @Delete(":id")
  @UseGuards(OrgRoleGuard)
  @RequireOrgRole("org_admin")
  async revoke(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      // SOFT revoke, not DELETE.
      //
      // The key stops authenticating immediately - ApiKeyGuard's lookup filters
      // on `revoked_at IS NULL` - but the row survives, and with it the trail of
      // what the key was called, who minted it, what it could do and when it was
      // last used. That trail is most valuable at exactly the moment someone
      // revokes a key in a hurry, which is when a DELETE would destroy it.
      // Already-revoked is idempotent rather than a 404.
      const res = await client.query(
        `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1`,
        [id],
      );
      if ((res.rowCount ?? 0) === 0) throw new NotFoundException("api key not found");
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, $4, $2, 'apikey.revoke', 'api_key', $3)`,
        [orgId, auditActor(req).id, id, auditActor(req).type],
      );
      return { revoked: id };
    });
  }
}
