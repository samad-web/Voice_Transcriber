import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { HAND_LOGGED_CALL_METADATA, InteractionInput } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { RecordScope, scopeClause, type CrmRecordScope } from "../../common/crm-scope";
import { assertInOrg } from "../../common/org-references";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { enqueueAutomationEventSafely } from "../automation/enqueue";

const ListQuery = z.object({
  type: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const SearchQuery = z.object({
  q: z.string().trim().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(25).default(8),
});

/** `%`, `_` and the escape character itself are literal in a search box, not wildcards. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * ~140 characters of `text` centred on the first case-insensitive hit of `q`,
 * with ellipses where it was cut. Done here rather than in SQL so the browser
 * never receives a 4 KB note body to show one line of it.
 */
export function snippetAround(text: string, q: string, width = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= width) return flat;
  const hit = flat.toLowerCase().indexOf(q.toLowerCase());
  let start = hit < 0 ? 0 : Math.max(0, Math.min(hit - Math.floor(width / 3), flat.length - width));
  // Begin on a word, not halfway through one - unless that would skip the hit.
  if (start > 0 && flat[start - 1] !== " ") {
    const space = flat.indexOf(" ", start);
    if (space !== -1 && (hit < 0 || space < hit)) start = space + 1;
  }
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

// `actor_label` and `connection_id` ride along so the console can say WHO did
// something as well as their name: a user id is a person, 'automation' is a
// rule, a connection is a mailbox/calendar sync, and a call carries the
// handset's telecaller. See apps/web/lib/activity.ts.
const INTERACTION_COLUMNS = `i.id, i.type, i.direction, i.contact_id, i.account_id, i.deal_id,
  i.call_id, i.subject, i.body, i.occurred_at, i.duration_s, i.actor_user_id,
  COALESCE(u.name, i.actor_label) AS actor, i.actor_label, i.connection_id, i.metadata, i.created_at`;

/**
 * The unified interaction timeline (Track A2, migration 0040).
 *
 * Routes are NESTED under the object they describe - `GET /v1/contacts/:id/
 * interactions` rather than `GET /v1/interactions?contactId=` - because that
 * is what makes the permission gate correct. `CrmPermissionsGuard` reads
 * STATIC decorator metadata, so a single flat endpoint filtered by query
 * param could not decide whether to demand `contact:view` or `deal:view`; the
 * parent in the path decides it unambiguously.
 *
 * Shares the `contacts`/`accounts`/`deals` prefixes from a separate
 * controller, the same way NotesController shares `calls` with
 * CallsController - the timeline is one concern and belongs in one file, even
 * though it hangs off three parents.
 *
 * Gated on the PARENT's `view`, not on some interaction-level permission:
 * `PermissionObjectType` is `contact|account|deal` only, and a contact's
 * timeline is a fact about that contact. Note the rows carry `deal_id`, so a
 * role with `contact:view` but not `deal:view` learns that some deal exists -
 * an id and nothing more, no deal fields - which is the same exposure
 * `contacts.account_id` already carries on the contact row itself.
 */
@Controller()
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class InteractionsController {
  constructor(private readonly db: DbService) {}

  @Get("contacts/:id/interactions")
  @RequireCrmPermission("contact", "view")
  async forContact(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.list(orgId, "contacts", id, "i.contact_id = $1", query, recordScope);
  }

  @Get("deals/:id/interactions")
  @RequireCrmPermission("deal", "view")
  async forDeal(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.list(orgId, "deals", id, "i.deal_id = $1", query, recordScope);
  }

  /**
   * An account's timeline is its own rows PLUS every row belonging to a
   * contact that works there - an account with no direct interactions but
   * three busy contacts should not look dormant. Resolved through the
   * subquery at read time rather than denormalised onto `interactions.
   * account_id`, so re-parenting a contact (a merge, an admin edit) moves its
   * history with it automatically.
   */
  @Get("accounts/:id/interactions")
  @RequireCrmPermission("account", "view")
  async forAccount(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.list(
      orgId,
      "accounts",
      id,
      `(i.account_id = $1 OR i.contact_id IN (SELECT id FROM contacts WHERE account_id = $1))`,
      query,
      recordScope,
    );
  }

  /**
   * Activity-note search for the console's global search box.
   *
   * The one flat interactions route, and the header's argument against flat
   * routes still holds - which is why it is gated on `contact:view` and returns
   * ONLY rows attached to a contact the caller can see. The parent is decided
   * statically (the contact), exactly as the nested routes decide it by path;
   * the contact's `owned` scope is applied in the join, so a scoped rep cannot
   * find a colleague's call notes by guessing a word in them.
   *
   * Consequence, stated rather than hidden: an interaction attached only to a
   * deal or an account (no contact) is not searchable here. `logOnDeal` stamps
   * the deal's contact when it has one, so in practice that is a deal with no
   * person on it.
   *
   * Matches `subject` and `body`. For synced mail those hold the subject and
   * snippet only (Track A safety rule 1), so this cannot surface a message body
   * the CRM never stored.
   */
  @Get("interactions/search")
  @RequireCrmPermission("contact", "view")
  async search(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = SearchQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { q, limit } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const params: unknown[] = [`%${escapeLike(q)}%`];
      const owned = scopeClause("contact", recordScope, 3, "c");
      params.push(limit);
      if (owned) params.push(recordScope.userId);

      const { rows } = await client.query<{
        id: string;
        type: string;
        direction: string | null;
        subject: string | null;
        body: string | null;
        occurred_at: string;
        contact_id: string;
        contact_name: string;
        deal_id: string | null;
        actor: string | null;
      }>(
        `SELECT i.id, i.type, i.direction, i.subject, left(i.body, 4000) AS body,
                i.occurred_at, i.contact_id, c.display_name AS contact_name, i.deal_id,
                COALESCE(u.name, i.actor_label) AS actor
           FROM interactions i
           JOIN contacts c ON c.id = i.contact_id AND c.status <> 'merged'
           LEFT JOIN users u ON u.id = i.actor_user_id
          WHERE (i.subject ILIKE $1 ESCAPE '\\' OR i.body ILIKE $1 ESCAPE '\\')
                ${owned ? `AND ${owned}` : ""}
          ORDER BY i.occurred_at DESC
          LIMIT $2`,
        params,
      );

      return {
        notes: rows.map(({ body, ...row }) => ({
          ...row,
          snippet: snippetAround(body ?? row.subject ?? "", q),
        })),
      };
    });
  }

  @Post("contacts/:id/interactions")
  @RequireCrmPermission("contact", "edit")
  async logOnContact(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.create(orgId, "contacts", id, { contactId: id }, body, req, recordScope);
  }

  @Post("accounts/:id/interactions")
  @RequireCrmPermission("account", "edit")
  async logOnAccount(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.create(orgId, "accounts", id, { accountId: id }, body, req, recordScope);
  }

  /**
   * Logging against a deal also stamps the deal's contact, so the note shows
   * up on that person's timeline too - which is what a rep means by "log a
   * call with Priya about the Acme deal".
   */
  @Post("deals/:id/interactions")
  @RequireCrmPermission("deal", "edit")
  async logOnDeal(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.create(orgId, "deals", id, { dealId: id }, body, req, recordScope);
  }

  // ── shared implementation ────────────────────────────────────────────────

  private async list(
    orgId: string,
    parentTable: "contacts" | "accounts" | "deals",
    parentId: string,
    scope: string,
    query: unknown,
    recordScope: CrmRecordScope,
  ) {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { type, limit, offset } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      await assertExists(client, parentTable, parentId, recordScope);

      const params: unknown[] = [parentId];
      let where = scope;
      if (type) {
        params.push(type);
        where += ` AND i.type = $${params.length}`;
      }

      params.push(limit, offset);
      const { rows } = await client.query(
        `SELECT ${INTERACTION_COLUMNS}, count(*) OVER() AS total
           FROM interactions i
           LEFT JOIN users u ON u.id = i.actor_user_id
          WHERE ${where}
          ORDER BY i.occurred_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      return {
        interactions: rows.map(({ total: _total, ...row }) => row),
        total: rows.length > 0 ? Number(rows[0].total) : 0,
        limit,
        offset,
      };
    });
  }

  private async create(
    orgId: string,
    parentTable: "contacts" | "accounts" | "deals",
    parentId: string,
    attach: { contactId?: string; accountId?: string; dealId?: string },
    body: unknown,
    req: PrincipalRequest,
    recordScope: CrmRecordScope,
  ) {
    // The parent comes from the PATH, so the body may not also name one -
    // otherwise `POST /contacts/A/interactions {contactId: B}` would write to
    // B while having been permission-checked against A.
    const parsed = InteractionInput.safeParse({ ...(body as object), ...attach });
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      await assertExists(client, parentTable, parentId, recordScope);
      // The parent is checked above; the OTHER links in the body are not the
      // parent and were written unchecked. Foreign-key checks ignore RLS
      // (doc 23, A2).
      await assertInOrg(client, orgId, {
        contactId: p.contactId,
        accountId: p.accountId,
        dealId: p.dealId,
      });

      // Logging against a deal fills in that deal's contact; see logOnDeal.
      let contactId = p.contactId ?? null;
      if (!contactId && parentTable === "deals") {
        const {
          rows: [deal],
        } = await client.query<{ contact_id: string | null }>(
          `SELECT contact_id FROM deals WHERE id = $1`,
          [parentId],
        );
        contactId = deal?.contact_id ?? null;
      }

      // A hand-logged call carries its marker IN THE ROW (@aura/shared's
      // HAND_LOGGED_CALL_METADATA), never only in the UI: call_id stays NULL, so
      // the call-integrity sweep cannot mistake it for a recording, and the
      // retention reaper and erasure read the marker as a person's record.
      // Direction defaults to outgoing - "log call" on a follow-up is a call
      // somebody made.
      const isCall = p.type === "call";
      const metadata = isCall ? { ...HAND_LOGGED_CALL_METADATA, outcome: p.outcome } : {};

      const {
        rows: [interaction],
      } = await client.query(
        `INSERT INTO interactions
           (org_id, type, direction, contact_id, account_id, deal_id, subject, body,
            occurred_at, duration_s, actor_user_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()), $10, $11, $12::jsonb)
         RETURNING id, type, direction, contact_id, account_id, deal_id, subject, body,
                   occurred_at, duration_s, actor_user_id,
                   -- The same shape the list returns, so a row the console
                   -- shows straight after logging it already says who wrote it.
                   (SELECT u.name FROM users u WHERE u.id = interactions.actor_user_id) AS actor,
                   actor_label, connection_id, metadata, created_at`,
        [
          orgId,
          p.type,
          p.direction ?? (isCall ? "outgoing" : null),
          contactId,
          p.accountId ?? null,
          p.dealId ?? null,
          p.subject ?? null,
          p.body ?? null,
          p.occurredAt ?? null,
          p.durationS ?? null,
          actorUserId(req),
          JSON.stringify(metadata),
        ],
      );

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'interaction.create', $3, $4)`,
        [orgId, req.principal?.userId ?? "dev-admin", parentTable.replace(/s$/, ""), parentId],
      );

      // Any interaction is activity: keep the object's sort key honest so a
      // freshly-noted deal rises to the top of an activity-ordered list.
      await client.query(
        `UPDATE ${parentTable} SET last_activity_at = GREATEST(last_activity_at, $2::timestamptz)
          WHERE id = $1`,
        [parentId, interaction.occurred_at],
      );

      await enqueueAutomationEventSafely(
        client,
        orgId,
        "interaction.logged",
        "interaction",
        interaction.id,
        {
          dealId: interaction.deal_id ?? null,
          contactId: interaction.contact_id ?? null,
          accountId: interaction.account_id ?? null,
          interactionType: interaction.type,
        },
      );

      return { interaction };
    });
  }
}

