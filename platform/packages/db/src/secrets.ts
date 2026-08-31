import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Envelope encryption for credentials at rest (design doc §2.5).
 *
 * CRM integrations hold long-lived API keys that can write into a customer's
 * system of record. A database dump, a stray backup or a mis-scoped read
 * replica should not hand those over in plaintext, and RLS does not help here
 * because the rows are legitimately readable by the app role.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than silently yielding a different key. Stored as a self-describing string:
 *
 *     v1.gcm:<iv-b64>:<tag-b64>:<ciphertext-b64>
 *
 * The prefix is what makes this deployable without a data migration -
 * decryptSecret() returns anything unprefixed unchanged, so rows written
 * before this landed keep working and get encrypted the next time they are
 * saved. Once every row carries the prefix, the fallback can go.
 */

const PREFIX = "v1.gcm";

/**
 * The key comes from CRM_SECRET_KEY. Hashing means any length of passphrase
 * works while the cipher still gets exactly 32 bytes; a hex or base64 key of
 * the right length is used directly.
 */
function key(): Buffer | null {
  const raw = process.env.CRM_SECRET_KEY;
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  const b64 = Buffer.from(raw, "base64");
  if (b64.length === 32) return b64;
  return createHash("sha256").update(raw, "utf8").digest();
}

/** True when a key is configured - used to warn loudly at boot instead of quietly storing plaintext. */
export function secretsEncryptionEnabled(): boolean {
  return key() !== null;
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(`${PREFIX}:`);
}

/**
 * Encrypt a credential for storage. With no key configured the value is
 * returned as-is: refusing to save would break local development, where there
 * is nothing worth protecting, and the boot warning covers the real risk of
 * someone reaching production without setting the variable.
 */
export function encryptSecret(plaintext: string | null): string | null {
  if (plaintext === null || plaintext === "") return plaintext;
  if (isEncrypted(plaintext)) return plaintext; // already sealed - don't double-wrap
  const k = key();
  if (!k) return plaintext;

  const iv = randomBytes(12); // 96-bit nonce, the GCM standard
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const sealed = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64"), tag.toString("base64"), sealed.toString("base64")].join(
    ":",
  );
}

/**
 * Decrypt a stored credential. Throws on a corrupt or wrong-key ciphertext -
 * silently returning garbage would surface as an unexplained 401 from the CRM
 * days later, which is far harder to diagnose than a failed delivery that says
 * the key is wrong.
 */
export function decryptSecret(stored: string | null): string | null {
  if (stored === null || stored === "") return stored;
  if (!isEncrypted(stored)) return stored; // written before encryption landed

  const k = key();
  if (!k) {
    throw new Error(
      "CRM_SECRET_KEY is not set but an encrypted credential was read - " +
        "the key that sealed this row must be restored before the integration can send.",
    );
  }

  const [, ivB64, tagB64, dataB64] = stored.split(":");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("malformed encrypted credential");

  const decipher = createDecipheriv("aes-256-gcm", k, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * One-line boot check. Called by the API and worker so a production deploy
 * without a key is noisy rather than silently storing plaintext tokens.
 */
export function warnIfSecretsUnencrypted(service: string): void {
  if (secretsEncryptionEnabled()) return;
  const production = process.env.NODE_ENV === "production";
  const message =
    `${service}: CRM_SECRET_KEY is not set - CRM credentials will be stored in plaintext. ` +
    "Generate one with: openssl rand -hex 32";
  if (production) console.error(`FATAL-ADJACENT ${message}`);
  else console.warn(message);
}
