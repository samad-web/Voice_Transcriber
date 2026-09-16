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
import { BulkTagInput, type BulkResult } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { RecordScope, scopeFilter, type CrmRecordScope } from "../../common/crm-scope";
import { assertInOrg } from "../../common/org-references";
import { softDelete } from "../../common/soft-delete";
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
          WHERE t.org_id = $1 AND t.deleted_at IS NULL
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
          `UPDATE tags SET ${sets.join(", ")} WHERE id = $1 AND deleted_at IS NULL
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
   * Retire the tag, reversibly (migration 0097).
   *
   * This used to be a hard DELETE, and the join tables CASCADE, so tidying a
   * tag list also erased which four hundred contacts had been in that campaign.
   * Now the row is marked and the taggings are simply left alone: nothing is
   * deleted, so nothing cascades, and restoring from the bin is one UPDATE.
   *
   * The list endpoint still returns usage counts, because "used on 34 contacts"
   * before the click is better than a recycle bin afterwards.
   */
  @Delete("tags/:id")
  async remove(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const removed = await softDelete(client, "tag", id, req);
      if (!removed) throw new NotFoundException("tag not found");
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

  // ── attaching in bulk (the list views' bulk action bar) ───────────────

  /**
   * One tag onto many contacts - "tag these 40 as the Diwali campaign".
   *
   * Addressed by TAG (`tags/:id/contacts`), not `contacts/bulk/tags`: the
   * latter would be matched by `contacts/:id/tags` above with id "bulk" and
   * fail its uuid pipe before ever reaching a bulk handler.
   *
   * Same grant as attaching one (`contact:edit`), and - unlike the single
   * attach, which predates record scope - the `owned` scope is applied to the
   * selection: a rep who can edit only their own contacts gets their own
   * tagged and the rest counted as skipped, never relabelled.
   */
  @Post("tags/:id/contacts")
  @UseGuards(CrmPermissionsGuard)
  @RequireCrmPermission("contact", "edit")
  async tagContacts(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) tagId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ): Promise<BulkResult> {
    const parsed = BulkTagInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { ids } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      // Foreign keys ignore RLS (org-references.ts): without this, contact_tags
      // would accept another tenant's contact id under this org's tag.
      await assertInOrg(client, orgId, { contactId: ids });
      await assertLiveTag(client, orgId, tagId);
      const counts = await attachInBulk(client, {
        orgId,
        tagId,
        ids,
        actor: actorUserId(req),
        records: "contacts",
        join: "contact_tags",
        column: "contact_id",
        // A merged contact is a pointer to its survivor, not a record anyone works.
        extra: "r.status <> 'merged'",
        owned: scopeFilter("contact", recordScope, "r"),
      });
      return { updated: counts.eligible, skipped: ids.length - counts.eligible };
    });
  }

  /** The same for deals, on `deal:edit` and the deal's own scope. */
  @Post("tags/:id/deals")
  @UseGuards(CrmPermissionsGuard)
  @RequireCrmPermission("deal", "edit")
  async tagDeals(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) tagId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ): Promise<BulkResult> {
    const parsed = BulkTagInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { ids } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      await assertInOrg(client, orgId, { dealId: ids });
      await assertLiveTag(client, orgId, tagId);
      const counts = await attachInBulk(client, {
        orgId,
        tagId,
        ids,
        actor: actorUserId(req),
        records: "deals",
        join: "deal_tags",
        column: "deal_id",
        extra: null,
        owned: scopeFilter("deal", recordScope, "r"),
      });
      return { updated: counts.eligible, skipped: ids.length - counts.eligible };
    });
  }
}

type BulkClient = {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount: number | null }>;
};

/**
 * 400 unless the tag is this org's and not in the recycle bin (0097). A binned
 * tag still exists, and attaching to it would put a label on records that no
 * list, filter or chip can show.
 */
async function assertLiveTag(client: BulkClient, orgId: string, tagId: string): Promise<void> {
  const { rowCount } = await client.query(
    `SELECT 1 FROM tags WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
    [tagId, orgId],
  );
  if (!rowCount) throw new BadRequestException("tagId: no such tag in this organization");
}

/**
 * INSERT ... SELECT over the records the caller may edit, in one statement.
 *
 * `eligible` counts the selected records that passed the scope, whether or not
 * they already carried the tag - re-tagging a tagged record is success, the
 * same no-op the single attach treats it as.
 *
 * Table and column names come from the two call sites above, never from the
 * request.
 */
async function attachInBulk(
  client: BulkClient,
  o: {
    orgId: string;
    tagId: string;
    ids: string[];
    actor: string | null;
    records: "contacts" | "deals";
    join: "contact_tags" | "deal_tags";
    column: "contact_id" | "deal_id";
    extra: string | null;
    owned: { sql: string; value: string } | null;
  },
): Promise<{ eligible: number }> {
  const params: unknown[] = [o.orgId, o.ids, o.tagId, o.actor];
  const where = [`r.org_id = $1`, `r.id = ANY($2::uuid[])`];
  if (o.extra) where.push(o.extra);
  if (o.owned) {
    params.push(o.owned.value);
    where.push(o.owned.sql.replace(/\$\?/g, `$${params.length}`));
  }
  const {
    rows: [row],
  } = await client.query<{ eligible: number }>(
    `WITH eligible AS (
       SELECT r.id FROM ${o.records} r WHERE ${where.join(" AND ")}
     ), attached AS (
       INSERT INTO ${o.join} (org_id, ${o.column}, tag_id, tagged_by)
       SELECT $1, e.id, $3, $4 FROM eligible e
       ON CONFLICT (${o.column}, tag_id) DO NOTHING
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM eligible)::int AS eligible,
            (SELECT count(*) FROM attached)::int AS attached`,
    params,
  );
  return { eligible: row?.eligible ?? 0 };
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