/**
 * FK violations bypass RLS and surface as a 500, so confirm the parent is
 * visible in THIS org first - same reasoning (and same fix) as
 * NotesController's call check.
 */
async function assertExists(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }> },
  table: "contacts" | "accounts" | "deals",
  id: string,
  recordScope: CrmRecordScope,
): Promise<void> {
  // The `owned` scope applies to the PARENT, which is what this route was
  // permission-checked against. Without it a scoped rep could read a
  // colleague's whole deal timeline by knowing the deal's id - the record
  // itself would 404, but its history would not.
  const objectType = table.replace(/s$/, "") as "contact" | "account" | "deal";
  const scoped = scopeClause(objectType, recordScope, 2);
  const found = await client.query(
    `SELECT 1 FROM ${table} WHERE id = $1 ${scoped ? `AND ${scoped}` : ""}`,
    scoped ? [id, recordScope.userId] : [id],
  );
  if (!found.rowCount) throw new NotFoundException(`${objectType} not found`);
}

/**
 * `interactions.actor_user_id` is a real uuid FK, but the dev admin-key path
 * leaves `principal.userId` as the literal string "admin-key" - inserting
 * that raises 22P02. Same validate-or-null helper merge.controller.ts needs
 * for `merge_log.performed_by`.
 */
function actorUserId(req: PrincipalRequest): string | null {
  const parsed = z.string().uuid().safeParse(req.principal?.userId);
  return parsed.success ? parsed.data : null;
}
