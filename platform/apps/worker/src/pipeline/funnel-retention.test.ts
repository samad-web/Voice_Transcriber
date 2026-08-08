import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FUNNEL_ENQUIRY_RETENTION_DAYS,
  FUNNEL_ENQUIRY_RETENTION_FLOOR_DAYS,
} from "@aura/shared";

/**
 * The retention sweep, tested where it can do damage: what it selects for
 * deletion, and what it leaves behind.
 *
 * This is the only job in the platform that deletes customer-adjacent data on a
 * timer with no confirmation. A wrong predicate does not throw — it silently
 * removes real enquiries, irreversibly, and the log looks like a normal day.
 */

const query = vi.fn();
vi.mock("@aura/db", () => ({ getAdminPool: () => ({ query }) }));

beforeEach(() => {
  // `vi.doMock` registrations outlive `resetModules`, so the floor tests below
  // — which mock the retention constant down to 1 — would otherwise poison
  // every test declared after them. Clearing it here rather than reordering the
  // file keeps the tests independent of the order they happen to be written in.
  vi.doUnmock("@aura/shared");
  vi.resetModules();
  query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
});

afterEach(() => vi.restoreAllMocks());

async function load() {
  return import("./funnel-retention");
}

describe("the promise and the enforcement are the same number", () => {
  it("uses the shared constant, not a local copy", async () => {
    const { retentionDays } = await load();
    expect(retentionDays()).toBe(FUNNEL_ENQUIRY_RETENTION_DAYS);
  });

  it("passes that exact number to the DELETE", async () => {
    const { sweepExpiredEnquiries } = await load();
    await sweepExpiredEnquiries();
    expect(query.mock.calls[0]?.[1]?.[0]).toBe(FUNNEL_ENQUIRY_RETENTION_DAYS);
  });

  it("ships a value at or above its own floor", () => {
    // Guards the constant itself. Someone lowering it below the floor would
    // otherwise only find out when the job refused to start in production.
    expect(FUNNEL_ENQUIRY_RETENTION_DAYS).toBeGreaterThanOrEqual(
      FUNNEL_ENQUIRY_RETENTION_FLOOR_DAYS,
    );
  });
});

describe("what it deletes", () => {
  const sql = async (): Promise<string> => {
    const { sweepExpiredEnquiries } = await load();
    await sweepExpiredEnquiries();
    return (query.mock.calls[0]?.[0] as string).replace(/\s+/g, " ");
  };

  it("only deletes enquiries past the retention window", async () => {
    expect(await sql()).toContain("created_at < now() - make_interval(days => $1)");
  });

  it("NEVER deletes an enquiry that became a customer", async () => {
    // The privacy policy promises this in the same paragraph as the period:
    // once you are a customer the enquiry is part of the contractual record.
    expect(await sql()).toContain("converted_org_id IS NULL");
  });

  it("caps how many go in one sweep", async () => {
    const q = await sql();
    expect(q).toContain("LIMIT $2");
    expect(query.mock.calls[0]?.[1]?.[1]).toBe(500);
  });

  it("honours a caller-supplied limit", async () => {
    const { sweepExpiredEnquiries } = await load();
    await sweepExpiredEnquiries(10);
    expect(query.mock.calls[0]?.[1]?.[1]).toBe(10);
  });
});

describe("the booking-name scrub", () => {
  it("clears names left on slots whose enquiry is gone", async () => {
    // booking_slots.submission_id is ON DELETE SET NULL, so booked_name would
    // otherwise survive the deletion — the person's name sitting in the
    // calendar forever, while we claim to have deleted their enquiry.
    const { sweepExpiredEnquiries } = await load();
    await sweepExpiredEnquiries();
    const scrub = (query.mock.calls[1]?.[0] as string).replace(/\s+/g, " ");
    expect(scrub).toContain("UPDATE marketing.booking_slots SET booked_name = NULL");
    expect(scrub).toContain("submission_id IS NULL");
  });

  it("runs even when nothing was deleted", async () => {
    // It is also the repair path for slots orphaned by a DPDP erasure request,
    // which had the same gap and never triggers a retention delete.
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    const { sweepExpiredEnquiries } = await load();
    const result = await sweepExpiredEnquiries();
    expect(query).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ deleted: 0, namesScrubbed: 0 });
  });

  it("reports what it did", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: "a" }, { id: "b" }], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 3 });
    const { sweepExpiredEnquiries } = await load();
    expect(await sweepExpiredEnquiries()).toEqual({ deleted: 2, namesScrubbed: 3 });
  });
});

describe("the floor", () => {
  it("refuses to run below it, rather than deleting", async () => {
    vi.doMock("@aura/shared", async (orig) => ({
      ...(await orig<Record<string, unknown>>()),
      FUNNEL_ENQUIRY_RETENTION_DAYS: 3,
    }));
    const { sweepExpiredEnquiries } = await import("./funnel-retention");
    await expect(sweepExpiredEnquiries()).rejects.toThrow(/refusing to run with 3 days/);
    // The point: it threw BEFORE issuing a DELETE.
    expect(query).not.toHaveBeenCalled();
  });

  it("does not schedule a sweep below the floor", async () => {
    vi.doMock("@aura/shared", async (orig) => ({
      ...(await orig<Record<string, unknown>>()),
      FUNNEL_ENQUIRY_RETENTION_DAYS: 1,
    }));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { startFunnelRetentionSweep } = await import("./funnel-retention");
    expect(startFunnelRetentionSweep()).toBeNull();
    expect(err.mock.calls[0]?.[0]).toContain("DISABLED");
  });
});

describe("startFunnelRetentionSweep", () => {
  it("schedules on the shipped constant", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { startFunnelRetentionSweep } = await load();
    const timer = startFunnelRetentionSweep();
    expect(timer).not.toBeNull();
    if (timer) clearInterval(timer);
  });
});
