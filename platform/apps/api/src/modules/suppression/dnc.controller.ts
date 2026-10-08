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
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { orgPhoneCountry } from "../../common/console-phone";
import {
  CrmPermissionsGuard,
  hasCrmGrant,
  RequireCrmPermission,
} from "../../common/crm-permissions.guard";
import { OrgFeatureGuard, RequireFeature } from "../../common/org-feature.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import {
  DNC_MAX_CELL_BYTES,
  DNC_MAX_NUMBERS_PER_REQUEST,
  DncImportService,
  normaliseDncNumbers,
  type DncRowFailure,
} from "./dnc-import.service";

/**
 * Bulk suppression lists (migration 0158, Build docs/39 §4.2).
 *
 * ── FOUR ROUTES, AND THE ONE THAT IS MISSING ────────────────────────────────
 *
 * Read the lists, make one, append numbers to one, change one. There is NO
 * delete route, and that is the design: 0158 says a list is disabled and never
 * deleted, because deleting one silently re-opens forty thousand numbers for
 * dialling with nothing left to say they were ever closed. Retirement is
 * `PATCH /dnc/lists/:id {"status":"disabled"}`, which leaves the rows and the
 * reason in place - the same move 0111 makes releasing an opt-out by UPDATE.
 * `ENFORCED_PERMISSIONS` therefore has no `dnc:delete`; a cell there would be
 * a checkbox with no route behind it.
 *
 * ── WHO MAY DO WHAT ─────────────────────────────────────────────────────────
 *
 * `dnc:view` for the read, seeded by 0158 to every console role INCLUDING
 * `viewer` - the agent screen renders `dialability()`'s block reason verbatim,
 * "on a do-not-call list" is one of the seven, and withholding the read would
 * make the dialer look broken to the people using it. There is no number in a
 * list to leak: `dnc_entries` holds a SHA-256 of the last ten digits.
 *
 * `dnc:create` and `dnc:edit` go to the three admin roles only, which narrows
 * 0041's pattern on purpose: `edit` includes `status = 'disabled'`, and
 * `create` lets somebody shadow a registry with an empty list of their own.
 * The same judgement 0136 made keeping `workspace_member` away from
 * `lead_board`.
 *
 * Scope is always `all` - both objects are in `ALL_SCOPE_ONLY_OBJECTS`, so no
 * statement in this file emits an `owned` clause and none should ever be
 * added. "My own DNC list" means nothing: the people on it are owed silence by
 * everybody, not by whoever uploaded the sheet.
 */

const DncListName = z.string().trim().min(1, "Name this list.").max(120);

const CreateListBody = z.object({
  name: DncListName,
  /**
   * 'regulatory' is somebody else's list the tenant must honour; 'internal' is
   * their own. Required, with NO default: 0158 makes the distinction the thing
   * a compliance question is answered with, and defaulting it would answer
   * that question on the uploader's behalf.
   */
  kind: z.enum(["regulatory", "internal"]),
});

/**
 * HAND-BUILT, not `CreateListBody.partial()`.
 *
 * `.partial()` keeps `.default()`, so a PATCH that omits a field with a
 * default silently rewrites it to that default. There is one live instance of
 * that bug in outreach cadences and doc 39 §8 flags it again for the dialer's
 * own PATCH. `CreateListBody` has no defaults today, which is exactly when
 * this shortcut looks safe and is how the next person adds one.
 */
const UpdateListBody = z
  .object({ name: DncListName.optional(), status: z.enum(["active", "disabled"]).optional() })
  .refine((b) => b.name !== undefined || b.status !== undefined, "nothing to update");

const AddEntriesBody = z.object({
  /**
   * The sheet's phone cells, parsed in the browser exactly as the CSV importer
   * does it (Papa Parse) - there is no file upload here and no multer.
   *
   * Capped per request, not per list: see dnc-import.service.ts on why 40,000
   * arrives as chunks and why the count is still right at the end.
   */
  // The per-element cap here bounds the PAYLOAD and nothing else. The
  // semantic "this is too long to be a phone number" rule is
  // DNC_MAX_CELL_CHARS, applied per row in normaliseDncNumbers, because a cap
  // at this level turns one misfiled cell into a 400 for the whole chunk and
  // throws away the per-row report for 4,999 good numbers with it.
  numbers: z.array(z.string().max(DNC_MAX_CELL_BYTES)).min(1).max(DNC_MAX_NUMBERS_PER_REQUEST),
});

export const DNC_LIST_SQL = `SELECT l.id, l.name, l.kind, l.status, l.entry_count,
            l.uploaded_by, COALESCE(NULLIF(btrim(u.name), ''), u.email) AS uploaded_by_name,
            l.created_at
       FROM dnc_lists l
       LEFT JOIN users u ON u.id = l.uploaded_by
      ORDER BY l.created_at DESC`;

