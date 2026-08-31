import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decryptSecret,
  encryptSecret,
  isEncrypted,
  secretsEncryptionEnabled,
  warnIfSecretsUnencrypted,
} from "./secrets";

/**
 * Envelope encryption for CRM credentials at rest.
 *
 * These are long-lived API keys that can WRITE into a customer's system of
 * record, so the two properties that matter are: a sealed value round-trips
 * exactly, and a tampered or wrong-key value throws instead of yielding
 * plausible-looking garbage. The second is the one worth a test - a silent
 * garbage decrypt surfaces days later as an unexplained 401 from the CRM.
 *
 * `key()` reads process.env on every call, so each test can set CRM_SECRET_KEY
 * without any module-cache games. vi.unstubAllEnvs in afterEach keeps them from
 * leaking into each other.
 */

/** 32 bytes of hex - the form `openssl rand -hex 32` produces, per the doc comment. */
const HEX_KEY = "0".repeat(31) + "1" + "f".repeat(32);
const OTHER_HEX_KEY = "a".repeat(64);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("secretsEncryptionEnabled", () => {
  it("is false when CRM_SECRET_KEY is unset", () => {
    vi.stubEnv("CRM_SECRET_KEY", undefined);
    expect(secretsEncryptionEnabled()).toBe(false);
  });

  it("is true for a hex key, a 32-byte base64 key and an arbitrary passphrase", () => {
    // All three forms are accepted deliberately: hex and base64 are used as-is,
    // anything else is sha256'd so the cipher always gets exactly 32 bytes.
    for (const raw of [HEX_KEY, Buffer.alloc(32, 7).toString("base64"), "a short passphrase"]) {
      vi.stubEnv("CRM_SECRET_KEY", raw);
      expect(secretsEncryptionEnabled()).toBe(true);
    }
  });
});

describe("isEncrypted", () => {
  it("recognises the v1.gcm envelope and nothing else", () => {
    expect(isEncrypted("v1.gcm:aaa:bbb:ccc")).toBe(true);
    expect(isEncrypted("cik_live_abcdef")).toBe(false);
    expect(isEncrypted("")).toBe(false);
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted(undefined)).toBe(false);
  });
});

describe("encryptSecret / decryptSecret round trip", () => {
  it("round-trips a credential exactly, for each accepted key form", () => {
    for (const raw of [HEX_KEY, Buffer.alloc(32, 7).toString("base64"), "a short passphrase"]) {
      vi.stubEnv("CRM_SECRET_KEY", raw);
      const secret = "pat-NPUxxxxxxxx-0123456789abcdef";
      const sealed = encryptSecret(secret);
      expect(sealed).not.toBe(secret);
      expect(isEncrypted(sealed)).toBe(true);
      expect(decryptSecret(sealed)).toBe(secret);
    }
  });

  it("round-trips multi-byte and long credentials", () => {
    vi.stubEnv("CRM_SECRET_KEY", HEX_KEY);
    for (const secret of ["ஆர்டி இன்டர்லாக்", "x".repeat(4096), " leading and trailing "]) {
      expect(decryptSecret(encryptSecret(secret))).toBe(secret);
    }
  });

  it("produces the documented self-describing envelope", () => {
    vi.stubEnv("CRM_SECRET_KEY", HEX_KEY);
    const parts = (encryptSecret("token") as string).split(":");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1.gcm");
    // 96-bit nonce and 128-bit tag, the GCM standard sizes.
    expect(Buffer.from(parts[1], "base64")).toHaveLength(12);
    expect(Buffer.from(parts[2], "base64")).toHaveLength(16);
  });

  it("uses a fresh nonce per call, so the same secret never seals identically", () => {
    // A repeated ciphertext would let anyone with the table see which tenants
    // share a credential, and reusing a nonce under one key breaks GCM outright.
    vi.stubEnv("CRM_SECRET_KEY", HEX_KEY);
    expect(encryptSecret("token")).not.toBe(encryptSecret("token"));
  });

  it("passes null and the empty string through untouched", () => {
    // NULL auth_secret is a legitimate row (auth_type 'none'); it must not
    // become the string "null" or an envelope around nothing.
    vi.stubEnv("CRM_SECRET_KEY", HEX_KEY);
    expect(encryptSecret(null)).toBeNull();
    expect(encryptSecret("")).toBe("");
    expect(decryptSecret(null)).toBeNull();
    expect(decryptSecret("")).toBe("");
  });

  it("does not double-wrap a value that is already sealed", () => {
    // The controllers re-save whole integration rows, so an unchanged secret is
    // handed back to encryptSecret repeatedly.
    vi.stubEnv("CRM_SECRET_KEY", HEX_KEY);
    const sealed = encryptSecret("token") as string;
    expect(encryptSecret(sealed)).toBe(sealed);
    expect(decryptSecret(encryptSecret(sealed))).toBe("token");
  });
});

