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
/**
 * A DEEP IMPORT, not `from "@aura/shared"`.
 *
 * `packages/shared/src/index.ts` is owned by another process in this wave, so
 * `resources.ts` is not in the barrel yet. The same workaround the dialer
 * module and console-phone.ts already use - it resolves to the same compiled
 * file and costs nothing. Collapse it to the barrel once the export lands.
 */
import {
  MAX_HOLD_HOURS,
  ResourceManualStatus,
  ResourceStatus,
  ResourceTypeKey,
  holdExpiresAt,
  remainingCapacity,
  tenantResourceTypes,
} from "@aura/shared/dist/resources";
// A DEEP import for the same reason the one above is: `stage-packs` pulls in
// the lead-stage schema, and the barrel would drag the whole of @aura/shared
// into a module that needs one function from it.
import { packSlotMinutes } from "@aura/shared/dist/stage-packs";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * The `resources` primitive (migration 0165, Build docs/39 §23-§24).
 *
 * One controller for a flat, a vehicle, a chair, a seat in a batch and a
 * departure date. There is no `if (pack === …)` anywhere in this file and
 * there must never be: §28's rule is that an industry is not a primitive, and
 * the moment one branch appears here the next nine follow.
 *
 * ── THE ROUTES, AND THE ONE THAT IS MISSING ────────────────────────────────
 *
 * Read the inventory, read the tenant's own type list, read one row, create
 * one, change one, hold / release, book / unbook.
 *
 * There is NO delete route. A resource is RETIRED (`status = 'retired'`),
 * which frees its code for re-use and leaves the row that a hold, a booking
 * and an appointment all point at. Deleting one would cascade
 * `appointments.resource_id` to NULL and lose what the site visit was OF -
 * and `resources.parent_id` is ON DELETE CASCADE, so deleting a tower would
 * take forty flats with it on a mis-click. `ENFORCED_PERMISSIONS` therefore
 * has no `resource:delete`; a cell there would be a checkbox with no route
 * behind it, which is the thing 0158 refused for `dnc`.
 *
 * ── WHY STATUS IS NOT A FREE FIELD ON PATCH ────────────────────────────────
 *
 * `held` and `booked` are both produced by a TRANSITION that writes more than
 * one column - a hold writes an expiry and a holder, a booking increments
 * `booked_count` under a row lock. Letting a PATCH assert either is exactly
 * how `booked_count` drifts away from the truth, and §24 is explicit that the
 * count is maintained by the booking path. So PATCH accepts only
 * `ResourceManualStatus`.
 *
 * ── WHO MAY DO WHAT (seeded by 0165) ───────────────────────────────────────
 *
 * `resource:view` to every console role including `viewer` - inventory is
 * floor information and there is nothing personal in the table.
 * `resource:edit` to the three admin roles AND `workspace_member`, because
 * holding a unit is an `edit` and holding is the telecaller's whole job here.
 * `resource:create` to the three admin roles only: defining what the business
 * sells is configuration, and a telecaller inventing a second code for a batch
 * that already exists is something the unique index cannot catch.
 *
 * Scope is always `all` - `resource` is in `ALL_SCOPE_ONLY_OBJECTS` and its
 * `OWNER_COLUMN` is null, so no statement in this file emits an `owned` clause
 * and none should ever be added. "My own flat" means nothing.
 */

const Code = z.string().trim().min(1, "Give this a code.").max(120);
const Name = z.string().trim().min(1, "Name this.").max(200);
const Attributes = z.record(z.string(), z.unknown());