export const DNC_AUDIT_SQL = `INSERT INTO audit_log
       (org_id, actor_type, actor_id, action, target_type, target_id, meta)
     VALUES ($1, $2, $3, $4, 'dnc_list', $5, $6::jsonb)`;

interface ListRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  entry_count: number;
  uploaded_by: string | null;
  uploaded_by_name: string | null;
  created_at: Date;
}

/**
 * ── WHY THE FEATURE GATE IS HERE (Build docs/40 §A3) ───────────────────────
 *
 * `suppression` was one of the 25 features enforced only by the web tier's page
 * guard: switching Do-not-call lists off hid `/owner/settings/suppression` and
 * left every route below answering normally to anyone with a direct link or a
 * stale server action.
 *
 * It qualifies for a route gate under `org-feature.guard.ts`'s own rule - gate a
 * route only when the WHOLE route belongs to the feature - because nothing else
 * in the product reads `/v1/dnc/*`. The handset's dialability check resolves
 * suppression in-process, not over HTTP, so gating these routes cannot leave a
 * phone unable to tell an agent why a record is greyed out.
 *
 * `suppression` defaults ON, so this changes nothing for any existing tenant. It
 * only makes "off" mean off for one who chooses it - and because `dialer`
 * REQUIRES `suppression`, that choice blocks the dialer rather than leaving it
 * running with an unmaintainable list.
 */
@Controller("dnc")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard, OrgFeatureGuard)
@RequireFeature("suppression")
export class DncController {
  constructor(
    private readonly db: DbService,
    private readonly imports: DncImportService,
  ) {}

