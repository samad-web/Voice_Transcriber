import { describe, expect, it } from "vitest";
import {
  AUTH_EVENT_LABELS,
  AuthEventInput,
  AuthEventKind,
  decodeActivityCursor,
  describeAuthEventWhere,
  encodeActivityCursor,
} from "./auth-events";

describe("AuthEventInput", () => {
  it("carries no user id - the caller comes from a header, never a body", () => {
    expect(Object.keys(AuthEventInput.shape)).not.toContain("userId");
    expect(Object.keys(AuthEventInput.shape)).not.toContain("authUserId");
  });

  it("lower-cases a failed sign-in's email", () => {
    const parsed = AuthEventInput.parse({
      kind: "sign_in_failed",
      sessionId: null,
      console: null,
      orgId: null,
      ip: null,
      userAgent: null,
      email: " Abdul@Acme.IN ",
    });
    expect(parsed.email).toBe("abdul@acme.in");
  });
});

describe("AUTH_EVENT_LABELS", () => {
  it("labels every kind", () => {
    expect(Object.keys(AUTH_EVENT_LABELS).sort()).toEqual([...AuthEventKind.options].sort());
  });
});

describe("the activity cursor", () => {
  it("round-trips, microseconds included", () => {
    // The API cuts the cursor at Postgres's microsecond precision; a millisecond
    // cursor would drop rows sharing that millisecond between pages.
    const at = "2026-09-21T10:15:00.123456Z";
    expect(decodeActivityCursor(encodeActivityCursor(at, "42"))).toEqual({ createdAt: at, id: "42" });
  });

  it("refuses anything it did not make", () => {
    expect(decodeActivityCursor(null)).toBeNull();
    expect(decodeActivityCursor("garbage")).toBeNull();
    expect(decodeActivityCursor("2026-09-21T10:15:00Z_1; DROP TABLE x")).toBeNull();
    expect(decodeActivityCursor("not-a-date_5")).toBeNull();
  });
});

describe("describeAuthEventWhere", () => {
  it("names the console and the workspace", () => {
    expect(describeAuthEventWhere("owner", "Acme Realty")).toBe("Owner console · Acme Realty");
    expect(describeAuthEventWhere("operator", null)).toBe("Operator console");
  });
});
