import { createHash, randomBytes } from "node:crypto";
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { canPairDevices, canRevokeDevices, resolveOwnerRole } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { FcmService } from "../../fcm/fcm.service";
import { lockDevice, restoreDevice } from "./device-rebind";

/**
 * The client's own handsets: see them, pair a new one, retire an old one
 * (migration 0107).
 *
 * ── WHY THIS EXISTS BESIDE InstancesController ────────────────────────────
 *
 * `POST /instances/:id/keys` already mints enrollment tokens, and it is the
 * OPERATOR's surface: it takes a configurable TTL and use-count because bulk
 * and MDM enrolment need them, and it is reached with the bare platform admin
 * key. It is deliberately not reused here.
 *
 * A client pairing one phone in their hand needs the opposite of configurable:
 * ten minutes, one use, no choices. Those are constants below rather than
 * request fields, so the narrow surface cannot be widened by whoever calls it.
 *
 * ── THE PERMISSION IS READ FROM `memberships`, NOT FROM THE REQUEST ───────
 *
 * `@RequireOwnerRole` cannot express this gate: pairing is a per-PERSON
 * capability an owner hands out (0107), not a persona. So the guard admits
 * every console persona and the capability is checked INSIDE the handler,
 * against `memberships.can_pair_devices`.
 *
 * That is the same shape `owner-calls.controller.ts` uses for
 * `recordings_listen`, and for the same reason: the owner console arrives on
 * the platform admin key, so the flag cannot come from the principal and has
 * to be read from the row. Reading it from the request would mean a caller
 * asserting their own permission.
 *
 * ── THE TOKEN IS A CREDENTIAL ─────────────────────────────────────────────
 *
 * Whoever holds a live enrollment token can put a device into this tenant.
 * Hence: one use, ten minutes, hashed at rest (the raw value exists only in
 * the response body), every mint written to `audit_log` with the person who
 * asked, and the device list below so an owner can see what appeared.
 */

/**
 * Not request fields. See the header: a client pairing one phone needs no
 * choices, and a constant cannot be widened by a caller.
 */
const PAIRING_TTL_MINUTES = 10;
const PAIRING_MAX_USES = 1;

const MintBody = z.object({
  /**
   * Which instance the handset joins. Optional: a tenant with exactly one
   * instance - which is nearly all of them - should not be asked to choose,
   * and the resolver below picks it when there is no ambiguity.
   */
  instanceId: z.string().uuid().optional(),
});
// Deliberately no `label`: the handset supplies its own at registration, and
// an accepted-but-ignored field reads as supported.

@Controller("owner/devices")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
// Every console persona, because the real gate is the per-person capability
// checked in the handlers. Mounting the guard with the full list rather than
// omitting the decorator is deliberate: it keeps this controller inside the
// OWNER_ROLE_ROUTES inventory that guard-mounting.spec.ts pins, so a future
// route added here cannot quietly escape the persona check entirely.
@RequireOwnerRole("owner", "manager", "telecaller", "sales", "marketing")
export class OwnerDevicesController {
  constructor(
    private readonly db: DbService,
    private readonly fcm: FcmService,
  ) {}

