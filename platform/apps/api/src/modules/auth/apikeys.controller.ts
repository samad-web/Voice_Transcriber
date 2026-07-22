import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { orgIdFromHeader } from "../../common/org-context";
import { DbService } from "../../db/db.service";

const CreateApiKeyBody = z.object({
  name: z.string().min(1).max(120),
});

/**
 * Programmatic API keys. The raw `cik_live_...` key is returned EXACTLY ONCE at
 * creation — only its sha256 hash is stored, alongside a 12-char display prefix
 * so the UI can identify keys without ever holding the secret again.
 */
@Controller("apikeys")
@UseGuards(AdminKeyGuard)
export class ApiKeysController {
  constructor(private readonly db: DbService) {}

  @Post()
  async create(@Headers("x-org-id") orgHeader: string | undefined, @Body() body: unknown) {
    const orgId = orgIdFromHeader(orgHeader);
    const parsed = CreateApiKeyBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { name } = parsed.data;

    const key = `cik_live_${randomBytes(32).toString("base64url")}`;
    const keyHash = createHash("sha256").update(key).digest("hex");
    const prefix = key.slice(0, 12);

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query(
        `INSERT INTO api_keys (org_id, name, key_hash, prefix)
         VALUES ($1, $2, $3, $4)
         RETURNING id, prefix, name`,
        [orgId, name, keyHash, prefix],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', 'dev-admin', 'apikey.create', 'api_key', $2)`,
        [orgId, row.id],
      );
      // `key` is shown once, never retrievable again — only the hash is stored.
      return { id: row.id, prefix: row.prefix, name: row.name, key };
    });
  }

  @Get()
  async list(@Headers("x-org-id") orgHeader: string | undefined) {
    const orgId = orgIdFromHeader(orgHeader);
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, name, prefix, last_used_at, created_at
           FROM api_keys ORDER BY created_at DESC`,
      );
      return { keys: rows };
    });
  }

  @Delete(":id")
  async revoke(
    @Headers("x-org-id") orgHeader: string | undefined,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const orgId = orgIdFromHeader(orgHeader);
    return this.db.withOrg(orgId, async (client) => {
      const res = await client.query("DELETE FROM api_keys WHERE id = $1", [id]);
      if ((res.rowCount ?? 0) === 0) throw new NotFoundException("api key not found");
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', 'dev-admin', 'apikey.revoke', 'api_key', $2)`,
        [orgId, id],
      );
      return { revoked: id };
    });
  }
}
