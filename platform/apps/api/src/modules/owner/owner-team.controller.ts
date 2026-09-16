import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  OwnerRole,
  StaffProfileInput,
  resolveOwnerRole,
  tenantRoleForOwnerRole,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { OwnerAccountsService } from "./owner-accounts.service";

/**
 * Which permission role this person holds. `null` clears it, returning them to
 * the legacy `roles.key = memberships.role` fallback that
 * `CrmPermissionsGuard` has always applied to a membership with no role_id -
 * i.e. back to their tenant tier's seeded grants, never to no access at all.
 */
const AssignRoleBody = z.object({
  roleId: z.string().uuid().nullable(),
});

const UpdateMemberBody = z.object({
  ownerRole: OwnerRole.optional(),
  /**
   * Bind this person to a `telecallers` row, or clear the binding.
   *
   * On the same request as `ownerRole` on purpose. An own-scoped persona
   * resolves its records THROUGH this row (owner-scope.ts), so assigning
   * "telecaller" to somebody who has no telecaller identity produces a console
   * that loads, renders, and shows nothing at all - which reads as a broken
   * deploy rather than as an unfinished setup. Letting both be set in one
   * action is what makes the incomplete state hard to reach.
   */
  telecallerId: z.string().uuid().nullable().optional(),
  /**
   * May this person pair a handset? (migration 0107)
   *
   * OWNER-granted, per person - the route is already `@RequireOwnerRole("owner")`
   * so a manager cannot hand the capability to themselves or to anybody else.
   * Setting it on an owner is accepted and inert: `canPairDevices()` returns
   * true for that persona whatever the column says, because a tenant must never
   * reach a state where nobody can pair a phone.
   */
  canPairDevices: z.boolean().optional(),
});

const InviteBody = z.object({
  email: z.string().email().max(200),
  name: z.string().min(1).max(200).optional(),
  /**
   * Required, with no default. Defaulting would mean a mis-typed or omitted
   * field silently provisions the WIDEST persona - the one failure this whole
   * screen exists to make impossible. An owner choosing "Owner" must have
   * chosen it.
   */
  ownerRole: OwnerRole,
  /** Bind them to a telecaller identity in the same action - see update(). */
  telecallerId: z.string().uuid().nullable().optional(),
  /**
   * Listening to a recording is a privacy event, so a new colleague gets it
   * only if asked for - the opposite default to the operator path, which
   * provisions account holders rather than staff.
   */
  recordingsListen: z.boolean().default(false),
  recordingsExport: z.boolean().default(false),
});

/**
 * The customer's own team page - who is in this workspace and what console
 * each of them gets.
 *
 * WHY THIS EXISTS AT ALL. `13_ROUTE_AND_GUARD_INVENTORY.md` finding 7: "No
 * route on the platform writes `owner_role` to anything other than 'owner'."
 * The persona model has been enforced by `OwnerRoleGuard` and filtered in
 * `nav.ts` since 0018, but `owners.controller.ts` hard-codes the persona at
 * creation and nothing has ever updated it, so every console login in every
 * tenant has been an owner regardless of what the person actually does. This
 * controller is the write path that finding was describing.
 *
 * DELIBERATELY SEPARATE FROM `/v1/members`. That endpoint is the OPERATOR's
 * team self-service and writes `memberships.role`, the five-value operator
 * enum. 0018's header is explicit that the two must not be conflated: its
 * PATCH updates by user_id with no scope filter and can touch the very row
 * backing a live owner-console login, so reusing it would let an operator's
 * unrelated team edit silently regrade what somebody sees inside their own
 * console. Same table, two columns, two audiences, two routes.
 */
@Controller("owner/team")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
export class OwnerTeamController {
  constructor(
    private readonly db: DbService,
    private readonly accounts: OwnerAccountsService,
  ) {}

