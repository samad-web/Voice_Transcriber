import { createHash } from "node:crypto";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { isNewInstall, RECLAIMABLE_BY_HARDWARE_MATCH, type DeviceStatus } from "@aura/shared";

/**
 * Device recovery's one write (migration 0130), shared by every path that
 * lets a returning phone take its old row back - restore, the recovery secret,
 * a re-scanned QR, a re-link QR - so the four cannot drift into four subtly
 * different ideas of what "the same handset" means.
 *
 * Every function takes an org-scoped client from `withOrg`, never the admin
 * pool: RLS on `devices` is what keeps a device id from another tenant from
 * resolving at all.
 */

type Queryable = {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount: number | null }>;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * The stored form of a handset's hardware id. Prefixed with the org so one
 * physical phone enrolled in two tenants produces two unrelated values - the
 * column is a routing hint inside one tenant, and must not become a way to
 * correlate a person across customers.
 */
export function hardwareHashFor(orgId: string, hardwareId: string | undefined | null): string | null {
  return hardwareId ? sha256(`${orgId}:${hardwareId}`) : null;
}

/** A row a returning phone could take over, read FOR UPDATE. */
export interface ReturningDevice {
  id: string;
  instance_id: string;
  label: string | null;
  status: DeviceStatus;
  removed_at: string | null;
  public_key: string;
  fingerprint: string | null;
  hardware_hash: string | null;
  recovery_secret_hash: string | null;
  recovery_secret_prev_hash: string | null;
  install_epoch: number;
  telecaller_name: string | null;
}

const RETURNING_COLUMNS = `
  d.id, d.instance_id, d.label, d.status, d.removed_at, d.public_key, d.fingerprint, d.hardware_hash,
  d.recovery_secret_hash, d.recovery_secret_prev_hash, d.install_epoch,
  COALESCE(t.display_name, d.telecaller_name) AS telecaller_name`;

/** One row by id, locked. `FOR UPDATE OF d` because the telecaller join is nullable. */
export async function lockDevice(client: Queryable, deviceId: string): Promise<ReturningDevice | null> {
  const { rows } = await client.query<ReturningDevice>(
    `SELECT ${RETURNING_COLUMNS}
       FROM devices d
       LEFT JOIN telecallers t ON t.id = d.telecaller_id
      WHERE d.id = $1
      FOR UPDATE OF d`,
    [deviceId],
  );
  return rows[0] ?? null;
}

export type ReturnMethod = "relink" | "hardware_match";

/**
 * Which existing row, if any, a phone presenting a pairing token is.
 *
 *  - A re-link token names its row outright. Any status: an owner minted that
 *    code for that handset, which is the decision a wiped phone needs.
 *  - Otherwise the hardware hash, within the token's own instance, among rows a
 *    fresh QR may reclaim (see RECLAIMABLE_BY_HARDWARE_MATCH for why a wiped
 *    phone is not one of them). The most recently heard-from wins if a phone
 *    somehow holds two - the older is the stale one.
 *
 * Same instance only: a phone paired onto a different desk is a new handset
 * there, and quietly moving an existing row between instances would move its
 * future calls into another workspace.
 */
export async function findReturningDevice(
  client: Queryable,
  token: { instance_id: string; relink_device_id: string | null },
  hardwareHash: string | null,
): Promise<{ device: ReturningDevice; method: ReturnMethod } | null> {
  if (token.relink_device_id) {
    const device = await lockDevice(client, token.relink_device_id);
    // CASCADE deletes the token with its row, so a miss means the row moved
    // out of this org's sight - refuse rather than enrol a stranger on a code
    // that was minted to bring one particular phone back.
    if (!device) throw new ConflictException("the handset this code was made for no longer exists");
    return { device, method: "relink" };
  }
  if (!hardwareHash) return null;

  const { rows } = await client.query<ReturningDevice>(
    `SELECT ${RETURNING_COLUMNS}
       FROM devices d
       LEFT JOIN telecallers t ON t.id = d.telecaller_id
      WHERE d.instance_id = $1
        AND d.hardware_hash = $2
        AND d.status = ANY($3::text[])
      ORDER BY d.last_seen_at DESC NULLS LAST, d.created_at DESC
      LIMIT 1
      FOR UPDATE OF d`,
    [token.instance_id, hardwareHash, [...RECLAIMABLE_BY_HARDWARE_MATCH]],
  );
  return rows[0] ? { device: rows[0], method: "hardware_match" } : null;
}

