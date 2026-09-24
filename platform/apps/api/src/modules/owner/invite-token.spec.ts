import {
  INVITE_TTL_DEFAULT_HOURS,
  INVITE_TTL_MAX_HOURS,
  INVITE_TTL_MIN_HOURS,
  generateInviteToken,
  hashInviteToken,
  inviteLink,
  inviteStatus,
  inviteTtlHours,
  isWellFormedInviteToken,
  maskEmail,
  normaliseEmail,
} from "./invite-token";

describe("invite tokens (0137)", () => {
  it("generates 256-bit url-safe tokens that pass the shape check", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const token = generateInviteToken();
      expect(isWellFormedInviteToken(token)).toBe(true);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
      seen.add(token);
    }
    expect(seen.size).toBe(200);
  });

  it("refuses anything that is not a token before it reaches the database", () => {
    for (const bad of ["", "short", `${"a".repeat(42)}!`, "a".repeat(44), null, undefined, 42, "../../etc/passwd"]) {
      expect(isWellFormedInviteToken(bad)).toBe(false);
    }
  });

  it("stores a stable SHA-256 hex, never the token", () => {
    const token = generateInviteToken();
    const hash = hashInviteToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashInviteToken(token));
    expect(hash).not.toContain(token);
    expect(hashInviteToken(generateInviteToken())).not.toBe(hash);
  });
});

describe("inviteStatus", () => {
  const now = new Date("2026-09-24T12:00:00Z");
  const future = "2026-09-25T12:00:00Z";
  const past = "2026-09-24T11:59:59Z";

  it("is pending until the expiry instant, and expired from it", () => {
    expect(inviteStatus({ accepted_at: null, revoked_at: null, expires_at: future }, now)).toBe("pending");
    expect(inviteStatus({ accepted_at: null, revoked_at: null, expires_at: past }, now)).toBe("expired");
    expect(inviteStatus({ accepted_at: null, revoked_at: null, expires_at: now }, now)).toBe("expired");
  });

  it("reports used and withdrawn ahead of expired", () => {
    expect(inviteStatus({ accepted_at: past, revoked_at: null, expires_at: past }, now)).toBe("accepted");
    expect(inviteStatus({ accepted_at: null, revoked_at: past, expires_at: past }, now)).toBe("revoked");
    expect(inviteStatus({ accepted_at: past, revoked_at: past, expires_at: future }, now)).toBe("accepted");
  });
});

describe("inviteTtlHours", () => {
  it("defaults and clamps the owner's choice", () => {
    expect(inviteTtlHours(undefined)).toBe(INVITE_TTL_DEFAULT_HOURS);
    expect(inviteTtlHours(null)).toBe(INVITE_TTL_DEFAULT_HOURS);
    expect(inviteTtlHours(Number.NaN)).toBe(INVITE_TTL_DEFAULT_HOURS);
    expect(inviteTtlHours(0)).toBe(INVITE_TTL_MIN_HOURS);
    expect(inviteTtlHours(10_000)).toBe(INVITE_TTL_MAX_HOURS);
    expect(inviteTtlHours(24.4)).toBe(24);
  });
});

describe("inviteLink", () => {
  it("is built from PUBLIC_APP_URL, basePath included, never from a request", () => {
    const env = { PUBLIC_APP_URL: "https://app.example.com/admin/" } as NodeJS.ProcessEnv;
    expect(inviteLink("abc_DEF-123", env)).toBe("https://app.example.com/admin/invite/abc_DEF-123");
  });

  it("falls back to the local console in development", () => {
    expect(inviteLink("t", {} as NodeJS.ProcessEnv)).toBe("http://localhost:3000/invite/t");
  });
});

describe("email helpers", () => {
  it("normalises the way GoTrue compares", () => {
    expect(normaliseEmail("  Asha.K@Example.COM ")).toBe("asha.k@example.com");
  });

  it("masks enough to recognise, not enough to learn the address", () => {
    expect(maskEmail("asha@example.com")).toBe("a***@example.com");
    expect(maskEmail("nodomain")).toBe("***");
  });
});
