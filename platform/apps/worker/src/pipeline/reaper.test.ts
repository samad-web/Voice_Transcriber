import { describe, expect, it, vi } from "vitest";

// The reaper module builds an S3 client and imports the db package at load;
// neither is used by `reapCalls`, which takes both as arguments.
vi.mock("@aura/db", () => ({ getAdminPool: vi.fn(), withOrgContext: vi.fn() }));

import { reapCalls } from "./reaper";

const ORG = "00000000-0000-4000-8000-000000000001";

function fakeClient() {
  const issued: Array<{ text: string; values: unknown[] }> = [];
  return {
    issued,
    query: async (text: string, values: unknown[] = []) => {
      issued.push({ text, values });
      return { rows: [], rowCount: 1 };
    },
  };
}

describe("reapCalls", () => {
  it("keeps a call whose recording could not be deleted from the bucket", async () => {
    const client = fakeClient();
    const failing = vi.fn(async () => {
      throw new Error("S3 503 SlowDown");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await reapCalls(client, ORG, [{ id: "call-1", s3_key: "org/x/calls/call-1.m4a" }], failing);

    expect(result).toEqual({ reaped: 0, kept: 1 });
    // No row went: the object is still in the bucket, so its row must stay
    // pointing at it for the next run - and for the storage meter.
    expect(client.issued.some((q) => /DELETE FROM (calls|recordings)/.test(q.text))).toBe(false);
    warn.mockRestore();
  });

  it("deletes the rows once the object is gone", async () => {
    const client = fakeClient();
    const ok = vi.fn(async () => ({}));
    const result = await reapCalls(client, ORG, [{ id: "call-2", s3_key: "org/x/calls/call-2.m4a" }], ok);

    expect(result).toEqual({ reaped: 1, kept: 0 });
    expect(ok).toHaveBeenCalledWith("org/x/calls/call-2.m4a");
    expect(client.issued.some((q) => q.text === "DELETE FROM calls WHERE id = $1")).toBe(true);
    expect(client.issued.some((q) => /retention\.reap/.test(q.text))).toBe(true);
  });

  it("reaps a call with no audio without touching the bucket", async () => {
    const client = fakeClient();
    const bucket = vi.fn(async () => ({}));
    const result = await reapCalls(client, ORG, [{ id: "call-3", s3_key: null }], bucket);

    expect(result).toEqual({ reaped: 1, kept: 0 });
    expect(bucket).not.toHaveBeenCalled();
  });

  it("keeps going past one failure in a batch", async () => {
    const client = fakeClient();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const flaky = vi.fn(async (key: string) => {
      if (key.includes("bad")) throw new Error("denied");
      return {};
    });
    const result = await reapCalls(
      client,
      ORG,
      [
        { id: "a", s3_key: "org/x/calls/bad.m4a" },
        { id: "b", s3_key: "org/x/calls/good.m4a" },
      ],
      flaky,
    );
    expect(result).toEqual({ reaped: 1, kept: 1 });
    warn.mockRestore();
  });
});