describe("decryptSecret tamper and key failures", () => {
  it("throws when a byte of the ciphertext is flipped", () => {
    // The reason this is AES-GCM and not AES-CBC: authenticated, so corruption
    // fails loudly instead of decrypting to a different-but-plausible key.
    vi.stubEnv("CRM_SECRET_KEY", HEX_KEY);
    const [prefix, iv, tag, data] = (encryptSecret("pat-NPUxxxxxxxx") as string).split(":");
    const bytes = Buffer.from(data, "base64");
    bytes[0] ^= 0xff;
    const tampered = [prefix, iv, tag, bytes.toString("base64")].join(":");
    expect(tampered).not.toBe(`${prefix}:${iv}:${tag}:${data}`);
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("throws when the authentication tag is altered", () => {
    vi.stubEnv("CRM_SECRET_KEY", HEX_KEY);
    const [prefix, iv, tag, data] = (encryptSecret("pat-NPUxxxxxxxx") as string).split(":");
    const bytes = Buffer.from(tag, "base64");
    bytes[0] ^= 0xff;
    expect(() => decryptSecret([prefix, iv, bytes.toString("base64"), data].join(":"))).toThrow();
  });

  it("throws when the nonce is altered", () => {
    vi.stubEnv("CRM_SECRET_KEY", HEX_KEY);
    const [prefix, iv, tag, data] = (encryptSecret("pat-NPUxxxxxxxx") as string).split(":");
    const bytes = Buffer.from(iv, "base64");
    bytes[0] ^= 0xff;
    expect(() => decryptSecret([prefix, bytes.toString("base64"), tag, data].join(":"))).toThrow();
  });

  it("throws when decrypted with a different key", () => {
    // The key-rotation-without-re-encryption case. Must fail, not return noise.
    vi.stubEnv("CRM_SECRET_KEY", HEX_KEY);
    const sealed = encryptSecret("pat-NPUxxxxxxxx") as string;
    vi.stubEnv("CRM_SECRET_KEY", OTHER_HEX_KEY);
    expect(() => decryptSecret(sealed)).toThrow();
  });

  it("throws a diagnosable error when the key is gone entirely", () => {
    // The realistic outage: a redeploy that dropped CRM_SECRET_KEY. The message
    // has to say the key is missing, because the symptom otherwise looks like a
    // CRM credential problem at the far end.
    vi.stubEnv("CRM_SECRET_KEY", HEX_KEY);
    const sealed = encryptSecret("pat-NPUxxxxxxxx") as string;
    vi.stubEnv("CRM_SECRET_KEY", undefined);
    expect(() => decryptSecret(sealed)).toThrow(/CRM_SECRET_KEY is not set/);
  });

  it("throws on a truncated envelope rather than returning a partial value", () => {
    vi.stubEnv("CRM_SECRET_KEY", HEX_KEY);
    expect(() => decryptSecret("v1.gcm:onlyonepart")).toThrow(/malformed encrypted credential/);
    expect(() => decryptSecret("v1.gcm::")).toThrow(/malformed encrypted credential/);
  });

  it("throws on an envelope whose parts are not valid base64 of the right length", () => {
    vi.stubEnv("CRM_SECRET_KEY", HEX_KEY);
    expect(() => decryptSecret("v1.gcm:!!!:!!!:!!!")).toThrow();
  });
});

describe("the unset-key branch", () => {
  it("stores the credential as plaintext when no key is configured", () => {
    // Deliberate (secrets.ts:47-52): refusing to save would break local dev.
    // Pinned because it means production without CRM_SECRET_KEY silently holds
    // customer CRM tokens in the clear - see warnIfSecretsUnencrypted below.
    vi.stubEnv("CRM_SECRET_KEY", undefined);
    expect(encryptSecret("pat-NPUxxxxxxxx")).toBe("pat-NPUxxxxxxxx");
    expect(isEncrypted(encryptSecret("pat-NPUxxxxxxxx"))).toBe(false);
  });

  it("round-trips a plaintext value with no key set", () => {
    vi.stubEnv("CRM_SECRET_KEY", undefined);
    expect(decryptSecret(encryptSecret("pat-NPUxxxxxxxx"))).toBe("pat-NPUxxxxxxxx");
  });

  it("returns a pre-encryption row unchanged whether or not a key is set", () => {
    // The migration-free rollout: rows written before this landed carry no
    // prefix and must keep working until they are next saved.
    for (const raw of [HEX_KEY, undefined]) {
      vi.stubEnv("CRM_SECRET_KEY", raw);
      expect(decryptSecret("legacy-plaintext-token")).toBe("legacy-plaintext-token");
    }
  });
});

describe("warnIfSecretsUnencrypted", () => {
  it("says nothing when a key is configured", () => {
    vi.stubEnv("CRM_SECRET_KEY", HEX_KEY);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    warnIfSecretsUnencrypted("api");
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("warns outside production and escalates to console.error in production", () => {
    vi.stubEnv("CRM_SECRET_KEY", undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.stubEnv("NODE_ENV", "development");
    warnIfSecretsUnencrypted("worker");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("worker: CRM_SECRET_KEY is not set");
    expect(error).not.toHaveBeenCalled();

    vi.stubEnv("NODE_ENV", "production");
    warnIfSecretsUnencrypted("api");
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain("FATAL-ADJACENT");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