  /**
   * The roster. Owner and manager both read it - a manager needs to know who
   * is on the floor and which desk they are at, even though only an owner may
   * change it.
   */
  @Get()
  @RequireOwnerRole("owner", "manager")
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows: members } = await client.query(
        // DISTINCT ON collapses the workspace-scope rows a person may hold
        // alongside their org-scope one (members.controller.ts writes the
        // persona to all of them together), so the page lists one row per
        // human rather than one per membership. The org-scope row wins.
        `SELECT DISTINCT ON (u.id)
                u.id AS "userId", u.email, u.name,
                m.role, m.owner_role AS "ownerRole",
                m.recordings_listen AS "recordingsListen",
                m.recordings_export AS "recordingsExport",
                -- The staff record (0102). Suspension in particular belongs on
                -- the roster rather than being inferred from an absence: a
                -- suspended colleague still holds every lead they were working,
                -- and a page that simply stopped listing them would read as
                -- "removed" and prompt somebody to create a second login.
                m.status, m.staff_code AS "staffCode", m.phone, m.job_title AS "jobTitle",
                m.suspended_at AS "suspendedAt",
                m.role_id AS "roleId", r.name AS "roleName", r.key AS "roleKey",
                m.can_pair_devices AS "canPairDevices",
                t.id AS "telecallerId", t.display_name AS "telecallerName"
           FROM memberships m
           JOIN users u ON u.id = m.user_id
           LEFT JOIN roles r ON r.id = m.role_id
           LEFT JOIN telecallers t
             ON t.org_id = m.org_id AND t.user_id = m.user_id AND t.status = 'active'
          WHERE m.org_id = $1
          ORDER BY u.id, (m.scope_type = 'org') DESC, m.id`,
        [orgId],
      );

      // The identities a person can be bound to. Returned alongside the roster
      // rather than from a second endpoint because the Team page cannot offer
      // the binding without them, and two round trips for one screen is a
      // quarter-second on this deployment (Mumbai API, Seoul database).
      const { rows: telecallers } = await client.query(
        `SELECT t.id, t.display_name AS "displayName", t.external_id AS "externalId",
                t.user_id AS "userId"
           FROM telecallers t
          WHERE t.org_id = $1 AND t.status = 'active'
          ORDER BY t.display_name ASC`,
        [orgId],
      );

      // The permission roles a member can be moved to (0039), for the same
      // reason and at the same cost as the telecaller identities above. Active
      // only: an archived role is one the business has retired, and offering it
      // in a picker is how it gets un-retired by accident.
      const { rows: roles } = await client.query(
        `SELECT id, key, name, is_system AS "isSystem"
           FROM roles WHERE status = 'active'
          ORDER BY is_system DESC, name ASC`,
      );

      return {
        members: members.map((m) => ({ ...m, ownerRole: resolveOwnerRole(m.ownerRole) })),
        telecallers,
        roles,
      };
    });
  }

  /**
   * Change somebody's persona, and/or which telecaller identity they are.
   *
   * OWNER ONLY, not owner-or-manager. Persona assignment is the one action in
   * this console that changes what another person may see, and a manager who
   * could set personas could set their own to `owner` - or promote a
   * colleague, or demote the owner - which is a privilege-escalation path
   * dressed up as an ordinary team edit. Managers read the roster; owners
   * change it.
   */
  @Patch(":userId")
  @RequireOwnerRole("owner")
  async update(
    @OrgId() orgId: string,
    @Param("userId", ParseUUIDPipe) userId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = UpdateMemberBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    if (
      p.ownerRole === undefined &&
      p.telecallerId === undefined &&
      p.canPairDevices === undefined
    ) {
      throw new BadRequestException("no fields to update");
    }

    const actorId = req.principal?.userId ?? null;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [target],
      } = await client.query<{ owner_role: string | null }>(
        `SELECT owner_role FROM memberships
          WHERE user_id = $1 AND org_id = $2
          ORDER BY (scope_type = 'org') DESC, id
          LIMIT 1`,
        [userId, orgId],
      );
      if (!target) throw new NotFoundException("member not found in this org");

      if (p.ownerRole !== undefined) {
        await this.guardLastOwner(client, orgId, userId, target.owner_role, p.ownerRole);
      }

      // ── The persona ──────────────────────────────────────────────────
      //
      // Written to EVERY membership row this person holds in this org, not
      // just the org-scope one. A person may hold an org-scope row and
      // workspace-scope rows in the same tenant, and "this person is a
      // telecaller here" is a statement about the person, not about one of
      // their rows. `OwnerScopeGuard` reads whichever row sorts first, so
      // leaving the others behind would make the answer depend on which row
      // happened to be picked - the same reasoning members.controller.ts gives
      // for updating `role` across all of them.
      //
      // `org_id = $3` is defence in depth, not the primary control: RLS
      // already pins this statement to the current tenant. But a person's
      // membership set is inherently cross-org - the same user_id is the same
      // human in every tenant - so a future change that swapped `withOrg` for
      // `adminPool()` would otherwise regrade them everywhere at once, with a
      // 200 and no error. One line makes that impossible independently of the
      // database's configuration.
      if (p.ownerRole !== undefined) {
        await client.query(
          `UPDATE memberships SET owner_role = $1 WHERE user_id = $2 AND org_id = $3`,
          [p.ownerRole, userId, orgId],
        );
      }

      // ── The handset-pairing grant (migration 0096) ───────────────────
      //
      // Written to EVERY membership row this person holds in this org, for the
      // same reason the persona above is: a person may hold an org-scope row
      // and workspace-scope rows, "may pair a handset" is a statement about
      // the PERSON, and `capabilitiesFor` reads it with `bool_or` - so leaving
      // one row behind would make the answer depend on which row was read.
      //
      // `org_id = $3` is defence in depth exactly as it is above: RLS already
      // pins this to the current tenant, but a membership set is inherently
      // cross-org, and a future change swapping `withOrg` for `adminPool()`
      // would otherwise hand somebody this capability in every tenant at once.
      if (p.canPairDevices !== undefined) {
        await client.query(
          `UPDATE memberships SET can_pair_devices = $1 WHERE user_id = $2 AND org_id = $3`,
          [p.canPairDevices, userId, orgId],
        );
        await client.query(
          // Audited because it hands somebody the ability to add a device to
          // the tenant. "Who gave them that, and when" has to be answerable.
          `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
           VALUES ($1, 'user', $2, $3, 'user', $4)`,
          [
            orgId,
            actorId ?? "owner-console",
            p.canPairDevices ? "member.pairing_grant" : "member.pairing_revoke",
            userId,
          ],
        );
      }

      // ── The telecaller binding ───────────────────────────────────────
      //
      // `telecallers_org_user` (0017) is UNIQUE on (org_id, user_id) where
      // user_id IS NOT NULL, so a person cannot be two telecallers in one org.
      // Moving a binding therefore has to clear the old row first, in the same
      // transaction, or the second statement trips the constraint.
      // Shared with invite() - see bindTelecaller for the uniqueness handling.
      if (p.telecallerId !== undefined) {
        await this.bindTelecaller(orgId, userId, p.telecallerId);
      }

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, 'owner.team.update', 'user', $3, $4::jsonb)`,
        [
          orgId,
          actorId ?? "unknown",
          userId,
          JSON.stringify({ ...p, previousOwnerRole: target.owner_role }),
        ],
      );

      const {
        rows: [updated],
      } = await client.query(
        `SELECT DISTINCT ON (u.id)
                u.id AS "userId", u.email, u.name,
                m.role, m.owner_role AS "ownerRole",
                t.id AS "telecallerId", t.display_name AS "telecallerName"
           FROM memberships m
           JOIN users u ON u.id = m.user_id
           LEFT JOIN telecallers t
             ON t.org_id = m.org_id AND t.user_id = m.user_id AND t.status = 'active'
          WHERE m.org_id = $1 AND m.user_id = $2
          ORDER BY u.id, (m.scope_type = 'org') DESC, m.id`,
        [orgId, userId],
      );

      return { member: { ...updated, ownerRole: resolveOwnerRole(updated?.ownerRole) } };
    });
  }

  /**
   * Provision a colleague's login.
   *
   * OWNER ONLY, and here `@RequireOwnerRole` is REAL enforcement rather than a
   * courtesy: `OwnerRoleGuard` resolves the persona from `memberships` itself
   * (`AuthService.ownerRoleFor`) rather than believing the `x-caller-owner-role`
   * header, so a manager or telecaller reaching this route is refused by the
   * API regardless of what the web tier sends. That is the difference from
   * `/v1/org/policy`, which cannot tell console personas apart at all.
   *
   * NOTHING IS EMAILED. The generated password comes back in the response for
   * the owner to hand over however they choose. That is deliberate: this
   * platform does not put a message in a person's inbox because a form was
   * submitted, and an invite email would be exactly that.
   */
  @Post()
  @RequireOwnerRole("owner")
  async invite(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = InviteBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    const created = await this.accounts.createLogin(
      orgId,
      {
        email: p.email,
        name: p.name,
        ownerRole: p.ownerRole,
        // One rung below the console persona - see tenantRoleForOwnerRole for
        // why a telecaller must not be minted as org_admin.
        tenantRole: tenantRoleForOwnerRole(p.ownerRole),
        recordingsListen: p.recordingsListen,
        recordingsExport: p.recordingsExport,
      },
      { id: req.principal?.userId ?? "unknown", action: "owner.team.invite" },
    );

    // Bind the telecaller identity AFTER the membership exists, and only then:
    // an own-scoped persona with no identity sees an empty console, so the
    // invite and the binding belong to one action from the owner's point of
    // view even though they are two writes.
    if (p.telecallerId) {
      await this.bindTelecaller(orgId, created.owner.userId as string, p.telecallerId);
    }

    return created;
  }

  /**
   * Issue a fresh password for somebody who has forgotten theirs.
   *
   * Owner only, for the obvious reason: whoever can re-password an account can
   * sign in as it. Shown once, like the original.
   */
  @Post(":userId/password")
  @RequireOwnerRole("owner")
  async resetPassword(
    @OrgId() orgId: string,
    @Param("userId", ParseUUIDPipe) userId: string,
    @Req() req: PrincipalRequest,
  ) {
    return this.accounts.resetPassword(orgId, userId, {
      id: req.principal?.userId ?? "unknown",
      action: "owner.team.password_reset",
    });
  }

  /**
   * Remove somebody's access to this workspace.
   *
   * Two refusals, and they protect different things. The LAST OWNER check
   * stops the workspace being left with nobody who can administer it - the
   * same guard the persona edit uses. The SELF check stops an owner removing
   * their own access by misreading which row they were on; it is a usability
   * guard rather than a security one, since an owner who genuinely wants out
   * can promote a colleague and have them do it.
   */
  @Delete(":userId")
  @RequireOwnerRole("owner")
  async remove(
    @OrgId() orgId: string,
    @Param("userId", ParseUUIDPipe) userId: string,
    @Req() req: PrincipalRequest,
  ) {
    if (req.principal?.userId === userId) {
      throw new ForbiddenException(
        "you cannot remove your own access - ask another Owner to do it",
      );
    }

    const {
      rows: [target],
    } = await this.db.withOrg(orgId, (client) =>
      client.query<{ owner_role: string | null }>(
        `SELECT owner_role FROM memberships
          WHERE user_id = $1 AND org_id = $2
          ORDER BY (scope_type = 'org') DESC, id
          LIMIT 1`,
        [userId, orgId],
      ),
    );
    if (!target) throw new NotFoundException("member not found in this org");

    // Removing an owner is a demotion to nothing, so it has to clear the same
    // bar as demoting one: `guardLastOwner` refuses when this is the last.
    await this.db.withOrg(orgId, (client) =>
      this.guardLastOwner(client, orgId, userId, target.owner_role, "telecaller"),
    );

    return this.accounts.revoke(orgId, userId, {
      id: req.principal?.userId ?? "unknown",
      action: "owner.team.remove",
    });
  }

  /**
   * The employment record: staff code, phone, job title (migration 0102).
   *
   * Separate from `update()` above, which changes what somebody may SEE. These
   * three fields grant nothing at all, and keeping them on their own route is
   * what lets that be true by inspection rather than by reading a body parser -
   * a `jobTitle` that quietly widened access would be the worst possible way to
   * widen it.
   *
   * Owner only even so. It is the staff register of a business, and a manager
   * editing colleagues' employee codes is a decision to make deliberately
   * rather than to inherit from "manager sounds senior".
   */
  @Patch(":userId/profile")
  @RequireOwnerRole("owner")
  async updateProfile(
    @OrgId() orgId: string,
    @Param("userId", ParseUUIDPipe) userId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = StaffProfileInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    if (Object.keys(p).length === 0) throw new BadRequestException("no fields to update");

    return this.db.withOrg(orgId, async (client) => {
      // Empty string means CLEAR, not "store a blank". `memberships_org_staff_code`
      // is unique per org over non-null values, so a blank code stored as ''
      // would let exactly one person hold it and refuse the second with a
      // constraint error nobody could act on.
      const blank = (value: string | null | undefined) =>
        value === undefined ? null : value === null || value.trim() === "" ? null : value.trim();

      const { rowCount } = await client.query(
        `UPDATE memberships SET
           staff_code = CASE WHEN $3::boolean THEN $4 ELSE staff_code END,
           phone      = CASE WHEN $5::boolean THEN $6 ELSE phone END,
           job_title  = CASE WHEN $7::boolean THEN $8 ELSE job_title END,
           updated_at = now()
         WHERE user_id = $1 AND org_id = $2`,
        [
          userId,
          orgId,
          p.staffCode !== undefined,
          blank(p.staffCode),
          p.phone !== undefined,
          blank(p.phone),
          p.jobTitle !== undefined,
          blank(p.jobTitle),
        ],
      );
      if (rowCount === 0) throw new NotFoundException("member not found in this org");

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, 'owner.team.profile', 'user', $3, $4::jsonb)`,
        [orgId, req.principal?.userId ?? "unknown", userId, JSON.stringify(p)],
      );

      return { updated: true };
    });
  }

  /**
   * Suspend or reinstate somebody's access (migration 0102).
   *
   * ── WHY THIS EXISTS BESIDE `remove` ─────────────────────────────────────
   *
   * Until now the only way to stop a person signing in was DELETE, which
   * deletes their login outright. A rep who has resigned, is on notice, or is
   * on three months' leave needs the opposite of that: stop the access, keep
   * the person. Deleting them detaches nothing - every lead, call and follow-up
   * stays exactly where it was - but it does leave all of that attributed to an
   * account that no longer exists, and it cannot be undone.
   *
   * Suspension is one column and it is fully reversible.
   *
   * ── WHERE IT ACTUALLY BITES ─────────────────────────────────────────────
   *
   * `AuthService.contextFor` drops a suspended membership, so the console
   * cannot resolve an org for that session at all - which is the whole console,
   * because every page under /owner goes through `getOwner()`. `ownerRoleFor`
   * denies as well, so every `@RequireOwnerRole` route refuses even if a
   * request somehow got past the first gate. Two independent places, both
   * fail-closed.
   *
   * ── THE LAST-OWNER GUARD APPLIES ────────────────────────────────────────
   *
   * Suspending the last owner is demoting the last owner with extra steps: the
   * workspace is left with nobody who can reach this endpoint to undo it.
   * Reinstating is never guarded - it only ever widens.
   */
  @Post(":userId/suspend")
  @RequireOwnerRole("owner")
  async suspend(
    @OrgId() orgId: string,
    @Param("userId", ParseUUIDPipe) userId: string,
    @Req() req: PrincipalRequest,
  ) {
    if (req.principal?.userId === userId) {
      throw new ForbiddenException(
        "you cannot suspend your own access - ask another Owner to do it",
      );
    }
    return this.setStatus(orgId, userId, "suspended", req);
  }

  @Post(":userId/reinstate")
  @RequireOwnerRole("owner")
  async reinstate(
    @OrgId() orgId: string,
    @Param("userId", ParseUUIDPipe) userId: string,
    @Req() req: PrincipalRequest,
  ) {
    return this.setStatus(orgId, userId, "active", req);
  }

  /**
   * Assign the permission role whose grid applies to this person (0039's
   * `memberships.role_id`, finally written).
   *
   * ── WHAT THIS DOES NOT TOUCH ────────────────────────────────────────────
   *
   * `memberships.role` - the five-value tenant tier - stays exactly as it was.
   * That column is what `OrgRoleGuard` reads for API keys, the consent policy
   * and GDPR erasure, and it is the reason 0039 deferred assignment in the
   * first place: widening its CHECK to hold custom slugs would have put every
   * authorization call site in the blast radius.
   *
   * It never needed to. `CrmPermissionsGuard` joins
   * `r.id = m.role_id OR (m.role_id IS NULL AND r.key = m.role)`, so writing
   * `role_id` alone redefines what this person may do with CRM records and
   * changes nothing about the tenant tier. A custom role can narrow or reshape
   * object access; it cannot mint an API key.
   *
   * ── THE PERSONA STILL NARROWS ON TOP ────────────────────────────────────
   *
   * A telecaller given a role granting `deal:view` with scope `all` still reads
   * `owned`, because `CrmPermissionsGuard` intersects the grid with the
   * console persona and that composition only ever narrows. So this endpoint
   * cannot be used to hand somebody the whole floor's records by the back door.
   *
   * ── AND WHY THERE IS NO LOCKOUT ─────────────────────────────────────────
   *
   * An owner given a role with an empty grid loses the CRM object pages. They
   * do NOT lose this endpoint or the Roles page, because both are gated on the
   * persona rather than on the grid - see owner-roles.controller.ts. The repair
   * is always reachable from inside the console.
   */
  @Put(":userId/role")
  @RequireOwnerRole("owner")
  async assignRole(
    @OrgId() orgId: string,
    @Param("userId", ParseUUIDPipe) userId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = AssignRoleBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const roleId = parsed.data.roleId;

    return this.db.withOrg(orgId, async (client) => {
      if (roleId) {
        const {
          rows: [role],
        } = await client.query<{ status: string }>(`SELECT status FROM roles WHERE id = $1`, [
          roleId,
        ]);
        // RLS already pins `roles` to this org, so a role from another tenant
        // simply is not here - this refusal is about an ARCHIVED role, which is
        // one the business has retired and must not be assigned back into use.
        if (!role) throw new NotFoundException("role not found in this workspace");
        if (role.status !== "active") {
          throw new BadRequestException("that role is archived - reactivate it first");
        }
      }

      const { rowCount } = await client.query(
        // Every membership row this person holds in this org, for the same
        // reason `update()` writes the persona to all of them: "this person
        // holds this role here" is a statement about the person, and leaving
        // the workspace-scope rows behind would make the answer depend on which
        // row a guard's ORDER BY happened to pick.
        `UPDATE memberships SET role_id = $3, updated_at = now()
          WHERE user_id = $1 AND org_id = $2`,
        [userId, orgId, roleId],
      );
      if (rowCount === 0) throw new NotFoundException("member not found in this org");

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, 'owner.team.role_assign', 'user', $3, $4::jsonb)`,
        [orgId, req.principal?.userId ?? "unknown", userId, JSON.stringify({ roleId })],
      );

      return { roleId };
    });
  }

  /** Shared by suspend/reinstate - one write, one audit entry, one guard. */
  private async setStatus(
    orgId: string,
    userId: string,
    status: "active" | "suspended",
    req: PrincipalRequest,
  ) {
    const actorId = req.principal?.userId ?? null;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [target],
      } = await client.query<{ owner_role: string | null; status: string }>(
        `SELECT owner_role, status FROM memberships
          WHERE user_id = $1 AND org_id = $2
          ORDER BY (scope_type = 'org') DESC, id
          LIMIT 1`,
        [userId, orgId],
      );
      if (!target) throw new NotFoundException("member not found in this org");
      if (target.status === status) return { status };

      if (status === "suspended") {
        // Demoting to a persona that is not `owner` is exactly the check
        // `guardLastOwner` performs; "telecaller" here is a stand-in for "no
        // longer an owner", not a role anyone is being given.
        await this.guardLastOwner(client, orgId, userId, target.owner_role, "telecaller");
      }

      await client.query(
        `UPDATE memberships SET
           status = $3,
           suspended_at = CASE WHEN $3 = 'suspended' THEN now() ELSE NULL END,
           suspended_by = CASE WHEN $3 = 'suspended' THEN $4::uuid ELSE NULL END,
           updated_at = now()
         WHERE user_id = $1 AND org_id = $2`,
        [userId, orgId, status, actorId],
      );

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, $3, 'user', $4, $5::jsonb)`,
        [
          orgId,
          actorId ?? "unknown",
          status === "suspended" ? "owner.team.suspend" : "owner.team.reinstate",
          userId,
          JSON.stringify({ previousStatus: target.status }),
        ],
      );

      return { status };
    });
  }

  /**
   * Point a person at a telecaller identity, clearing whatever they had.
   *
   * Shared by `update()` and `invite()` so the uniqueness handling exists once
   * - `telecallers_org_user` (0017) is UNIQUE per org, so moving a binding must
   * clear the old row first or the second statement trips the constraint.
   */
  private async bindTelecaller(orgId: string, userId: string, telecallerId: string | null) {
    return this.db.withOrg(orgId, async (client) => {
      await client.query(
        `UPDATE telecallers SET user_id = NULL, updated_at = now()
          WHERE org_id = $1 AND user_id = $2`,
        [orgId, userId],
      );
      if (!telecallerId) return;
      const { rowCount } = await client.query(
        // Refuses to steal an identity that belongs to somebody else: two
        // logins resolving to one telecaller row would show each of them the
        // other's leads.
        `UPDATE telecallers SET user_id = $3, updated_at = now()
          WHERE id = $1 AND org_id = $2 AND (user_id IS NULL OR user_id = $3)`,
        [telecallerId, orgId, userId],
      );
      if (rowCount === 0) {
        throw new BadRequestException(
          "that telecaller identity does not exist here, or is already bound to someone else",
        );
      }
    });
  }

  /**
   * Refuse the edit that locks everyone out.
   *
   * An org with no `owner` persona has nobody who can reach this endpoint to
   * undo it - `@RequireOwnerRole("owner")` above is the only door, and
   * demoting the last owner closes it from the inside. Recovery would mean an
   * operator running SQL against production, which is exactly the class of
   * incident worth one extra SELECT to avoid.
   *
   * Counted from `memberships`, not from the caller's own persona: the caller
   * might be demoting somebody else, and "am I the last owner" is not the
   * question - "will this org still have one" is.
   *
   * NULL counts as an owner. `resolveOwnerRole(null)` is `owner` by 0018's
   * documented fail-open, so a membership that predates personas IS an owner
   * in every code path that reads one; counting only literal 'owner' strings
   * here would let the last real owner be demoted while the console still
   * behaved as though somebody held the role.
   */
  private async guardLastOwner(
    client: { query: (sql: string, params: unknown[]) => Promise<{ rows: { owners: number }[] }> },
    orgId: string,
    userId: string,
    currentRole: string | null,
    nextRole: OwnerRole,
  ): Promise<void> {
    if (nextRole === "owner") return;
    if (resolveOwnerRole(currentRole) !== "owner") return;

    const {
      rows: [count],
    } = await client.query(
      `SELECT count(DISTINCT user_id)::int AS owners
         FROM memberships
        WHERE org_id = $1 AND (owner_role IS NULL OR owner_role = 'owner')`,
      [orgId],
    );

    if ((count?.owners ?? 0) <= 1) {
      throw new ForbiddenException(
        "this is the workspace's last owner - promote somebody else to Owner first",
      );
    }
  }
}
