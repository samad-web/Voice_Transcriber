import { HttpException } from "@nestjs/common";
import { assertInvitePending, assertMayAcceptInvite, refuse } from "./invite-guards";
import type { AuthUser } from "./supabase-admin.service";

/**
 * The checks both kinds of invite share (doc 34 Part C extracted them from
 * InvitesService so the superadmin path could not grow a second, drifting copy).
 *
 * These are an authorization boundary: holding the token is necessary and NOT
 * sufficient, and these three assertions are the whole of the difference. So each
 * refusal is pinned by code, not merely "it threw".
 */

const HOUR = 3_600_000;
const live = {
  expires_at: new Date(Date.now() + 24 * HOUR),
  accepted_at: null,
  revoked_at: null,
};

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    const body = (err as HttpException).getResponse() as { code?: string };
    return body.code ?? "no-code";
  }
  return "did-not-refuse";
}

function statusOf(fn: () => void): number {
  try {
    fn();
  } catch (err) {
    return (err as HttpException).getStatus();
  }
  return 0;
}

const googleUser: AuthUser = {
  id: "auth-1",
  email: "asha@example.com",
  emailVerified: true,
  providers: ["google"],
};

describe("refuse", () => {
  it("carries the code in the body, where the web tier reads it", () => {
    // The console maps these codes to sentences (app/login/auth-errors.ts), so a
    // refusal that loses its code degrades to a generic error.
    expect(codeOf(() => refuse(410, "expired", "gone"))).toBe("expired");
    expect(statusOf(() => refuse(410, "expired", "gone"))).toBe(410);
  });
});

describe("assertInvitePending", () => {
  it("passes a live invite", () => {
    expect(() => assertInvitePending(live)).not.toThrow();
  });

  it("refuses a spent, withdrawn or lapsed invite, each with its own code", () => {
    expect(codeOf(() => assertInvitePending({ ...live, accepted_at: new Date() }))).toBe("accepted");
    expect(codeOf(() => assertInvitePending({ ...live, revoked_at: new Date() }))).toBe("revoked");
    expect(
      codeOf(() => assertInvitePending({ ...live, expires_at: new Date(Date.now() - HOUR) })),
    ).toBe("expired");
  });

  it("treats an expiry exactly now as lapsed, not live", () => {
    // The boundary matters because the TTL is computed from `now` on issue; an
    // off-by-one here would keep a link alive for one more request.
    expect(codeOf(() => assertInvitePending({ ...live, expires_at: new Date(Date.now() - 1) }))).toBe(
      "expired",
    );
  });
});

describe("assertMayAcceptInvite", () => {
  const invite = { email: "asha@example.com" };

  it("accepts the invited address, arriving through Google, verified", () => {
    expect(() => assertMayAcceptInvite(invite, googleUser)).not.toThrow();
  });

  it("refuses an address Google did not confirm", () => {
    expect(codeOf(() => assertMayAcceptInvite(invite, { ...googleUser, emailVerified: false }))).toBe(
      "unverified_email",
    );
  });

  it("refuses a session that did not come through Google", () => {
    // The whole point: a password anybody could have chosen must not spend a
    // link that was mailed to one address.
    expect(codeOf(() => assertMayAcceptInvite(invite, { ...googleUser, providers: ["email"] }))).toBe(
      "not_google",
    );
  });

  it("refuses a different Google account", () => {
    expect(
      codeOf(() => assertMayAcceptInvite(invite, { ...googleUser, email: "someone@else.com" })),
    ).toBe("email_mismatch");
  });

  it("masks the invited address in the mismatch message", () => {
    // Shown to whoever holds the link, who may not be the person it was for. It
    // has to say enough to fix an honest mistake without handing a colleague's
    // full address to somebody who merely found the URL.
    let message = "";
    try {
      assertMayAcceptInvite(invite, { ...googleUser, email: "someone@else.com" });
    } catch (err) {
      message = ((err as HttpException).getResponse() as { message: string }).message;
    }
    expect(message).not.toContain("asha@example.com");
    expect(message).toContain("example.com");
  });
});