export interface RebindInput {
  publicKey: string;
  fingerprint: string;
  label: string | null;
  captureCapability: string | null;
  refreshTokenHash: string;
  recoverySecretHash: string;
  /** What `recovery_secret_prev_hash` becomes - see judgeSecretRecovery. */
  previousRecoverySecretHash: string | null;
  hardwareHash: string | null;
  /** The pairing token spent, so an open pairing dialog sees this phone land. Null on the secret path. */
  enrollmentTokenId: string | null;
}

/**
 * Hand an existing row to the phone in front of us.
 *
 * What changes is exactly the install-specific state: the key, the secrets,
 * the fingerprint, the push token. What does NOT change is everything a person
 * would call history - the id, the telecaller, the instance, every call and
 * lead pointing at it. That asymmetry is the feature.
 *
 * The install epoch bumps only when the Keystore key is new. A phone re-scanning
 * a QR with the key it already had is the same install with the same local
 * upload queue, and bumping would orphan its in-flight retries.
 */
export async function rebindDevice(
  client: Queryable,
  device: ReturningDevice,
  input: RebindInput,
): Promise<{ installEpoch: number; newInstall: boolean }> {
  const newInstall = isNewInstall(device.public_key, input.publicKey);
  const {
    rows: [row],
  } = await client.query<{ install_epoch: number }>(
    `UPDATE devices
        SET public_key = $2,
            fingerprint = $3,
            label = COALESCE($4, label),
            capture_capability = COALESCE($5, capture_capability),
            refresh_token_hash = $6,
            recovery_secret_hash = $7,
            recovery_secret_prev_hash = $8,
            hardware_hash = $9,
            status = 'active',
            removed_at = NULL,
            last_seen_at = now(),
            relinked_at = now(),
            install_epoch = install_epoch + $10::int,
            enrollment_token_id = COALESCE($11, enrollment_token_id),
            -- A new install registers its own push token; the old one points
            -- at an app that no longer exists.
            fcm_token = CASE WHEN $10::int = 1 THEN NULL ELSE fcm_token END
      WHERE id = $1
      RETURNING install_epoch`,
    [
      device.id,
      input.publicKey,
      input.fingerprint,
      input.label,
      input.captureCapability,
      input.refreshTokenHash,
      input.recoverySecretHash,
      input.previousRecoverySecretHash,
      input.hardwareHash,
      newInstall ? 1 : 0,
      input.enrollmentTokenId,
    ],
  );
  return { installEpoch: row.install_epoch, newInstall };
}

/**
 * Undo a retire, a remove, a logout or a wipe - the "unlinked by mistake"
 * case, where the app is still on the phone and its key still works.
 *
 * No key or epoch changes: it is the same install, and its next check-in
 * simply succeeds. The caller pushes a config refresh so that happens now
 * rather than at the next hourly poll.
 */
export async function restoreDevice(
  client: Queryable,
  deviceId: string,
): Promise<{ id: string; previousStatus: DeviceStatus; wasRemoved: boolean }> {
  const device = await lockDevice(client, deviceId);
  if (!device) throw new NotFoundException("no such handset in this workspace");
  if (device.status === "active" && !device.removed_at) {
    // Not an error worth a 500, and not a silent success either: a restore of
    // a live handset means the screen the person is looking at is stale.
    throw new ConflictException("that handset is already active");
  }
  await client.query(
    `UPDATE devices SET status = 'active', removed_at = NULL WHERE id = $1`,
    [deviceId],
  );
  return { id: deviceId, previousStatus: device.status, wasRemoved: device.removed_at !== null };
}