  /**
   * Every list this tenant holds, newest first. Counts only - there is no
   * number in the table.
   *
   * ── WHY THE RESPONSE CARRIES `can` ──────────────────────────────────────────
   *
   * 0158 seeds `dnc:view` to every system role including `viewer`, because the
   * agent screen renders dialability()'s block reason verbatim and "on a DNC
   * list" is one of the seven. But `dnc:create`/`dnc:edit` go to the three
   * admin roles only, and both are grantable per role on Team & permissions.
   *
   * So "may read this page" and "may change anything on it" genuinely come
   * apart here, and the console cannot infer the second from the persona - a
   * workspace that granted `dnc:view` to a manager but withheld `dnc:create`
   * would otherwise get a Create button that 403s on press. Guessing from the
   * persona is exactly what `canEditSwitch` on the call-escalation settings
   * route exists to stop, and this is the same shape of answer.
   *
   * Two extra grant reads on a page nobody loads in a loop, and it rides the
   * same `withOrg` transaction - no extra round trip at Seoul latency.
   */
  @Get("lists")
  @RequireCrmPermission("dnc", "view")
  async lists(
    @OrgId() orgId: string,
    @Req() req: PrincipalRequest,
  ): Promise<{ lists: unknown[]; can: { create: boolean; edit: boolean } }> {
    // `hasCrmGrant` reads the grid for a console USER. An operator acting
    // through the admin key has no row in it and auditActor reports them as
    // `operator`/`system` - they already passed CrmPermissionsGuard to reach
    // this handler, so they are able, and answering `false` would render them
    // a read-only page they can in fact write.
    const actor = auditActor(req);
    const userId = actor.type === "user" ? actor.id : null;
    const { rows, can } = await this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<ListRow>(DNC_LIST_SQL);
      const can = userId
        ? {
            create: await hasCrmGrant(client, orgId, userId, "dnc", "create"),
            edit: await hasCrmGrant(client, orgId, userId, "dnc", "edit"),
          }
        : { create: true, edit: true };
      return { rows, can };
    });
    return {
      lists: rows.map((l) => ({
        id: l.id,
        name: l.name,
        kind: l.kind,
        status: l.status,
        entryCount: Number(l.entry_count),
        uploadedBy: l.uploaded_by,
        uploadedByName: l.uploaded_by_name,
        createdAt: l.created_at,
      })),
      can,
    };
  }

  /** A new, empty list. Numbers are appended by the route below. */
  @Post("lists")
  @RequireCrmPermission("dnc", "create")
  async create(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Body() body: unknown,
  ): Promise<{ list: { id: string; name: string; kind: string; status: string; entryCount: number } }> {
    const parsed = CreateListBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { name, kind } = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<{ id: string; name: string; kind: string; status: string; entry_count: number }>(
        `INSERT INTO dnc_lists (org_id, name, kind, uploaded_by)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, kind, status, entry_count`,
        // `uploaded_by` is a real person or nobody. The bare admin key has no
        // `users` row, and 0158's FK would refuse the literal "admin-key".
        [orgId, name, kind, actor.type === "user" ? actor.id : null],
      );

      await client.query(DNC_AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "dnc_list.created",
        row.id,
        JSON.stringify({ name, kind }),
      ]);

      return {
        list: {
          id: row.id,
          name: row.name,
          kind: row.kind,
          status: row.status,
          entryCount: Number(row.entry_count),
        },
      };
    });
  }

  /**
   * Append a chunk of a sheet to a list.
   *
   * `dnc:create` rather than `dnc:edit`, and the two are seeded identically by
   * 0158 so nothing hangs on the choice today: adding numbers is what making a
   * list is FOR, and a role that may create one but not fill it would hold a
   * permission that cannot accomplish anything.
   *
   * The whole chunk - lock, insert, reconcile - runs in one `withOrg`
   * callback, which is one transaction. That is §6's requirement that
   * `entry_count` be reconciled in the same transaction as the bulk insert,
   * and the reason it is not a second request: a count written by a later call
   * can be lost, retried, or interleaved with another chunk.
   */
  @Post("lists/:id/entries")
  @RequireCrmPermission("dnc", "create")
  async addEntries(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) listId: string,
    @Body() body: unknown,
  ): Promise<{
    accepted: number;
    inserted: number;
    alreadyPresent: number;
    duplicatesInSheet: number;
    blank: number;
    entryCount: number;
    failed: DncRowFailure[];
  }> {
    const parsed = AddEntriesBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [list],
      } = await client.query<{ id: string; name: string; status: string }>(
        `SELECT id, name, status FROM dnc_lists WHERE id = $1`,
        [listId],
      );
      if (!list) throw new NotFoundException("dnc list not found");
      if (list.status !== "active") {
        // A disabled list is history. Appending to it would grow a suppression
        // list that suppresses nothing, and the uploader would have no way to
        // tell from the count.
        throw new ConflictException({
          code: "list_disabled",
          message: `"${list.name}" is disabled. Re-enable it before adding numbers.`,
        });
      }

      // What a cell without a "+" is read against - the workspace's own
      // country, read the same way the CSV importer and every console phone
      // field read it (org_business_profile, 0126; India for an org that never
      // saved Time & location).
      const country = await orgPhoneCountry(client, orgId);
      const normalised = normaliseDncNumbers(parsed.data.numbers, country);

      const ingest = await this.imports.ingest(client, { orgId, listId, keys: normalised.keys });

      await client.query(DNC_AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "dnc_list.entries_added",
        listId,
        JSON.stringify({
          submitted: parsed.data.numbers.length,
          accepted: normalised.keys.length,
          inserted: ingest.inserted,
          failed: normalised.failed.length,
          entryCount: ingest.entryCount,
        }),
      ]);

      return {
        accepted: normalised.keys.length,
        inserted: ingest.inserted,
        alreadyPresent: ingest.alreadyPresent,
        duplicatesInSheet: normalised.duplicatesInSheet,
        blank: normalised.blank,
        entryCount: ingest.entryCount,
        // Every rejected cell, with the reason libphonenumber gave. A row that
        // did not key is a person who will still be rung, so it is reported
        // rather than counted.
        failed: normalised.failed,
      };
    });
  }

  /** Rename a list, or retire it. The retirement path - there is no delete. */
  @Patch("lists/:id")
  @RequireCrmPermission("dnc", "edit")
  async update(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) listId: string,
    @Body() body: unknown,
  ): Promise<{ list: { id: string; name: string; kind: string; status: string; entryCount: number } }> {
    const parsed = UpdateListBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { name, status } = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      // Read first, under FOR UPDATE: the 404 needs the row anyway, and
      // "disabled, previously active" is the one fact the audit row has to
      // carry and the UPDATE can no longer see. Not folded into RETURNING as a
      // subquery - that would read the statement's pre-update snapshot, which
      // happens to be right and is the kind of right nobody can verify.
      const {
        rows: [before],
      } = await client.query<{ status: string }>(`SELECT status FROM dnc_lists WHERE id = $1 FOR UPDATE`, [
        listId,
      ]);
      if (!before) throw new NotFoundException("dnc list not found");

      // COALESCE over a hand-built pair, so an omitted field is genuinely
      // omitted. See UpdateListBody on why this is not `.partial()`.
      const {
        rows: [row],
      } = await client.query<{
        id: string;
        name: string;
        kind: string;
        status: string;
        entry_count: number;
      }>(
        `UPDATE dnc_lists
            SET name   = COALESCE($2, name),
                status = COALESCE($3, status)
          WHERE id = $1
          RETURNING id, name, kind, status, entry_count`,
        [listId, name ?? null, status ?? null],
      );
      if (!row) throw new NotFoundException("dnc list not found");

      await client.query(DNC_AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "dnc_list.updated",
        listId,
        JSON.stringify({ name: name ?? null, status: status ?? null, previousStatus: before.status }),
      ]);

      return {
        list: {
          id: row.id,
          name: row.name,
          kind: row.kind,
          status: row.status,
          entryCount: Number(row.entry_count),
        },
      };
    });
  }
}
