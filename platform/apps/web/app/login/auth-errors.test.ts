import { describe, expect, it } from "vitest";
import { authErrorMessage } from "./auth-errors";

describe("authErrorMessage", () => {
  it("says nothing when there is no error", () => {
    expect(authErrorMessage(undefined)).toBeNull();
    expect(authErrorMessage("")).toBeNull();
  });

  it("has a sentence for every refusal the invite API answers with", () => {
    // invites.service.ts InviteRefusal, plus the callback's own codes.
    for (const code of [
      "invalid",
      "expired",
      "accepted",
      "revoked",
      "not_signed_in",
      "unverified_email",
      "not_google",
      "email_mismatch",
      "unlinked_login",
      "other_login",
      "not_configured",
      "google_cancelled",
      "google_failed",
      "no_workspace",
      "unavailable",
      "accept_failed",
    ]) {
      expect(authErrorMessage(code)).not.toMatch(/^Something went wrong/);
    }
  });

  it("never echoes an unknown code - the URL is attacker-controlled", () => {
    const planted = "Your account is locked. Call +1 555 0100 to unlock it";
    const message = authErrorMessage(planted);
    expect(message).toBe("Something went wrong signing you in. Try again.");
    expect(message).not.toContain("555");
  });

  it("does not find inherited object keys", () => {
    for (const code of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(authErrorMessage(code)).toBe("Something went wrong signing you in. Try again.");
    }
  });
});
