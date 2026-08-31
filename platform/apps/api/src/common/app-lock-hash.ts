import { pbkdf2Sync, randomBytes } from "node:crypto";

/**
 * Hashing for the mobile app-lock password (instances/[id] "App lock" card).
 *
 * Deliberately PBKDF2-HMAC-SHA256, not the scrypt AuthService uses for console
 * logins: this hash is verified ON THE DEVICE, offline, against the synced
 * `devices/me/config` document - Android has no scrypt in its standard crypto
 * provider, but `SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")` has
 * been available since API 26, which is this app's minSdk. Node's
 * `crypto.pbkdf2Sync` and Java's PBKDF2WithHmacSHA256 are both plain RFC 8018
 * PBKDF2 - same salt/iterations/keylen in, byte-identical key out.
 *
 * Iteration count follows OWASP's 2023 PBKDF2-SHA256 minimum. Stored
 * self-describing (`pbkdf2$<iterations>$<saltHex>$<hashHex>`) so a future
 * bump doesn't break hashes already on a device.
 */
const KEY_LENGTH_BYTES = 32;
const ITERATIONS = 210_000;

export function hashAppLockPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH_BYTES, "sha256");
  return `pbkdf2$${ITERATIONS}$${salt.toString("hex")}$${hash.toString("hex")}`;
}
