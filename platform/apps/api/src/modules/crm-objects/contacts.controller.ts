import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  BulkReassignInput,
  LeadSourceChannel,
  PERMISSION_OBJECT_MODULE,
  ownerRoleSeesAllRecords,
  resolveOwnerRole,
  type BulkResult,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { assignInBulk } from "../../common/bulk-assign";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { RecordScope, scopeClause, scopeFilter, type CrmRecordScope } from "../../common/crm-scope";
import { assertInOrg, assertMembers } from "../../common/org-references";
import { KNOWN_UNIQUE_CONFLICTS, knownUniqueConflict } from "../../common/pg-errors";
import { actorUserId } from "../../common/soft-delete";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { OwnerFilter } from "../../common/list-filters";
import { enqueueAutomationEventSafely } from "../automation/enqueue";
import { auditActor } from "../../common/audit-actor";

const ListQuery = z.object({
  accountId: z.string().uuid().optional(),
  q: z.string().max(200).optional(),
  owner: OwnerFilter.optional(),
  tagId: z.string().uuid().optional(),
  /** `none` = contacts from before migration 0078 recorded a channel. */
  sourceChannel: z.union([LeadSourceChannel, z.literal("none")]).optional(),
  sort: z.enum(["activity", "created", "name", "score"]).default("activity"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * The list's extra read-only columns: who owns the contact and its tags.
 * Correlated subselects rather than joins, because CONTACT_COLUMNS is
 * unqualified and a join would make `id`/`created_at` ambiguous.
 */
const CONTACT_LIST_EXTRAS = `,
  (SELECT u.name FROM users u WHERE u.id = contacts.owner_user_id) AS owner_name,
  COALESCE((
    SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) ORDER BY lower(t.name))
      FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id AND t.deleted_at IS NULL
     WHERE ct.contact_id = contacts.id
  ), '[]'::json) AS tags`;

const CreateContactBody = z.object({
  workspaceId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  displayName: z.string().min(1).max(200),
  firstName: z.string().max(120).optional(),
  lastName: z.string().max(120).optional(),
  email: z.string().email().max(200).optional(),
  title: z.string().max(120).optional(),
});

const UpdateContactBody = z.object({
  displayName: z.string().min(1).max(200).optional(),
  firstName: z.string().max(120).nullable().optional(),
  lastName: z.string().max(120).nullable().optional(),
  email: z.string().email().max(200).nullable().optional(),
  title: z.string().max(120).nullable().optional(),
  accountId: z.string().uuid().nullable().optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  status: z.enum(["active", "archived"]).optional(),
});

const CONTACT_COLUMNS = `id, workspace_id, account_id, first_name, last_name, display_name, email,
  phone_prefix, phone_last3, title, external_ids, owner_user_id, facts, status, merged_into_id,
  source_lead_id, source_channel, display_name_set_by_human_at,
  call_count, lead_score, last_activity_at, created_at, updated_at`;

/**
 * Contacts (people) - CRM Phase 1, E0.1. Strangler-fig: nothing here reads
 * from or writes to `leads`/`call_facts`, and this module is not linked into
 * web nav yet. See the Phase 1 plan.
 */
@Controller("contacts")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class ContactsController {
  constructor(private readonly db: DbService) {}

  @Get()
  @RequireCrmPermission("contact", "view")
  async list(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { accountId, q, owner, tagId, sourceChannel, sort, limit, offset } = parsed.data;

    // "My contacts" with no resolvable me (the bare admin key) has no "my" -
    // an empty list, never everyone's. Same reading as tasks' `mine`.
    const me = actorUserId(req);
    if (owner === "me" && !me) return { contacts: [], total: 0, limit, offset };

    return this.db.withOrg(orgId, async (client) => {
      const where = [`status <> 'merged'`];
      const params: unknown[] = [];
      const add = (clause: string, value: unknown) => {
        params.push(value);
        where.push(clause.replace("$?", `$${params.length}`));
      };

      if (accountId) add("account_id = $?", accountId);
      if (owner === "none") where.push("owner_user_id IS NULL");
      else if (owner) add("owner_user_id = $?", owner === "me" ? me : owner);
      if (tagId) {
        add("EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_id = contacts.id AND ct.tag_id = $?)", tagId);
      }
      if (sourceChannel === "none") where.push("source_channel IS NULL");
      else if (sourceChannel) add("source_channel = $?", sourceChannel);

      // The `owned` half of the permission grid (migration 0039) - see
      // common/crm-scope.ts for why this lives in the query, not the guard.
      const owned = scopeFilter("contact", recordScope);
      if (owned) add(owned.sql, owned.value);
      if (q) {
        params.push(`%${q}%`);
        const p = `$${params.length}`;
        where.push(`(display_name ILIKE ${p} OR email ILIKE ${p})`);
      }

      const ORDER = {
        activity: "last_activity_at DESC",
        created: "created_at DESC",
        name: "display_name ASC",
        // id as the tiebreak: most contacts share a score of 0, and an
        // unstable order repeats or drops rows between pages.
        score: "lead_score DESC, id",
      } as const;

      params.push(limit, offset);
      const { rows } = await client.query(
        `SELECT ${CONTACT_COLUMNS}${CONTACT_LIST_EXTRAS}, count(*) OVER()::int AS total_count
           FROM contacts
          WHERE ${where.join(" AND ")}
          ORDER BY ${ORDER[sort]}
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      return {
        contacts: rows.map(({ total_count: _t, ...c }) => c),
        total: rows[0]?.total_count ?? 0,
        limit,
        offset,
      };
    });
  }

  @Get(":id")
  @RequireCrmPermission("contact", "view")
  async detail(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      // 404 rather than 403 for a record outside the caller's scope: a 403
      // confirms the record exists, which is the fact being withheld.
      const scoped = scopeClause("contact", recordScope, 2);
      const {
        rows: [contact],
      } = await client.query(
        `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE id = $1 ${scoped ? `AND ${scoped}` : ""}`,
        scoped ? [id, recordScope.userId] : [id],
      );
      if (!contact) throw new NotFoundException("contact not found");
      return { contact };
    });
  }

  /** Every deal this contact is on, most recently active first. */
  @Get(":id/deals")
  // Gated on `deal`, not `contact`: the rows this returns are deals, so a role
  // that may see contacts but not deals must not read them through this route.
  @RequireCrmPermission("deal", "view")
  async deals(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [contact],
      } = await client.query(`SELECT id FROM contacts WHERE id = $1`, [id]);
      if (!contact) throw new NotFoundException("contact not found");

      // Scoped on DEAL, not contact - this route's grant is `deal:view`, so
      // the rows being protected are the deals. A scoped rep looking at a
      // shared contact sees their own deals on it and not a colleague's.
      const scoped = scopeClause("deal", recordScope, 2);
      const { rows: deals } = await client.query(
        `SELECT id, pipeline_id, name, stage, status, amount, last_activity_at, created_at
           FROM deals WHERE contact_id = $1 ${scoped ? `AND ${scoped}` : ""}
          ORDER BY last_activity_at DESC`,
        scoped ? [id, recordScope.userId] : [id],
      );
      return { deals };
    });
  }

  @Post()
  @RequireCrmPermission("contact", "create")
  async create(
    @OrgId() orgId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = CreateContactBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    try {
      return await this.insertContact(orgId, p, req, recordScope);
    } catch (err) {
      // The race the pre-check below cannot close: two requests for the same
      // email both pass it, and the second INSERT meets `contacts_org_email`.
      // The index is the authority, so its answer is turned into the same 409
      // the pre-check gives. On a FRESH transaction, because the one that hit
      // the violation is aborted and can run nothing more.
      if (p.email && knownUniqueConflict(err)?.constraint === "contacts_org_email") {
        const conflict = await this.db.withOrg(orgId, (client) =>
          this.emailConflict(client, orgId, p.email!, recordScope.userId),
        );
        throw conflict ?? duplicateEmail(null);
      }
      throw err;
    }
  }

  private insertContact(
    orgId: string,
    p: z.infer<typeof CreateContactBody>,
    req: PrincipalRequest,
    recordScope: CrmRecordScope,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      // A foreign-key check ignores RLS, so without this a contact could be
      // filed under another tenant's account or workspace (doc 23, A2).
      await assertInOrg(client, orgId, { workspaceId: p.workspaceId, accountId: p.accountId });

      // An email is one person per org (`contacts_org_email`, 0035). Asked
      // BEFORE the insert so the common case - somebody typing a customer the
      // business already has - is a 409 that names who, instead of a 23505
      // that surfaced as a bare 500 and left the person guessing.
      if (p.email) {
        const conflict = await this.emailConflict(client, orgId, p.email, recordScope.userId);
        if (conflict) throw conflict;
      }

      const {
        rows: [contact],
      } = await client.query(
        `INSERT INTO contacts
           (org_id, workspace_id, account_id, first_name, last_name, display_name, email, title,
            owner_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${CONTACT_COLUMNS}`,
        [
          orgId,
          p.workspaceId ?? null,
          p.accountId ?? null,
          p.firstName ?? null,
          p.lastName ?? null,
          p.displayName,
          p.email ?? null,
          p.title ?? null,
          // A scoped user's new record is stamped as theirs, or they would
          // create it and immediately lose sight of it.
          recordScope.scope === "owned" ? recordScope.userId : null,
        ],
      );
      await enqueueAutomationEventSafely(client, orgId, "contact.created", "contact", contact.id, {
        contactId: contact.id,
        accountId: contact.account_id ?? null,
        contactOwnerUserId: contact.owner_user_id ?? null,
      });

      await this.audit(client, orgId, "contact.create", contact.id, req);
      return { contact };
    });
  }

  /**
   * The 409 for an email this org already has on a live contact, or null when
   * it has none.
   *
   * Names the existing contact (id + name) ONLY to a caller whose `contact:view`
   * grant reaches it. The route's own scope is the `create` grant, which says
   * nothing about reading: a role may add contacts it cannot browse, and an
   * `owned` rep must not learn a colleague's customer's name by typing their
   * email into a create form. Everyone else is told the email is taken and
   * nothing more - which they could already infer from the refusal itself.
   *
   * `lower(email) = lower($2)` is the index's own expression, so this is an
   * index probe, and it matches exactly what the index would refuse. Merged
   * tombstones are skipped for the same reason: the index skips them.
   */
  private async emailConflict(
    client: { query: <R>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> },
    orgId: string,
    email: string,
    userId: string | null,
  ): Promise<ConflictException | null> {
    const {
      rows: [existing],
    } = await client.query<{ id: string; display_name: string; owner_user_id: string | null }>(
      `SELECT id, display_name, owner_user_id FROM contacts
        WHERE org_id = $1 AND email IS NOT NULL AND lower(email) = lower($2) AND status <> 'merged'
        LIMIT 1`,
      [orgId, email],
    );
    if (!existing) return null;

    const view = userId ? await contactViewScope(client, orgId, userId) : null;
    const visible = view === "all" || (view === "owned" && existing.owner_user_id === userId);
    return duplicateEmail(visible ? { id: existing.id, displayName: existing.display_name } : null);
  }

  /**
   * Give many contacts one owner - the list's bulk "Reassign".
   *
   * `contact:edit`, the grant the single PATCH's ownerUserId needs, and the
   * caller's `owned` scope is part of the UPDATE (bulk-assign.ts): selecting a
   * colleague's contact reassigns nothing and is only counted as skipped.
   */
  @Post("reassign")
  @RequireCrmPermission("contact", "edit")
  async reassign(
    @OrgId() orgId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ): Promise<BulkResult> {
    const parsed = BulkReassignInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { ids, ownerUserId } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      await assertInOrg(client, orgId, { contactId: ids });
      await assertMembers(client, orgId, { ownerUserId });
      const updated = await assignInBulk(client, {
        orgId,
        table: "contacts",
        column: "owner_user_id",
        value: ownerUserId,
        ids,
        extra: "r.status <> 'merged'",
        owned: scopeFilter("contact", recordScope, "r"),
        audit: { targetType: "contact", action: "contact.reassign", actorId: auditActor(req).id },
      });
      return { updated: updated.length, skipped: ids.length - updated.length };
    });
  }

  @Patch(":id")
  @RequireCrmPermission("contact", "edit")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = UpdateContactBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    if (Object.keys(p).length === 0) throw new BadRequestException("no fields to update");

    try {
      return await this.updateContact(orgId, id, p, req, recordScope);
    } catch (err) {
      // Same answer the create path gives (doc 31 §2 X3): changing a contact's
      // email to one another contact already has meets `contacts_org_email`,
      // which reached the caller as a 500. Resolved on a fresh transaction
      // because the one that hit the violation is aborted.
      if (p.email && knownUniqueConflict(err)?.constraint === "contacts_org_email") {
        const conflict = await this.db.withOrg(orgId, (client) =>
          this.emailConflict(client, orgId, p.email!, recordScope.userId),
        );
        throw conflict ?? duplicateEmail(null);
      }
      throw err;
    }
  }

  private updateContact(
    orgId: string,
    id: string,
    p: z.infer<typeof UpdateContactBody>,
    req: PrincipalRequest,
    recordScope: CrmRecordScope,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      // Doc 23, A1/A2: the owner must be a member of THIS org (`users` has no
      // RLS, and the report builder shows the owner's name), and the account
      // must be this org's.
      await assertInOrg(client, orgId, { accountId: p.accountId });
      await assertMembers(client, orgId, { ownerUserId: p.ownerUserId });

      // Same 404-not-403 contract as the detail route: a scoped user editing
      // somebody else's record matches no row, writes nothing, and learns
      // nothing about whether it exists.
      const scopedUpdate = scopeClause("contact", recordScope, 16);
      const {
        rows: [contact],
      } = await client.query(
        `UPDATE contacts SET
           display_name  = COALESCE($2, display_name),
           -- A name a person set is theirs: the call projection stops
           -- overwriting it from the next extraction (migration 0107).
           display_name_set_by_human_at =
             CASE WHEN $2::text IS NOT NULL THEN now() ELSE display_name_set_by_human_at END,
           first_name    = CASE WHEN $3::boolean THEN $4 ELSE first_name END,
           last_name     = CASE WHEN $5::boolean THEN $6 ELSE last_name END,
           email         = CASE WHEN $7::boolean THEN $8 ELSE email END,
           title         = CASE WHEN $9::boolean THEN $10 ELSE title END,
           account_id    = CASE WHEN $11::boolean THEN $12 ELSE account_id END,
           owner_user_id = CASE WHEN $13::boolean THEN $14 ELSE owner_user_id END,
           status        = COALESCE($15, status),
           last_activity_at = now()
         WHERE id = $1 ${scopedUpdate ? `AND ${scopedUpdate}` : ""}
         RETURNING ${CONTACT_COLUMNS}`,
        [
          id,
          p.displayName ?? null,
          p.firstName !== undefined,
          p.firstName ?? null,
          p.lastName !== undefined,
          p.lastName ?? null,
          p.email !== undefined,
          p.email ?? null,
          p.title !== undefined,
          p.title ?? null,
          p.accountId !== undefined,
          p.accountId ?? null,
          p.ownerUserId !== undefined,
          p.ownerUserId ?? null,
          p.status ?? null,
          ...(scopedUpdate ? [recordScope.userId] : []),
        ],
      );
      if (!contact) throw new NotFoundException("contact not found");
      await this.audit(client, orgId, "contact.update", id, req);

      // Archiving a person does not close their deals, and should not - an
      // open negotiation is not over because a record was tidied. But it must
      // not happen silently either: the response says how many deals are still
      // open, so a caller can tell the person doing it (doc 23, H3).
      if (p.status === "archived") {
        const {
          rows: [open],
        } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM deals WHERE contact_id = $1 AND status = 'open'`,
          [id],
        );
        return { contact, openDeals: open.n };
      }
      return { contact };
    });
  }

  private async audit(
    client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    orgId: string,
    action: string,
    targetId: string,
    req: PrincipalRequest,
  ) {
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
       VALUES ($1, $5, $2, $3, 'contact', $4)`,
      [orgId, auditActor(req).id, action, targetId, auditActor(req).type],
    );
  }
}

/**
 * The 409 body for a taken email. `existing` is null when the caller may not
 * see the contact - the web tier offers "use the existing contact" only when
 * it is present, so the two answers stay distinguishable without a second
 * status code.
 */
function duplicateEmail(existing: { id: string; displayName: string } | null): ConflictException {
  const known = KNOWN_UNIQUE_CONFLICTS.contacts_org_email;
  return new ConflictException({
    statusCode: 409,
    error: "Conflict",
    code: known.code,
    message: existing ? `${existing.displayName} already has this email address` : known.message,
    existing,
  });
}

/**
 * The caller's `contact:view` scope - "all", "owned", or null for no grant.
 *
 * The same resolution CrmPermissionsGuard performs for the route's own
 * requirement (grid grant, CRM module on, persona narrowing), asked for a
 * DIFFERENT action: see emailConflict for why the create grant cannot answer
 * a visibility question. Kept in step with that guard by hand; if either
 * changes how a grant resolves, both must.
 */
async function contactViewScope(
  client: { query: <R>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> },
  orgId: string,
  userId: string,
): Promise<"all" | "owned" | null> {
  const {
    rows: [grant],
  } = await client.query<{ scope: string; owner_role: string | null }>(
    `SELECT rp.scope, m.owner_role
       FROM memberships m
       JOIN organizations o
         ON o.id = m.org_id AND $3 = ANY(o.enabled_modules)
       JOIN roles r
         ON r.org_id = m.org_id
        AND (r.id = m.role_id OR (m.role_id IS NULL AND r.key = m.role))
       JOIN role_permissions rp
         ON rp.role_id = r.id AND rp.object_type = 'contact' AND rp.action = 'view'
      WHERE m.user_id = $1 AND m.org_id = $2
      ORDER BY rp.scope
      LIMIT 1`,
    [userId, orgId, PERMISSION_OBJECT_MODULE.contact],
  );
  if (!grant) return null;
  const gridScope = grant.scope === "owned" ? "owned" : "all";
  return ownerRoleSeesAllRecords(resolveOwnerRole(grant.owner_role)) ? gridScope : "owned";
}