  /**
   * This tenant's handsets.
   *
   * Readable by every persona: a telecaller seeing which phone is theirs and
   * whether it has checked in recently is support-desk information, not a
   * privileged view. Nothing here is a credential - the tokens are hashed and
   * never returned.
   */
  @Get()
  async list(@OrgId() orgId: string, @Req() req: PrincipalRequest) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows: devices } = await client.query(
        `SELECT d.id, d.label, d.status, d.os_version AS "osVersion",
                d.app_version AS "appVersion", d.capture_capability AS "captureCapability",
                d.created_at AS "pairedAt",
                d.removed_at AS "removedAt",
                d.relinked_at AS "relinkedAt",
                -- Whether a reinstall of this phone can come back by itself
                -- (0130). False for every handset still on a build older than
                -- 1.1.6, which is what an owner needs to know before relying
                -- on it.
                (d.recovery_secret_hash IS NOT NULL) AS "selfRecovery",
                i.name AS "instanceName",
                t.display_name AS "telecallerName",
                (SELECT max(c.started_at) FROM calls c WHERE c.device_id = d.id) AS "lastCallAt",
                (SELECT count(*)::int FROM calls c WHERE c.device_id = d.id) AS "callCount"
           FROM devices d
           JOIN instances i ON i.id = d.instance_id
           LEFT JOIN telecallers t ON t.id = d.telecaller_id
          WHERE d.org_id = $1
          ORDER BY d.status = 'active' DESC, d.created_at DESC`,
        [orgId],
      );

      // The instances a new handset could join, so the console can skip the
      // question when there is only one.
      const { rows: instances } = await client.query(
        `SELECT id, name FROM instances WHERE org_id = $1 ORDER BY created_at ASC`,
        [orgId],
      );

      // What THIS caller may do, so the console renders the right buttons
      // rather than offering an action the API will refuse.
      const caller = await this.capabilitiesFor(client, orgId, req);
      return { devices, instances, canPair: caller.canPair, canRevoke: caller.canRevoke };
    });
  }

  /**
   * Mint a one-time pairing token. The raw value is returned once and never
   * again - only its SHA-256 is stored, exactly as `POST /instances/:id/keys`
   * does.
   */
  @Post("pairing-token")
  async mint(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = MintBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      if (!(await this.capabilitiesFor(client, orgId, req)).canPair) {
        throw new ForbiddenException(
          "you do not have permission to pair a handset - ask an owner to grant it on the Team page",
        );
      }

      const instanceId = await this.resolveInstance(client, orgId, parsed.data.instanceId);

      const rawToken = randomBytes(32).toString("base64url");
      const tokenHash = createHash("sha256").update(rawToken).digest("hex");

      const {
        rows: [token],
      } = await client.query<{ id: string; expires_at: string }>(
        `INSERT INTO enrollment_tokens (org_id, instance_id, token_hash, expires_at, max_uses)
         VALUES ($1, $2, $3, now() + make_interval(mins => $4), $5)
         RETURNING id, expires_at`,
        [orgId, instanceId, tokenHash, PAIRING_TTL_MINUTES, PAIRING_MAX_USES],
      );

      await client.query(
        // Names the PERSON, not "owner-console": the whole point of delegating
        // this is being able to answer "who added that handset".
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'device.pairing_token.create', 'instance', $3)`,
        [orgId, req.principal?.userId ?? "owner-console", instanceId],
      );

      return {
        // The row id, not the secret. The dialog watches this pairing with it
        // (`GET pairing-token/:id`); on its own it enrols nothing, because
        // `/devices/register` matches on the token HASH.
        pairingId: token.id,
        instanceId,
        // The field is named `adminKey` because that is what the handset's
        // activation screen and `EnrollmentCredentials`' QR payload already
        // call it (`v: 1`). Renaming it here would break the scanner for a
        // cosmetic gain.
        adminKey: rawToken,
        expiresAt: token.expires_at,
        maxUses: PAIRING_MAX_USES,
      };
    });
  }

  /**
   * Has a phone used this pairing code yet?
   *
   * What the pairing dialog asks while its QR is on screen - on every `device`
   * change signal, and on a slow timer in case the signal never arrives. The
   * answer is one of three states, and `paired` wins over `expired`: a phone
   * that enrolled at minute nine is paired, whatever the clock says now.
   *
   * ── NO CAPABILITY CHECK, ON PURPOSE ─────────────────────────────────────
   *
   * Unlike `mint`, this does not read `can_pair_devices`. It creates nothing,
   * and what it can return - a handset's label, its instance, when it joined -
   * is a subset of `GET /owner/devices`, which every persona may already read.
   * Gating it would cost a second round trip to the database on every tick of
   * a dialog that only a person allowed to pair could have opened anyway.
   *
   * The answer is read from `devices.enrollment_token_id` (0124), never from
   * "a device appeared on this instance recently": two people pairing two
   * phones on the same desk would otherwise each see the other's handset.
   */
  @Get("pairing-token/:id")
  async pairingStatus(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<{
        expires_at: string;
        expired: boolean;
        instance_name: string;
        device_id: string | null;
        label: string | null;
        paired_at: string | null;
        recovered: boolean | null;
        telecaller_name: string | null;
        call_count: number | null;
      }>(
        // `recovered` (0130): the row is older than the code, so this code
        // brought an existing handset back rather than adding one. Ordered by
        // `enrollment_token_id` alone would not say which - a rebind rewrites
        // that column onto an old row, and its created_at stays where it was.
        `SELECT t.expires_at, t.expires_at <= now() AS expired,
                i.name AS instance_name,
                d.id AS device_id, d.label,
                COALESCE(d.relinked_at, d.created_at) AS paired_at,
                d.created_at < t.created_at AS recovered,
                d.telecaller_name,
                d.call_count
           FROM enrollment_tokens t
           JOIN instances i ON i.id = t.instance_id
           LEFT JOIN LATERAL (
             SELECT dv.id, dv.label, dv.created_at, dv.relinked_at,
                    COALESCE(tc.display_name, dv.telecaller_name) AS telecaller_name,
                    (SELECT count(*)::int FROM calls c WHERE c.device_id = dv.id) AS call_count
               FROM devices dv
               LEFT JOIN telecallers tc ON tc.id = dv.telecaller_id
              WHERE dv.enrollment_token_id = t.id
              ORDER BY dv.created_at DESC
              LIMIT 1
           ) d ON true
          WHERE t.id = $1 AND t.org_id = $2`,
        [id, orgId],
      );
      if (!row) throw new NotFoundException("no such pairing in this workspace");

      if (row.device_id) {
        return {
          state: "paired" as const,
          expiresAt: row.expires_at,
          device: {
            id: row.device_id,
            label: row.label,
            instanceName: row.instance_name,
            pairedAt: row.paired_at,
            recovered: row.recovered === true,
            telecallerName: row.telecaller_name,
            callCount: row.call_count ?? 0,
          },
        };
      }
      return {
        state: row.expired ? ("expired" as const) : ("waiting" as const),
        expiresAt: row.expires_at,
      };
    });
  }

  /**
   * Retire a handset. Owner and manager only, and NOT delegable - see 0107.
   *
   * `logged_out` rather than a delete: the device's calls, leads and
   * attribution all point at this row, and removing it would orphan a
   * telecaller's entire history. The handset is refused at its next
   * authentication, which is what "retired" means operationally.
   */
  @Post(":id/revoke")
  @RequireOwnerRole("owner", "manager")
  async revoke(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [device],
      } = await client.query<{ id: string; label: string | null }>(
        `UPDATE devices SET status = 'logged_out'
          WHERE id = $1 AND org_id = $2 AND status <> 'wiped'
          RETURNING id, label`,
        [id, orgId],
      );
      if (!device) throw new NotFoundException("no such handset in this workspace");

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'device.revoke', 'device', $3)`,
        [orgId, req.principal?.userId ?? "owner-console", id],
      );
      return { revoked: true };
    });
  }

  /**
   * Bring a retired handset back (0130) - the "I retired the wrong phone" undo.
   *
   * Owner and manager only, the same tier as retiring: whoever may take a phone
   * off the floor may put it back, and a delegated pairer may not, because
   * restoring a wiped phone is the one action here that re-arms a handset an
   * owner may have written off as stolen.
   *
   * Nothing on the phone has to happen. It still holds its key; its next check-in
   * succeeds, and the push below makes that check-in happen now rather than at
   * the next hourly poll. If the app has since been uninstalled, restoring does
   * no harm - re-pairing that phone then lands on this same row.
   */
  @Post(":id/restore")
  @RequireOwnerRole("owner", "manager")
  async restore(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    const restored = await this.db.withOrg(orgId, async (client) => {
      const result = await restoreDevice(client, id);
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, 'device.restore', 'device', $3, $4)`,
        [
          orgId,
          req.principal?.userId ?? "owner-console",
          id,
          JSON.stringify({ previousStatus: result.previousStatus, wasRemoved: result.wasRemoved }),
        ],
      );
      return result;
    });
    return { ...restored, woken: await this.wake(orgId, id) };
  }

  /**
   * A pairing code bound to ONE existing handset (0130).
   *
   * For the phone that cannot find its own way back: factory-reset, re-flashed
   * from a debug build to the release one (a different signing key changes the
   * hardware id), or replaced outright for the same telecaller. Whatever phone
   * scans this takes the named row over - its id, its telecaller, its history -
   * and the phone that held it before is signed out at its next check-in.
   *
   * That last clause is why this is owner-or-manager and not merely `canPair`.
   * Pairing adds a handset; this moves a person's identity onto a different
   * phone, which is the same weight as retiring one.
   *
   * Same shape and the same constants as `pairing-token`, so the console's
   * pairing dialog (which watches `GET pairing-token/:id`) needs no second mode.
   */
  @Post(":id/relink-token")
  @RequireOwnerRole("owner", "manager")
  async relinkToken(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const device = await lockDevice(client, id);
      if (!device) throw new NotFoundException("no such handset in this workspace");

      const rawToken = randomBytes(32).toString("base64url");
      const tokenHash = createHash("sha256").update(rawToken).digest("hex");
      const {
        rows: [token],
      } = await client.query<{ id: string; expires_at: string }>(
        `INSERT INTO enrollment_tokens
           (org_id, instance_id, token_hash, expires_at, max_uses, relink_device_id)
         VALUES ($1, $2, $3, now() + make_interval(mins => $4), $5, $6)
         RETURNING id, expires_at`,
        [orgId, device.instance_id, tokenHash, PAIRING_TTL_MINUTES, PAIRING_MAX_USES, id],
      );

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, 'device.relink_token.create', 'device', $3, $4)`,
        [
          orgId,
          req.principal?.userId ?? "owner-console",
          id,
          JSON.stringify({ status: device.status, instanceId: device.instance_id }),
        ],
      );

      return {
        pairingId: token.id,
        instanceId: device.instance_id,
        adminKey: rawToken,
        expiresAt: token.expires_at,
        maxUses: PAIRING_MAX_USES,
        relinkDeviceId: id,
      };
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /**
   * Push a config refresh so a restored phone re-enables now, not at its next
   * hourly poll. Best-effort, and never throws: the restore has already
   * committed, and a push that could not be sent must not turn a completed undo
   * into a 500 that invites a second one. Same contract as the operator
   * controller's pushConfigRefresh.
   */
  private async wake(orgId: string, deviceId: string): Promise<boolean> {
    try {
      const {
        rows: [device],
      } = await this.db.withOrg(orgId, (client) =>
        client.query<{ fcm_token: string | null }>(
          "SELECT fcm_token FROM devices WHERE id = $1",
          [deviceId],
        ),
      );
      if (!device?.fcm_token) return false;
      return await this.fcm.sendToDevice(device.fcm_token, { action: "config_refresh" });
    } catch {
      return false;
    }
  }

  /**
   * What this caller may do, derived from `memberships` alone.
   *
   * ── WHY THE PERSONA IS RE-READ HERE RATHER THAN TAKEN FROM THE PRINCIPAL ──
   *
   * The owner console reaches the API on the platform admin key with the
   * caller's persona in an `x-caller-owner-role` header. `AdminKeyGuard` still
   * parses that into `principal.ownerRole`, but checklist 08 §2.5 closed the
   * hole where anything TRUSTED it: an admin-key holder could assert `owner`
   * and be believed. `OwnerRoleGuard` now derives the persona from this table
   * instead, and so must every in-handler check - otherwise the gate the guard
   * cannot express (a per-person capability) would be the one place the old
   * bypass still worked.
   *
   * One query for both, because the persona and the grant live in the same
   * row and asking twice would be two round trips to Seoul for one answer.
   */
  private async capabilitiesFor(
    client: { query: <R>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> },
    orgId: string,
    req: PrincipalRequest,
  ): Promise<{ canPair: boolean; canRevoke: boolean }> {
    const userId = z.string().uuid().safeParse(req.principal?.userId);
    // No user behind the credential - the bare admin key - has no membership
    // to read, and so holds no delegated capability. Denying is correct: a
    // capability handed to a PERSON cannot be exercised by nobody.
    if (!userId.success) return { canPair: false, canRevoke: false };

    const { rows } = await client.query<{
      owner_role: string | null;
      can_pair_devices: boolean;
    }>(
      // A person may hold an org-scope row and workspace-scope rows; the team
      // controller writes both the persona and the grant to all of them
      // together, so `bool_or` and the org-scope-first ordering agree.
      `SELECT owner_role, bool_or(can_pair_devices) OVER () AS can_pair_devices
         FROM memberships
        WHERE user_id = $1 AND org_id = $2
        ORDER BY (scope_type = 'org') DESC, id
        LIMIT 1`,
      [userId.data, orgId],
    );
    if (rows.length === 0) return { canPair: false, canRevoke: false };

    const role = resolveOwnerRole(rows[0].owner_role);
    return {
      canPair: canPairDevices(role, rows[0].can_pair_devices === true),
      canRevoke: canRevokeDevices(role),
    };
  }

  /**
   * Which instance a new handset joins.
   *
   * Named explicitly wins. With exactly one instance - nearly every tenant -
   * it is chosen without asking. With several and no choice made, this refuses
   * rather than guessing: picking the oldest would silently enrol a phone into
   * the wrong desk, and a handset on the wrong instance sends its calls to the
   * wrong workspace, which is not visible until somebody goes looking for
   * calls that are not there.
   */
  private async resolveInstance(
    client: { query: <R>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> },
    orgId: string,
    requested: string | undefined,
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM instances WHERE org_id = $1 ORDER BY created_at ASC`,
      [orgId],
    );
    if (rows.length === 0) {
      throw new BadRequestException(
        "this workspace has no instance to pair a handset into - contact your provider",
      );
    }
    if (requested) {
      if (!rows.some((r) => r.id === requested)) {
        throw new NotFoundException("no such instance in this workspace");
      }
      return requested;
    }
    if (rows.length > 1) {
      throw new BadRequestException("choose which instance this handset belongs to");
    }
    return rows[0].id;
  }
}
