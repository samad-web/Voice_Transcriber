import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
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
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const TagInput = z.object({
  name: z.string().min(1).max(60),
  color: z.string().max(40).nullish(),
});

const TagPatch = z
  .object({
    name: z.string().min(1).max(60).optional(),
    color: z.string().max(40).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "nothing to update" });

/**
 * Tags (migration 0057).
 *
 * ── TWO GUARD REGIMES IN ONE CONTROLLER, DELIBERATELY ───────────────────
 *
 * Managing the tag VOCABULARY - creating "price-sensitive", renaming it,
 * deleting it - is org configuration, and sits on AdminKeyGuard+TenantGuard
 * with pipelines, roles and custom-field definitions.
 *
 * ATTACHING a tag to a contact is editing that contact, and is gated on
 * `contact:edit` (and `deal:edit` for a deal) through CrmPermissionsGuard.
 * Anything else would be a way around the permission grid: a viewer who
 * cannot edit a contact must not be able to relabel it either, and a tag is
 * exactly as visible on a record as a field is.
 *
 * The guards are therefore per-handler rather than on the class.
 */
@Controller()
@UseGuards(AdminKeyGuard, TenantGuard)
export class TagsController {
  constructor(private readonly db: DbService) {}

  /**
   * The vocabulary, with usage counts.
   *
   * The counts are the point: a tag list without them is a list nobody
   * prunes, because there is no way to see which labels are dead.
   */
  @Get("tags")
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT t.id, t.name, t.color, t.created_at,
                (SELECT count(*) FROM contact_tags ct WHERE ct.tag_id = t.id)::int AS contact_count,
                (SELECT count(*) FROM deal_tags    dt WHERE dt.tag_id = t.id)::int AS deal_count
           FROM tags t
          WHERE t.org_id = $1
          ORDER BY lower(t.name)`,
        [orgId],
      );
      return { tags: rows };
    });
  }

  @Post("tags")
  async create(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = TagInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      try {
        const {
          rows: [tag],
        } = await client.query(
          `INSERT INTO tags (org_id, name, color) VALUES ($1, btrim($2), $3)
           RETURNING id, name, color, created_at`,
          [orgId, parsed.data.name, parsed.data.color ?? null],
        );
        return { tag };
      } catch (err) {
        // The unique index is case-insensitive, so this fires on "VIP" when
        // "vip" exists. Saying which name collided matters - otherwise the
        // operator retries the same word wondering why it failed.
        if (isUniqueViolation(err)) {
          throw new ConflictException(`a tag named "${parsed.data.name}" already exists`);
        }
        throw err;
      }
    });
  }

  @Patch("tags/:id")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = TagPatch.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    const sets: string[] = [];
    const params: unknown[] = [id];
    if (parsed.data.name !== undefined) {
      params.push(parsed.data.name);
      sets.push(`name = btrim($${params.length})`);
    }
    if (parsed.data.color !== undefined) {
      params.push(parsed.data.color);
      sets.push(`color = $${params.length}`);
    }

    return this.db.withOrg(orgId, async (client) => {
      try {
        const {
          rows: [tag],
        } = await client.query(
          `UPDATE tags SET ${sets.join(", ")} WHERE id = $1
           RETURNING id, name, color, created_at`,
          params,
        );
        if (!tag) throw new NotFoundException("tag not found");
        return { tag };
      } catch (err) {
        if (isUniqueViolation(err)) throw new ConflictException("a tag with that name exists");
        throw err;
      }
    });
  }

  /**
   * Delete the tag and every attachment of it.
   *
   * The join tables CASCADE, so this really does remove the label everywhere
   * rather than leaving orphaned rows. That is destructive and irreversible,
   * which is why the list endpoint returns usage counts - the console shows
   * "used on 34 contacts" before it asks.
   */
  @Delete("tags/:id")
  async remove(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(`DELETE FROM tags WHERE id = $1`, [id]);
      if (!rowCount) throw new NotFoundException("tag not found");
      return { deleted: true };
    });
  }

  // ── attaching ─────────────────────────────────────────────────────────

  @Post("contacts/:id/tags")
  @UseGuards(CrmPermissionsGuard)
  @RequireCrmPermission("contact", "edit")
  async tagContact(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) contactId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const tagId = readTagId(body);
    return this.db.withOrg(orgId, async (client) => {
      // ON CONFLICT DO NOTHING: attaching a tag twice is a no-op, not an
      // error. The console fires this from a toggle, and a double-click is
      // not a failure anybody should see a message about.
      const { rowCount } = await client.query(
        `INSERT INTO contact_tags (org_id, contact_id, tag_id, tagged_by)
         SELECT $1, c.id, t.id, $4
           FROM contacts c, tags t
          WHERE c.id = $2 AND c.org_id = $1 AND t.id = $3 AND t.org_id = $1
         ON CONFLICT (contact_id, tag_id) DO NOTHING`,
        [orgId, contactId, tagId, actorUserId(req)],
      );
      // Zero rows means the contact or the tag does not exist in this org -
      // the SELECT matched nothing. Not distinguishable from an already
      // attached tag, so it is checked rather than guessed.
      if (!rowCount) await assertAttached(client, "contact_tags", "contact_id", contactId, tagId);
      return { attached: true };
    });
  }

  @Delete("contacts/:id/tags/:tagId")
  @UseGuards(CrmPermissionsGuard)
  @RequireCrmPermission("contact", "edit")
  async untagContact(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) contactId: string,
    @Param("tagId", ParseUUIDPipe) tagId: string,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      await client.query(`DELETE FROM contact_tags WHERE contact_id = $1 AND tag_id = $2`, [
        contactId,
        tagId,
      ]);
      return { detached: true };
    });
  }

  @Post("deals/:id/tags")
  @UseGuards(CrmPermissionsGuard)
  @RequireCrmPermission("deal", "edit")
  async tagDeal(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) dealId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const tagId = readTagId(body);
    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(
        `INSERT INTO deal_tags (org_id, deal_id, tag_id, tagged_by)
         SELECT $1, d.id, t.id, $4
           FROM deals d, tags t
          WHERE d.id = $2 AND d.org_id = $1 AND t.id = $3 AND t.org_id = $1
         ON CONFLICT (deal_id, tag_id) DO NOTHING`,
        [orgId, dealId, tagId, actorUserId(req)],
      );
      if (!rowCount) await assertAttached(client, "deal_tags", "deal_id", dealId, tagId);
      return { attached: true };
    });
  }

  @Delete("deals/:id/tags/:tagId")
  @UseGuards(CrmPermissionsGuard)
  @RequireCrmPermission("deal", "edit")
  async untagDeal(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) dealId: string,
    @Param("tagId", ParseUUIDPipe) tagId: string,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      await client.query(`DELETE FROM deal_tags WHERE deal_id = $1 AND tag_id = $2`, [
        dealId,
        tagId,
      ]);
      return { detached: true };
    });
  }
}

function readTagId(body: unknown): string {
  const parsed = z.object({ tagId: z.string().uuid() }).safeParse(body);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return parsed.data.tagId;
}

/**
 * Tell "already attached" apart from "no such record".
 *
 * The INSERT ... SELECT returns zero rows for both, and they mean opposite
 * things: one is success, the other is a 404 the caller needs to see.
 */
async function assertAttached(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rowCount: number | null }> },
  table: string,
  column: string,
  recordId: string,
  tagId: string,
): Promise<void> {
  const { rowCount } = await client.query(
    `SELECT 1 FROM ${table} WHERE ${column} = $1 AND tag_id = $2`,
    [recordId, tagId],
  );
  if (!rowCount) throw new NotFoundException("record or tag not found");
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

function actorUserId(req: PrincipalRequest): string | null {
  // Same shape tasks/automation use: an admin-key caller has no user id, and a
  // non-uuid must never reach a uuid column.
  const parsed = z.string().uuid().safeParse(req.principal?.userId);
  return parsed.success ? parsed.data : null;
}
