import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  CallEscalationRoutingInput,
  CallEscalationSettingsInput,
  type CallEscalationSettingsView,
  isEscalationAdminRole,
  resolveOwnerRole,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { isCheckViolation } from "../../common/pg-errors";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import {
  CallEscalationsService,
  LIVE_SQL,
  type Queryable,
  resolveRouting,
  ROUTING_COLUMNS,
  ROUTING_JOINS,
  type RoutingRow,
  userNameSql,
} from "./call-escalations.service";

const INVALID_TARGET = {
  code: "invalid_escalation_target",
  message:
    "A telecaller can only escalate to an active owner, manager or senior of this workspace - and not to themselves.",
};

interface SettingsRow {
  enabled: boolean;
  viewer_member: boolean;
  viewer_role: string | null;
  live_count: number;
  telecallers: Array<RoutingRow & { has_login: boolean }> | null;
  members: Array<{ membershipId: string; userId: string; name: string | null; ownerRole: string | null; senior: boolean }> | null;
}

/**
 * Call escalation settings (migration 0151, Build docs/38): the workspace
 * switch, who is a senior, and who each telecaller escalates to.
 *
 * Owner and manager at class level - the console's Settings > Escalations page.
 * The SWITCH is owner-only (`PUT /`): turning the feature on or off decides
 * whether telecallers may hand calls up at all, which is the business's call,
 * the same tier as call access (0122). Routing is a manager's day-to-day job.
 *
 * Every change wakes the affected phones with `config_refresh`, so "Escalate
 * to <name>" appears, disappears or renames itself now rather than on the
 * next poll.
 */
@Controller("owner/call-escalation-settings")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
@RequireOwnerRole("owner", "manager")
export class OwnerCallEscalationSettingsController {
  constructor(
    private readonly db: DbService,
    private readonly escalations: CallEscalationsService,
  ) {}

  @Get()
  async get(@Req() req: PrincipalRequest, @OrgId() orgId: string): Promise<CallEscalationSettingsView> {
    return this.db.withOrg(orgId, (client) => this.readSettings(client, orgId, req));
  }