const CreateResourceBody = z.object({
  resourceType: ResourceTypeKey,
  code: Code,
  name: Name,
  /**
   * Required with NO default, deliberately. §24's whole modelling is that a
   * unique item is capacity 1 and a batch of 40 is 40, and a default of 1
   * would answer that question on the uploader's behalf - which is how a
   * forty-seat batch ends up refusing its second admission.
   */
  capacity: z.number().int().min(1).max(100_000),
  parentId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  priceNum: z.number().nullable().optional(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
  attributes: Attributes.optional(),
});

/**
 * HAND-BUILT, not `CreateResourceBody.partial()`.
 *
 * `.partial()` keeps `.default()`, so a PATCH that omits a field carrying one
 * silently rewrites it to that default. There is a live instance of that bug
 * in outreach cadences and doc 39 flags it again for every PATCH in the plan.
 * `CreateResourceBody` happens to carry no `.default()` today, which is
 * precisely when the shortcut looks safe and is how the next person adds one.
 *
 * Every field is `.optional()` and NOTHING is `.nullish()` by accident: a
 * `null` here means "clear it" and an absent key means "leave it", and the
 * COALESCE pairs below are what keep those two apart in SQL.
 */
const UpdateResourceBody = z
  .object({
    resourceType: ResourceTypeKey.optional(),
    code: Code.optional(),
    name: Name.optional(),
    capacity: z.number().int().min(1).max(100_000).optional(),
    parentId: z.string().uuid().nullable().optional(),
    projectId: z.string().uuid().nullable().optional(),
    priceNum: z.number().nullable().optional(),
    currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
    attributes: Attributes.optional(),
    status: ResourceManualStatus.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "nothing to update");

const HoldBody = z.object({
  leadId: z.string().uuid().nullable().optional(),
  /**
   * Optional. Omitted, the window comes from the type (§24: 2-7 days for a
   * property unit, closer to 2 hours for a salon station). Clamped to
   * MAX_HOLD_HOURS in @aura/shared, because an unbounded hold is a rep quietly
   * reserving the whole tower.
   */
  hours: z.number().int().min(1).max(MAX_HOLD_HOURS).optional(),
});

const BookBody = z.object({
  leadId: z.string().uuid().nullable().optional(),
  /** A batch admission may take several seats at once. */
  seats: z.number().int().min(1).max(1000).optional(),
});

const ListQuery = z.object({
  resourceType: ResourceTypeKey.optional(),
  status: ResourceStatus.optional(),
  parentId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  /**
   * Only rows with capacity left, which is the question a rep actually asks.
   *
   * Read as a STRING and compared, not `z.coerce.boolean()`: coercion makes
   * the string "false" truthy, so `?availableOnly=false` would filter. Every
   * other boolean query parameter in this codebase is read the same way
   * (tasks.controller.ts's `mine`).
   */
  availableOnly: z.enum(["1", "true", "0", "false"]).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const RESOURCE_COLUMNS = `r.id, r.resource_type, r.parent_id, r.project_id, r.code, r.name,
  r.capacity, r.booked_count, r.status, r.price_num, r.currency, r.attributes,
  r.held_for_lead_id, r.held_by_user_id, r.held_until, r.created_at, r.updated_at`;

export const RESOURCE_AUDIT_SQL = `INSERT INTO audit_log
     (org_id, actor_type, actor_id, action, target_type, target_id, meta)
   VALUES ($1, $2, $3, $4, 'resource', $5, $6::jsonb)`;

/**
 * Lock the row and read what the decision depends on.
 *
 * `FOR UPDATE`, in a statement of its own and OUTSIDE any CTE - the same rule
 * the hold sweep follows, and for the same reason: two reps converting the
 * last seat in a batch at the same moment is the normal case, not the rare
 * one. The lock is granted only after any concurrent writer commits, and the
 * row that comes back is the latest committed version rather than the
 * snapshot's, so the capacity check below is made against reality.
 */
export const LOCK_RESOURCE_SQL = `SELECT id, resource_type, code, name, status, capacity,
          booked_count, held_for_lead_id, held_until
     FROM resources
    WHERE id = $1
      FOR UPDATE`;

interface LockedResource {
  id: string;
  resource_type: string;
  code: string;
  name: string;
  status: string;
  capacity: number;
  booked_count: number;
  held_for_lead_id: string | null;
  held_until: Date | null;
}

interface ResourceRow {
  id: string;
  resource_type: string;
  parent_id: string | null;
  project_id: string | null;
  code: string;
  name: string;
  capacity: number;
  booked_count: number;
  status: string;
  price_num: string | null;
  currency: string;
  attributes: Record<string, unknown>;
  held_for_lead_id: string | null;
  held_by_user_id: string | null;
  held_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

function present(row: ResourceRow) {
  return {
    id: row.id,
    resourceType: row.resource_type,
    parentId: row.parent_id,
    projectId: row.project_id,
    code: row.code,
    name: row.name,
    capacity: Number(row.capacity),
    bookedCount: Number(row.booked_count),
    remaining: remainingCapacity(Number(row.capacity), Number(row.booked_count)),
    status: row.status,
    priceNum: row.price_num === null ? null : Number(row.price_num),
    currency: row.currency,
    attributes: row.attributes,
    heldForLeadId: row.held_for_lead_id,
    heldByUserId: row.held_by_user_id,
    heldUntil: row.held_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

@Controller("resources")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class ResourcesController {
  constructor(private readonly db: DbService) {}

  @Get()
  @RequireCrmPermission("resource", "view")
  async list(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const q = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (clause: string, value: unknown) => {
        params.push(value);
        where.push(clause.replace(/\$\?/g, `$${params.length}`));
      };

      if (q.resourceType) add("r.resource_type = $?", q.resourceType);
      if (q.status) add("r.status = $?", q.status);
      if (q.parentId) add("r.parent_id = $?", q.parentId);
      if (q.projectId) add("r.project_id = $?", q.projectId);
      if (q.q) add("(r.code ILIKE $? OR r.name ILIKE $?)", `%${q.q}%`);
      if (q.availableOnly === "1" || q.availableOnly === "true") {
        // "Can I sell this right now" - a held row counts, because the rep
        // holding it is the one converting it, and the hold sweep is what
        // frees the ones nobody did.
        where.push("r.status IN ('available','held') AND r.booked_count < r.capacity");
      }
      // A retired row is gone from the inventory and must not turn up in a
      // picker; it stays readable by id so an old appointment still resolves.
      where.push("r.status <> 'retired'");

      params.push(q.limit, q.offset);
      const { rows } = await client.query<ResourceRow & { total: string }>(
        `SELECT ${RESOURCE_COLUMNS}, count(*) OVER() AS total
           FROM resources r
          WHERE ${where.join(" AND ")}
          ORDER BY r.resource_type, lower(r.code)
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      return {
        resources: rows.map(({ total: _total, ...row }) => present(row as ResourceRow)),
        total: rows.length > 0 ? Number(rows[0].total) : 0,
        limit: q.limit,
        offset: q.offset,
      };
    });
  }

  /**
   * The tenant's own type list - what §24 means by "validated against the
   * tenant's own list, never a CHECK".
   *
   * Two sources, in this order: the types they already use, then their stage
   * pack's suggestions. In-use first because a tenant who has typed `villa`
   * wants `villa` at the top rather than hunting for it under five
   * suggestions they never took.
   *
   * ── THE PACK IS NOW PERSISTED (migration 0170) ────────────────────────────
   *
   * §22 says "Aura already knows what business each tenant is in". For two
   * waves it did not: `suggestPack()` was computed from free text on a GET,
   * applying a pack only rewrote a pipeline's stage list, and no column
   * anywhere said a tenant was a clinic. This route therefore asked its CALLER
   * which business the tenant was - a question no caller could answer, so every
   * request fell through to the general pack and a dental practice was offered
   * `item / slot / date`. That was the gap doc 40 called F8.
   *
   * `organizations.stage_pack` closes it, written by
   * `POST /pipelines/:id/apply-stage-pack` in the same transaction as the
   * stages. `?pack=` still wins when sent, for an onboarding screen previewing
   * a pack before anybody applies it; absent, it no longer means "assume
   * general".
   *
   * Declared above `@Get(":id")` - Nest matches in declaration order, and
   * after it "types" would be parsed as a resource id and 400 on the uuid pipe.
   */
  @Get("types")
  @RequireCrmPermission("resource", "view")
  async types(@OrgId() orgId: string, @Query("pack") pack?: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{ resource_type: string; count: string }>(
        `SELECT resource_type, count(*)::text AS count
           FROM resources
          WHERE status <> 'retired'
          GROUP BY resource_type
          ORDER BY count(*) DESC, resource_type`,
      );
      // THE WORKSPACE'S OWN PACK, read here rather than asked of the caller
      // (migration 0170, Build docs/40 §D).
      //
      // The paragraph above this route used to explain that nothing persisted
      // the choice and the console therefore "passes what it knows", which in
      // practice was nothing: no caller could answer "is this tenant a clinic",
      // so every request fell through to the general pack and a dental practice
      // was offered `item / slot / date`. 0170 records it, so the route can
      // simply look.
      //
      // `?pack=` still wins when it is sent, for the onboarding screen that
      // needs to preview a pack's vocabulary BEFORE anybody applies it. An
      // explicit question beats a stored answer; an absent one no longer means
      // "assume general".
      const {
        rows: [org],
      } = await client.query<{ stage_pack: string | null }>(
        `SELECT stage_pack FROM organizations WHERE id = $1`,
        [orgId],
      );
      const effectivePack = pack ?? org?.stage_pack ?? null;
      const inUse = rows.map((row) => row.resource_type);
      return {
        types: tenantResourceTypes(inUse, effectivePack),
        inUse: rows.map((row) => ({ type: row.resource_type, count: Number(row.count) })),
        /** Which pack these suggestions came from - null when never chosen. */
        pack: effectivePack,
        /** The diary's default length for this pack, so the console need not map it. */
        slotMinutes: packSlotMinutes(effectivePack),
      };
    });
  }

  @Get(":id")
  @RequireCrmPermission("resource", "view")
  async one(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<ResourceRow>(
        `SELECT ${RESOURCE_COLUMNS} FROM resources r WHERE r.id = $1`,
        [id],
      );
      if (!row) throw new NotFoundException("resource not found");
      return { resource: present(row) };
    });
  }

  @Post()
  @RequireCrmPermission("resource", "create")
  async create(@Req() req: PrincipalRequest, @OrgId() orgId: string, @Body() body: unknown) {
    const parsed = CreateResourceBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      if (input.parentId) await assertParentUsable(client, input.parentId, null);

      let row: ResourceRow;
      try {
        const result = await client.query<ResourceRow>(
          `INSERT INTO resources
             (org_id, resource_type, parent_id, project_id, code, name, capacity,
              price_num, currency, attributes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 'INR'), COALESCE($10::jsonb, '{}'::jsonb), $11)
           RETURNING ${RESOURCE_COLUMNS.replace(/r\./g, "")}`,
          [
            orgId,
            input.resourceType,
            input.parentId ?? null,
            input.projectId ?? null,
            input.code,
            input.name,
            input.capacity,
            input.priceNum ?? null,
            input.currency ?? null,
            input.attributes ? JSON.stringify(input.attributes) : null,
            // A real person or nobody: the bare admin key has no `users` row
            // and 0165's FK would refuse the literal "admin-key".
            actor.type === "user" ? actor.id : null,
          ],
        );
        row = result.rows[0];
      } catch (err) {
        throw duplicateCode(err, input.resourceType, input.code);
      }

      await client.query(RESOURCE_AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "resource.created",
        row.id,
        JSON.stringify({
          resourceType: input.resourceType,
          code: input.code,
          capacity: input.capacity,
        }),
      ]);

      return { resource: present(row) };
    });
  }

  @Patch(":id")
  @RequireCrmPermission("resource", "edit")
  async update(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = UpdateResourceBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      // Read under FOR UPDATE: the 404 needs the row anyway, the audit row has
      // to carry the previous status, and lowering `capacity` has to be judged
      // against a `booked_count` nothing can change underneath it.
      const {
        rows: [before],
      } = await client.query<LockedResource>(LOCK_RESOURCE_SQL, [id]);
      if (!before) throw new NotFoundException("resource not found");

      if (input.capacity !== undefined && input.capacity < Number(before.booked_count)) {
        // `resources_not_oversold` would catch this as a 23514 that reads like
        // a server error. The person lowering a batch from 40 to 20 needs to
        // be told that 31 seats are already taken.
        throw new ConflictException({
          code: "capacity_below_booked",
          message: `${before.booked_count} already booked - capacity cannot go below that.`,
        });
      }
      if (input.parentId) await assertParentUsable(client, input.parentId, id);
      if (input.status === "retired" && Number(before.booked_count) > 0) {
        throw new ConflictException({
          code: "retire_with_bookings",
          message: `${before.booked_count} booking(s) are on this. Move them before retiring it.`,
        });
      }
      if (input.status && before.status === "held") {
        // A manual status move out of `held` without releasing would leave
        // held_until set and trip resources_held_has_expiry. Release is a
        // route of its own, and saying so is better than a constraint error.
        throw new ConflictException({
          code: "resource_is_held",
          message: "This is on hold. Release the hold before changing its status.",
        });
      }

      // COALESCE over a hand-built pair for every field, so an omitted key is
      // genuinely omitted. See UpdateResourceBody on why this is not
      // `.partial()`. The three nullable fields take an explicit "clear me"
      // flag rather than relying on COALESCE, which cannot tell null-the-value
      // from null-the-absence.
      const { rows } = await client
        .query<ResourceRow>(
          `UPDATE resources
              SET resource_type = COALESCE($2, resource_type),
                  code          = COALESCE($3, code),
                  name          = COALESCE($4, name),
                  capacity      = COALESCE($5, capacity),
                  status        = COALESCE($6, status),
                  currency      = COALESCE($7, currency),
                  attributes    = COALESCE($8::jsonb, attributes),
                  parent_id     = CASE WHEN $9  THEN $10 ELSE parent_id  END,
                  project_id    = CASE WHEN $11 THEN $12 ELSE project_id END,
                  price_num     = CASE WHEN $13 THEN $14 ELSE price_num  END
            WHERE id = $1
            RETURNING ${RESOURCE_COLUMNS.replace(/r\./g, "")}`,
          [
            id,
            input.resourceType ?? null,
            input.code ?? null,
            input.name ?? null,
            input.capacity ?? null,
            input.status ?? null,
            input.currency ?? null,
            input.attributes ? JSON.stringify(input.attributes) : null,
            input.parentId !== undefined,
            input.parentId ?? null,
            input.projectId !== undefined,
            input.projectId ?? null,
            input.priceNum !== undefined,
            input.priceNum ?? null,
          ],
        )
        .catch((err: unknown) => {
          throw duplicateCode(err, input.resourceType ?? before.resource_type, input.code ?? before.code);
        });

      const row = rows[0];
      if (!row) throw new NotFoundException("resource not found");

      await client.query(RESOURCE_AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "resource.updated",
        id,
        JSON.stringify({ ...input, previousStatus: before.status }),
      ]);

      return { resource: present(row) };
    });
  }

  /**
   * Hold it for a lead.
   *
   * `resource:edit` rather than a permission of its own: holding is the
   * telecaller's job on this table, and 0165 seeds `edit` to
   * `workspace_member` for exactly that reason.
   */
  @Post(":id/hold")
  @RequireCrmPermission("resource", "edit")
  async hold(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = HoldBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<LockedResource>(LOCK_RESOURCE_SQL, [id]);
      if (!row) throw new NotFoundException("resource not found");

      if (row.status === "held") {
        // Re-holding somebody else's hold is how a unit gets promised twice.
        // Extending YOUR OWN is a legitimate thing to want and is deliberately
        // not offered here either - release and re-hold, so the audit trail
        // carries both halves.
        throw new ConflictException({
          code: "already_held",
          message: `${row.code} is already on hold until ${row.held_until?.toISOString() ?? "later"}.`,
        });
      }
      if (row.status !== "available") {
        throw new ConflictException({
          code: "not_holdable",
          message: `${row.code} is ${row.status}.`,
        });
      }
      if (Number(row.booked_count) >= Number(row.capacity)) {
        throw new ConflictException({ code: "no_capacity", message: `${row.code} is full.` });
      }

      const until = holdExpiresAt(row.resource_type, new Date(), parsed.data.hours);
      const { rows: updated } = await client.query<ResourceRow>(
        `UPDATE resources
            SET status = 'held', held_until = $2,
                held_for_lead_id = $3, held_by_user_id = $4
          WHERE id = $1 AND status = 'available'
          RETURNING ${RESOURCE_COLUMNS.replace(/r\./g, "")}`,
        [
          id,
          until.toISOString(),
          parsed.data.leadId ?? null,
          actor.type === "user" ? actor.id : null,
        ],
      );
      if (!updated[0]) {
        throw new ConflictException({ code: "not_holdable", message: "Somebody got there first." });
      }

      await client.query(RESOURCE_AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "resource.held",
        id,
        JSON.stringify({ leadId: parsed.data.leadId ?? null, heldUntil: until.toISOString() }),
      ]);

      return { resource: present(updated[0]) };
    });
  }

  /** Give it back before the sweep would. Same clearing the sweep does. */
  @Post(":id/release")
  @RequireCrmPermission("resource", "edit")
  async release(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const actor = auditActor(req);
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<LockedResource>(LOCK_RESOURCE_SQL, [id]);
      if (!row) throw new NotFoundException("resource not found");
      if (row.status !== "held") {
        throw new ConflictException({ code: "not_held", message: `${row.code} is not on hold.` });
      }

      const { rows: updated } = await client.query<ResourceRow>(
        `UPDATE resources
            SET status = 'available', held_until = NULL,
                held_for_lead_id = NULL, held_by_user_id = NULL
          WHERE id = $1 AND status = 'held'
          RETURNING ${RESOURCE_COLUMNS.replace(/r\./g, "")}`,
        [id],
      );
      if (!updated[0]) throw new NotFoundException("resource not found");

      await client.query(RESOURCE_AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "resource.hold_released",
        id,
        JSON.stringify({ heldForLeadId: row.held_for_lead_id }),
      ]);

      return { resource: present(updated[0]) };
    });
  }

  /**
   * Take one (or several) of its capacity.
   *
   * ── THIS IS THE "BOOKING PATH" §24 MEANS ───────────────────────────────────
   *
   * `booked_count` is maintained HERE and never by a trigger, because a
   * trigger on appointments would also fire on the reaper's cascade deletes
   * and on an org deletion, silently decrementing counts on rows about to
   * disappear.
   *
   * `status` follows the count rather than leading it: a batch with 3 of 40
   * taken is still `available`, and only the row that fills up becomes
   * `booked`. That is what makes capacity-1 and capacity-40 the same code
   * path, which is the whole of §23.
   */
  @Post(":id/book")
  @RequireCrmPermission("resource", "edit")
  async book(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = BookBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const seats = parsed.data.seats ?? 1;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<LockedResource>(LOCK_RESOURCE_SQL, [id]);
      if (!row) throw new NotFoundException("resource not found");
      if (row.status !== "available" && row.status !== "held") {
        throw new ConflictException({
          code: "not_bookable",
          message: `${row.code} is ${row.status}.`,
        });
      }
      if (remainingCapacity(Number(row.capacity), Number(row.booked_count)) < seats) {
        throw new ConflictException({
          code: "no_capacity",
          message: `${remainingCapacity(Number(row.capacity), Number(row.booked_count))} left on ${row.code}.`,
        });
      }

      // One statement: the count, the status that follows from it, and the
      // hold that the booking consumes. Splitting them would let a crash
      // between two of them leave a booked row still carrying a hold, which
      // `resources_held_has_expiry` would then refuse to let anybody fix.
      const { rows: updated } = await client.query<ResourceRow>(
        `UPDATE resources
            SET booked_count     = booked_count + $2,
                status           = CASE WHEN booked_count + $2 >= capacity
                                        THEN 'booked' ELSE 'available' END,
                held_until       = NULL,
                held_for_lead_id = NULL,
                held_by_user_id  = NULL
          WHERE id = $1
            AND status IN ('available','held')
            AND booked_count + $2 <= capacity
          RETURNING ${RESOURCE_COLUMNS.replace(/r\./g, "")}`,
        [id, seats],
      );
      if (!updated[0]) {
        throw new ConflictException({ code: "no_capacity", message: "Somebody got there first." });
      }

      await client.query(RESOURCE_AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "resource.booked",
        id,
        JSON.stringify({
          seats,
          leadId: parsed.data.leadId ?? null,
          // The hold this booking consumed, which the row no longer records.
          consumedHoldForLeadId: row.held_for_lead_id,
        }),
      ]);

      return { resource: present(updated[0]) };
    });
  }

  /**
   * Give capacity back.
   *
   * The counterpart to `/book`, and the reason there is no `bookedCount` field
   * on PATCH: a hand-set count is how the number stops meaning anything. A
   * booking that falls through goes back through this route, which writes an
   * audit row saying so.
   */
  @Post(":id/unbook")
  @RequireCrmPermission("resource", "edit")
  async unbook(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = BookBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const seats = parsed.data.seats ?? 1;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<LockedResource>(LOCK_RESOURCE_SQL, [id]);
      if (!row) throw new NotFoundException("resource not found");
      if (Number(row.booked_count) < seats) {
        throw new ConflictException({
          code: "nothing_to_release",
          message: `Only ${row.booked_count} booked on ${row.code}.`,
        });
      }
      if (row.status === "sold") {
        // 'sold' is terminal for a one-off item (a flat that completed), and
        // undoing it is a decision somebody makes explicitly with PATCH.
        throw new ConflictException({
          code: "resource_sold",
          message: `${row.code} is sold. Change its status first if that was wrong.`,
        });
      }

      const { rows: updated } = await client.query<ResourceRow>(
        // A HELD row keeps its status. A batch at 3 of 40 can legitimately be
        // on hold for a fourth seat, and rewriting it to 'available' here
        // would leave `held_until` set on a non-held row - which
        // `resources_held_has_expiry` refuses, turning an ordinary unbook into
        // a 23514 that nobody could then fix without releasing the hold.
        `UPDATE resources
            SET booked_count = booked_count - $2,
                status       = CASE WHEN status = 'held' THEN 'held'
                                    WHEN booked_count - $2 >= capacity THEN 'booked'
                                    ELSE 'available' END
          WHERE id = $1 AND booked_count >= $2
          RETURNING ${RESOURCE_COLUMNS.replace(/r\./g, "")}`,
        [id, seats],
      );
      if (!updated[0]) {
        throw new ConflictException({
          code: "nothing_to_release",
          message: "Somebody got there first.",
        });
      }

      await client.query(RESOURCE_AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "resource.unbooked",
        id,
        JSON.stringify({ seats, leadId: parsed.data.leadId ?? null }),
      ]);

      return { resource: present(updated[0]) };
    });
  }
}

/**
 * A parent must exist, be in this org, and not be a descendant of the row
 * being re-parented.
 *
 * `resources_no_self_parent` catches only the trivial A -> A. A cycle of two
 * (A -> B -> A) is not expressible as a CHECK, and the damage is not a bad row
 * - it is that every tree walk in the console and every recursive report runs
 * forever. A recursive CTE is the cheapest place to refuse it, and it runs
 * inside `withOrg`, so RLS confines the walk to this tenant.
 */
async function assertParentUsable(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  parentId: string,
  selfId: string | null,
): Promise<void> {
  if (selfId && parentId === selfId) {
    throw new BadRequestException("a resource cannot be its own parent");
  }
  const { rows } = await client.query(`SELECT id FROM resources WHERE id = $1`, [parentId]);
  if (rows.length === 0) throw new BadRequestException("parent resource not found");
  if (!selfId) return;

  const { rows: cycle } = await client.query(
    `WITH RECURSIVE up AS (
       SELECT id, parent_id FROM resources WHERE id = $1
       UNION ALL
       SELECT r.id, r.parent_id FROM resources r JOIN up ON r.id = up.parent_id
     )
     SELECT id FROM up WHERE id = $2`,
    [parentId, selfId],
  );
  if (cycle.length > 0) {
    throw new BadRequestException("that parent is underneath this resource - it would make a loop");
  }
}

/** 23505 on `resources_org_type_code` - the same code, live, on this type. */
function duplicateCode(err: unknown, resourceType: string, code: string): unknown {
  if ((err as { code?: string })?.code === "23505") {
    return new ConflictException({
      code: "duplicate_code",
      message: `A live ${resourceType} already uses the code "${code}".`,
    });
  }
  return err;
}
