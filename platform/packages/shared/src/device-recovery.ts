/**
 * Device recovery (migration 0130): the rules that decide whether a returning
 * handset may take back the device row it used to be.
 *
 * Pure and dependency-free, so the verdicts the API acts on are the ones these
 * tests pin, and so nothing here can reach for a database or a clock. Hashing
 * stays in the API: this package is bundled into the browser too, and
 * `node:crypto` is not there.
 */

import type { DeviceStatus } from "./enums";

/**
 * Which rows a re-scanned pairing QR may reclaim by hardware match alone.
 *
 * `active` is the everyday case: the app was uninstalled, the server never
 * heard, and the old row is still "active" with a key that no longer exists.
 * `logged_out` covers a retire or a remove, and the fresh QR is itself an
 * owner re-authorising the phone.
 *
 * `wiped` and `lost` are excluded on purpose. A wipe is what an owner does
 * about a phone that has gone missing, and a phone that turns up again should
 * not slide back into somebody's identity because someone scanned a code. It
 * still can come back, but only by a decision: Restore, or a re-link QR minted
 * for that exact handset.
 */
export const RECLAIMABLE_BY_HARDWARE_MATCH: readonly DeviceStatus[] = ["active", "logged_out"];

/**
 * PEMs from different builds can differ in line wrapping and trailing
 * whitespace while naming the same key. Compare the base64 body alone.
 */
export function normalizePublicKey(pem: string): string {
  return pem
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
}

/**
 * Did a different app install take this row over?
 *
 * The Keystore key dies with an uninstall, so a new key means a new install
 * (or the same install after "Deactivate", which wipes the key but not the
 * local recordings list). The SAME key means the same install - somebody
 * re-scanning a QR on a phone that was already enrolled - and that must not
 * bump the install epoch, or the in-flight upload retries still sitting in its
 * local queue would stop matching their own calls.
 */
export function isNewInstall(storedPublicKey: string, presentedPublicKey: string): boolean {
  return normalizePublicKey(storedPublicKey) !== normalizePublicKey(presentedPublicKey);
}

/**
 * The idempotency key as stored on `calls` (0112/0113), namespaced by the
 * install that sent it.
 *
 * The handset's key is `local-<Room row id>`, and Room ids restart at 1 after a
 * reinstall. Once a returning phone keeps its old device id, `local-1` from the
 * new install would collide with `local-1` from the old one: the lookup would
 * find the OLD call and acknowledge the new recording as a retry of it - which
 * drops the new audio without an error anywhere - and even without the lookup
 * the unique index would refuse the insert.
 *
 * Epoch 0 returns the key unchanged, so every call stored before 0130, and
 * every device never taken over, keeps matching exactly as it always has.
 */
export function storedIdempotencyKey(installEpoch: number, clientKey: string): string {
  return installEpoch > 0 ? `e${installEpoch}:${clientKey}` : clientKey;
}

/**
 * Equal-length hex digests compared without an early exit. The inputs are
 * SHA-256 digests of secrets, which already makes a timing attack impractical;
 * this removes the argument rather than relying on it.
 */
export function digestsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type SecretRecoveryVerdict =
  | {
      ok: true;
      /**
       * `fresh`: the current secret, presented by a new install.
       * `retry`: the secret this one replaced, presented with the public key
       * the replacement was issued to - the same recovery again, after its
       * response was lost on the way back to the phone.
       */
      mode: "fresh" | "retry";
    }
  | {
      ok: false;
      /**
       * `bad_secret`       no match. Deliberately the only answer an outsider
       *                    can get: status and hardware are judged only after
       *                    the secret is proven, so they cannot be probed.
       * `different_handset` the secret is right but it is on another phone
       *                    (a device-to-device transfer, a restored backup).
       *                    A new phone needs an owner's re-link QR.
       * `unlinked`         the secret is right but an owner retired, removed
       *                    or wiped this handset. Only the owner can undo that.
       */
      reason: "bad_secret" | "different_handset" | "unlinked";
    };

export interface SecretRecoveryInput {
  presentedSecretHash: string;
  currentSecretHash: string | null;
  previousSecretHash: string | null;
  presentedPublicKey: string;
  storedPublicKey: string;
  status: DeviceStatus;
  removed: boolean;
  /** sha256(org:hardwareId) of the caller, or null when it sent none. */
  presentedHardwareHash: string | null;
  storedHardwareHash: string | null;
}

/**
 * May this caller reclaim the row with the recovery secret it presented?
 *
 * The secret is the only authorisation on this path - no pairing token, no
 * person in the loop - so everything that could make the answer "not without
 * an owner" is checked here:
 *
 *  1. The secret. Current, or the previous one on a genuine retry.
 *  2. The phone. When the row knows its hardware hash, the caller must present
 *     the same one. Recovery with no QR is for the SAME phone; a different
 *     phone is a decision an owner makes with a re-link code.
 *  3. The status. Only an active, unremoved row. An owner's retire is never
 *     undone by the phone it was aimed at.
 */
export function judgeSecretRecovery(input: SecretRecoveryInput): SecretRecoveryVerdict {
  let mode: "fresh" | "retry" | null = null;
  if (digestsEqual(input.presentedSecretHash, input.currentSecretHash)) {
    mode = "fresh";
  } else if (
    digestsEqual(input.presentedSecretHash, input.previousSecretHash) &&
    !isNewInstall(input.storedPublicKey, input.presentedPublicKey)
  ) {
    mode = "retry";
  }
  if (!mode) return { ok: false, reason: "bad_secret" };

  if (
    input.storedHardwareHash &&
    !digestsEqual(input.storedHardwareHash, input.presentedHardwareHash)
  ) {
    return { ok: false, reason: "different_handset" };
  }

  if (input.status !== "active" || input.removed) return { ok: false, reason: "unlinked" };

  return { ok: true, mode };
}