  /** The workspace switch. Owner only. Returns the settings view. */
  @Put()
  @RequireOwnerRole("owner")
  async putSettings(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Body() body: unknown,
  ): Promise<CallEscalationSettingsView> {
    const parsed = CallEscalationSettingsInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { enabled } = parsed.data;
    const actor = auditActor(req);

    const out = await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<{ was: boolean }>(
        // One statement: the old value (every CTE reads the same snapshot, so
        // `before` sees the row as it was), the write, and its audit row.
        // Separate params for `org_id` (uuid) and `target_id` (text) - one $N
        // spanning both types throws 42P08.
        `WITH before AS (
           SELECT call_escalation_enabled AS was FROM organizations WHERE id = $1::uuid
         ),
         upd AS (
           UPDATE organizations SET call_escalation_enabled = $2::boolean, updated_at = now()
            WHERE id = $1::uuid
           RETURNING 1
         ),
         au AS (
           INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
           SELECT $1::uuid, $3::text, $4::text, 'call_escalation.settings_update', 'organization', $5::text,
                  jsonb_build_object('before', before.was, 'after', $2::boolean)
             FROM before
           RETURNING 1
         )
         SELECT before.was FROM before`,
        [orgId, enabled, actor.type, actor.id, orgId],
      );
      if (!row) throw new NotFoundException("organization not found");
      // Every bound phone: the block appears or disappears for all of them.
      const tokens = row.was !== enabled ? await this.escalations.configTokens(client, { all: true }) : [];
      return { view: await this.readSettings(client, orgId, req), tokens };
    });
    this.escalations.pushConfigRefresh(out.tokens);
    return out.view;
  }

  /**
   * Seniors and per-telecaller recipients. Only the rows sent are touched.
   *
   * Seniors are written FIRST, so one request can mark somebody a senior and
   * point a telecaller at them. Un-marking a senior who is not also an owner or
   * manager clears every `escalate_to_membership_id` pointing at them - those
   * telecallers fall back to their manager, then the pool. A pointer the
   * migration's guard trigger refuses (not an owner, manager or senior of this
   * workspace, or the telecaller themselves) is a 400. Returns the settings
   * view.
   */
  @Put("routing")
  async putRouting(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Body() body: unknown,
  ): Promise<CallEscalationSettingsView> {
    const parsed = CallEscalationRoutingInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    // Last entry wins for an id sent twice.
    const pointers = new Map<string, string | null>();
    for (const t of parsed.data.telecallers ?? []) pointers.set(t.telecallerId, t.escalateToMembershipId);
    const seniors = new Map<string, boolean>();
    for (const s of parsed.data.seniors ?? []) seniors.set(s.membershipId, s.senior);
    const telecallerIds = [...pointers.keys()];
    const seniorIds = [...seniors.keys()];
    const targetIds = [...new Set([...pointers.values()].filter((v): v is string => v !== null))];
    const actor = auditActor(req);

    const out = await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [check],
      } = await client.query<{ telecallers_found: number; members_found: number; targets_active: number }>(
        `SELECT (SELECT count(*)::int FROM telecallers
                  WHERE org_id = $4::uuid AND id = ANY($1::uuid[]) AND status = 'active') AS telecallers_found,
                (SELECT count(*)::int FROM memberships
                  WHERE org_id = $4::uuid AND id = ANY($2::uuid[])) AS members_found,
                (SELECT count(*)::int FROM memberships m JOIN users u ON u.id = m.user_id
                  WHERE m.org_id = $4::uuid AND m.id = ANY($3::uuid[])
                    AND m.status = 'active' AND u.status = 'active') AS targets_active`,
        [telecallerIds, seniorIds, targetIds, orgId],
      );
      if (check.telecallers_found !== telecallerIds.length) {
        throw new NotFoundException("one or more telecallers were not found, or are archived");
      }
      if (check.members_found !== seniorIds.length) throw new NotFoundException("one or more members were not found");
      if (check.targets_active !== targetIds.length) throw new BadRequestException(INVALID_TARGET);

      let changedSeniors: string[] = [];
      let cleared: string[] = [];
      if (seniorIds.length > 0) {
        const {
          rows: [s],
        } = await client.query<{ changed: string[] | null; cleared: string[] | null }>(
          `WITH s AS (
             UPDATE memberships m SET escalation_senior = x.senior
               FROM jsonb_to_recordset($1::jsonb) AS x(membership_id uuid, senior boolean)
              WHERE m.id = x.membership_id AND m.escalation_senior IS DISTINCT FROM x.senior
             RETURNING m.id, m.escalation_senior, m.owner_role
           ),
           cleared AS (
             UPDATE telecallers t SET escalate_to_membership_id = NULL
               FROM s
              WHERE t.escalate_to_membership_id = s.id
                AND NOT s.escalation_senior
                AND COALESCE(s.owner_role, 'owner') NOT IN ('owner', 'manager')
             RETURNING t.id
           )
           SELECT (SELECT array_agg(id) FROM s) AS changed,
                  (SELECT array_agg(id) FROM cleared) AS cleared`,
          [JSON.stringify(seniorIds.map((id) => ({ membership_id: id, senior: seniors.get(id) })))],
        );
        changedSeniors = s?.changed ?? [];
        cleared = s?.cleared ?? [];
      }

      if (telecallerIds.length > 0) {
        try {
          await client.query(
            `UPDATE telecallers t SET escalate_to_membership_id = x.m
               FROM jsonb_to_recordset($1::jsonb) AS x(telecaller_id uuid, m uuid)
              WHERE t.id = x.telecaller_id`,
            [JSON.stringify(telecallerIds.map((id) => ({ telecaller_id: id, m: pointers.get(id) ?? null })))],
          );
        } catch (err) {
          // telecaller_escalate_to_guard (0151) raises 23514.
          if (isCheckViolation(err)) throw new BadRequestException(INVALID_TARGET);
          throw err;
        }
      }

      // The audit row, and the phones whose "Escalate to <name>" may have
      // changed - the telecallers touched or cleared, and whoever points at a
      // senior whose flag moved - in one statement. No phone is woken while
      // the switch is off: none of them shows the item anyway.
      const { rows: phones } = await client.query<{ fcm_token: string }>(
        `WITH au AS (
           INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
           VALUES ($3::uuid, $4::text, $5::text, 'call_escalation.routing_update', 'organization', $6::text, $7::jsonb)
           RETURNING 1
         )
         SELECT DISTINCT d.fcm_token
           FROM devices d
           JOIN telecallers t ON t.id = d.telecaller_id AND t.status = 'active'
          WHERE d.status = 'active' AND d.removed_at IS NULL AND d.fcm_token IS NOT NULL
            AND (SELECT o.call_escalation_enabled FROM organizations o WHERE o.id = $3::uuid)
            AND (t.id = ANY($1::uuid[]) OR t.escalate_to_membership_id = ANY($2::uuid[]))`,
        [
          [...new Set([...telecallerIds, ...cleared])],
          changedSeniors,
          orgId,
          actor.type,
          actor.id,
          orgId,
          JSON.stringify({
            telecallers: telecallerIds.map((id) => ({ telecallerId: id, escalateToMembershipId: pointers.get(id) ?? null })),
            seniors: seniorIds.map((id) => ({ membershipId: id, senior: seniors.get(id) })),
            clearedPointers: cleared,
          }),
        ],
      );
      return { view: await this.readSettings(client, orgId, req), tokens: phones.map((p) => p.fcm_token) };
    });
    this.escalations.pushConfigRefresh(out.tokens);
    return out.view;
  }

  /**
   * The whole page in ONE statement: the switch, the viewer's persona (from
   * `memberships`, never a header), the live count, every active telecaller's
   * routing and every active member.
   */
  private async readSettings(client: Queryable, orgId: string, req: PrincipalRequest): Promise<CallEscalationSettingsView> {
    const viewer = z.string().uuid().safeParse(req.principal?.userId);
    const {
      rows: [row],
    } = await client.query<SettingsRow>(
      `SELECT o.call_escalation_enabled AS enabled,
              EXISTS (SELECT 1 FROM memberships vm
                       WHERE vm.org_id = o.id AND vm.user_id = $2::uuid) AS viewer_member,
              (SELECT vm.owner_role FROM memberships vm
                WHERE vm.org_id = o.id AND vm.user_id = $2::uuid
                ORDER BY (vm.scope_type = 'org') DESC, vm.id LIMIT 1) AS viewer_role,
              (SELECT count(*)::int FROM call_escalations ce
                WHERE ce.org_id = o.id AND ce.status IN (${LIVE_SQL})) AS live_count,
              (SELECT json_agg(x ORDER BY lower(x.tc_name), x.tc_id) FROM (
                 SELECT ${ROUTING_COLUMNS},
                        (t.user_id IS NOT NULL AND EXISTS (
                           SELECT 1 FROM memberships lm JOIN users lu ON lu.id = lm.user_id
                            WHERE lm.org_id = o.id AND lm.user_id = t.user_id
                              AND lm.status = 'active' AND lu.status = 'active')) AS has_login
                   FROM telecallers t
                   ${ROUTING_JOINS}
                  WHERE t.org_id = o.id AND t.status = 'active') x) AS telecallers,
              (SELECT json_agg(json_build_object(
                        'membershipId', a.id, 'userId', a.user_id, 'name', a.name,
                        'ownerRole', a.owner_role, 'senior', a.escalation_senior)
                      ORDER BY lower(a.name), a.id)
                 FROM (SELECT DISTINCT ON (m.user_id) m.id, m.user_id, ${userNameSql("u")} AS name,
                              m.owner_role, m.escalation_senior
                         FROM memberships m JOIN users u ON u.id = m.user_id
                        WHERE m.org_id = o.id AND m.status = 'active' AND u.status = 'active'
                        ORDER BY m.user_id, (m.scope_type = 'org') DESC, m.id) a) AS members
         FROM organizations o
        WHERE o.id = $1::uuid`,
      [orgId, viewer.success ? viewer.data : null],
    );
    if (!row) throw new NotFoundException("organization not found");

    return {
      enabled: row.enabled === true,
      // OwnerRoleGuard already refused anyone below manager; of those, only an
      // owner may flip the switch.
      canEditSwitch: row.viewer_member === true && resolveOwnerRole(row.viewer_role) === "owner",
      canEditRouting: true,
      liveCount: row.live_count ?? 0,
      telecallers: (row.telecallers ?? []).map((t) => ({
        telecallerId: t.tc_id as string,
        name: t.tc_name ?? "",
        hasLogin: t.has_login === true,
        escalateToMembershipId: t.et_id,
        reportsToMembershipId: t.rt_id,
        reportsToName: t.rt_id ? (t.rt_name ?? null) : null,
        effectiveRecipientName: resolveRouting(t).name,
      })),
      members: (row.members ?? []).map((m) => ({
        membershipId: m.membershipId,
        userId: m.userId,
        name: m.name ?? "",
        ownerRole: resolveOwnerRole(m.ownerRole),
        senior: m.senior === true,
        canReceive: isEscalationAdminRole(m.ownerRole) || m.senior === true,
      })),
    };
  }
}
