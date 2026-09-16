import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { OwnerRole, resolveOwnerRole } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

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
   * May this person pair a handset? (migration 0096)
   *
   * OWNER-granted, per person - the route is already `@RequireOwnerRole("owner")`
   * so a manager cannot hand the capability to themselves or to anybody else.
   * Setting it on an owner is accepted and inert: `canPairDevices()` returns
   * true for that persona whatever the column says, because a tenant must never
   * reach a state where nobody can pair a phone.
   */
  canPairDevices: z.boolean().optional(),
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
  constructor(private readonly db: DbService) {}

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
                m.can_pair_devices AS "canPairDevices",
                t.id AS "telecallerId", t.display_name AS "telecallerName"
           FROM memberships m
           JOIN users u ON u.id = m.user_id
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

      return {
        members: members.map((m) => ({ ...m, ownerRole: resolveOwnerRole(m.ownerRole) })),
        telecallers,
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
      if (p.telecallerId !== undefined) {
        await client.query(
          `UPDATE telecallers SET user_id = NULL, updated_at = now()
            WHERE org_id = $1 AND user_id = $2`,
          [orgId, userId],
        );
        if (p.telecallerId) {
          const { rowCount } = await client.query(
            // `user_id IS NULL OR user_id = $3` refuses to steal an identity
            // that already belongs to somebody else: two console logins
            // resolving to one telecaller row would show each of them the
            // other's leads, which is the exact failure this whole change
            // exists to prevent.
            `UPDATE telecallers SET user_id = $3, updated_at = now()
              WHERE id = $1 AND org_id = $2 AND (user_id IS NULL OR user_id = $3)`,
            [p.telecallerId, orgId, userId],
          );
          if (rowCount === 0) {
            throw new BadRequestException(
              "that telecaller identity does not exist here, or is already bound to someone else",
            );
          }
        }
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
