import { describe, expect, it } from "vitest";
import {
  digestsEqual,
  isNewInstall,
  judgeSecretRecovery,
  normalizePublicKey,
  RECLAIMABLE_BY_HARDWARE_MATCH,
  storedIdempotencyKey,
  type SecretRecoveryInput,
} from "./device-recovery";

const KEY_A = "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEaaaa\nbbbb\n-----END PUBLIC KEY-----\n";
const KEY_A_REWRAPPED = "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEaaaabbbb\n-----END PUBLIC KEY-----";
const KEY_B = "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEcccc\n-----END PUBLIC KEY-----\n";

const H = (c: string) => c.repeat(64);

function input(over: Partial<SecretRecoveryInput> = {}): SecretRecoveryInput {
  return {
    presentedSecretHash: H("1"),
    currentSecretHash: H("1"),
    previousSecretHash: null,
    presentedPublicKey: KEY_B,
    storedPublicKey: KEY_A,
    status: "active",
    removed: false,
    presentedHardwareHash: H("9"),
    storedHardwareHash: H("9"),
    ...over,
  };
}

describe("storedIdempotencyKey", () => {
  it("leaves every never-taken-over device's keys exactly as they were", () => {
    expect(storedIdempotencyKey(0, "local-1")).toBe("local-1");
  });

  it("namespaces a returning install so local-1 cannot collide with the old install's local-1", () => {
    expect(storedIdempotencyKey(1, "local-1")).toBe("e1:local-1");
    expect(storedIdempotencyKey(2, "local-1")).not.toBe(storedIdempotencyKey(1, "local-1"));
  });

  it("stays within the 80-char client limit plus a short prefix", () => {
    const key = storedIdempotencyKey(9999, "x".repeat(80));
    expect(key.length).toBeLessThanOrEqual(86);
  });
});

describe("isNewInstall", () => {
  it("treats a re-wrapped PEM of the same key as the same install", () => {
    expect(normalizePublicKey(KEY_A)).toBe(normalizePublicKey(KEY_A_REWRAPPED));
    expect(isNewInstall(KEY_A, KEY_A_REWRAPPED)).toBe(false);
  });

  it("treats a different Keystore key as a new install", () => {
    expect(isNewInstall(KEY_A, KEY_B)).toBe(true);
  });
});

describe("digestsEqual", () => {
  it("never matches a missing digest, even against another missing one", () => {
    expect(digestsEqual(null, null)).toBe(false);
    expect(digestsEqual("", "")).toBe(false);
    expect(digestsEqual(H("a"), null)).toBe(false);
  });

  it("refuses different lengths and different content", () => {
    expect(digestsEqual("abc", "abcd")).toBe(false);
    expect(digestsEqual(H("a"), H("b"))).toBe(false);
    expect(digestsEqual(H("a"), H("a"))).toBe(true);
  });
});

describe("RECLAIMABLE_BY_HARDWARE_MATCH", () => {
  it("never lets a re-scanned QR silently revive a wiped or lost handset", () => {
    expect(RECLAIMABLE_BY_HARDWARE_MATCH).toEqual(["active", "logged_out"]);
  });
});

describe("judgeSecretRecovery", () => {
  it("lets a reinstalled app on the same phone reclaim its active row", () => {
    expect(judgeSecretRecovery(input())).toEqual({ ok: true, mode: "fresh" });
  });

  it("refuses a wrong secret with nothing more specific than bad_secret", () => {
    // Even though the row is also unlinked AND on another phone: an outsider
    // must not learn either fact without the secret.
    expect(
      judgeSecretRecovery(
        input({ presentedSecretHash: H("2"), status: "wiped", presentedHardwareHash: H("8") }),
      ),
    ).toEqual({ ok: false, reason: "bad_secret" });
  });

  it("accepts the previous secret only from the install it was replaced for", () => {
    // Retry: the first recovery rotated to H("3") and stored KEY_B, but the
    // response never reached the phone, which still holds H("1").
    const retry = input({
      presentedSecretHash: H("1"),
      currentSecretHash: H("3"),
      previousSecretHash: H("1"),
      storedPublicKey: KEY_B,
      presentedPublicKey: KEY_B,
    });
    expect(judgeSecretRecovery(retry)).toEqual({ ok: true, mode: "retry" });

    // Same old secret from a DIFFERENT install - a copied secret racing the
    // real phone - is refused.
    expect(judgeSecretRecovery({ ...retry, presentedPublicKey: KEY_A })).toEqual({
      ok: false,
      reason: "bad_secret",
    });
  });

  it("sends a different phone to its owner for a re-link code", () => {
    expect(judgeSecretRecovery(input({ presentedHardwareHash: H("8") }))).toEqual({
      ok: false,
      reason: "different_handset",
    });
    // A caller that sends no hardware id cannot prove it is the same phone.
    expect(judgeSecretRecovery(input({ presentedHardwareHash: null }))).toEqual({
      ok: false,
      reason: "different_handset",
    });
  });

  it("allows a row that never recorded a hardware hash", () => {
    expect(
      judgeSecretRecovery(input({ storedHardwareHash: null, presentedHardwareHash: null })),
    ).toEqual({ ok: true, mode: "fresh" });
  });

  it("never lets a phone undo its own retirement", () => {
    for (const status of ["logged_out", "wiped", "lost"] as const) {
      expect(judgeSecretRecovery(input({ status }))).toEqual({ ok: false, reason: "unlinked" });
    }
    expect(judgeSecretRecovery(input({ removed: true }))).toEqual({
      ok: false,
      reason: "unlinked",
    });
  });
});
