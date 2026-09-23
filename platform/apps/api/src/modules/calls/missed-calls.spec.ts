import { createHash } from "node:crypto";
import { BadRequestException, ConflictException } from "@nestjs/common";
import type { DeviceRequest } from "../../common/device-auth.guard";
import type { DbService } from "../../db/db.service";
import type { S3Service } from "../../s3/s3.service";
import { CallsController, callNumberFields, recordedCallSeconds } from "./calls.controller";

/**
 * POST /v1/calls/missed (0133) and the two helpers it shares with the upload
 * path. What Postgres makes of the INSERT is verify-missed-calls.cjs's job,
 * against a real database; this pins what the handler decides before it gets
 * there - who is refused, what is skipped, and what each row is built from.
 */

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

interface Ctx {
  device_status?: string;
  org_status?: string;
  telecaller_id?: string | null;
  install_epoch?: number | null;
  workspace_id?: string;
  store_full_number?: boolean;
}

function harness(ctx: Ctx | null, insertedRows = 1) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    withOrg: async (_orgId: string, fn: (client: unknown) => Promise<unknown>) =>
      fn({
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params });
          if (sql.includes("FROM devices d")) {
            return {
              rows: ctx
                ? [
                    {
                      device_status: "active",
                      org_status: "active",
                      telecaller_id: "tc-1",
                      install_epoch: 0,
                      workspace_id: "ws-1",
                      store_full_number: false,
                      ...ctx,
                    },
                  ]
                : [],
            };
          }
          if (sql.includes("INSERT INTO calls")) return { rows: [], rowCount: insertedRows };
          throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
        },
      }),
  } as unknown as DbService;
  const controller = new CallsController(db, {} as S3Service);
  const req = { device: { deviceId: "dev-1", orgId: "org-1" } } as unknown as DeviceRequest;
  const inserted = () => {
    const q = queries.find((x) => x.sql.includes("INSERT INTO calls"));
    return q ? (JSON.parse(String(q.params[4])) as Array<Record<string, string | null>>) : null;
  };
  return { controller, req, queries, inserted };
}

const entry = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: "missed-1758531600000",
  startedAt: "2026-09-22T09:00:00.000Z",
  reason: "unanswered",
  remoteNumber: "+91 98765 43210",
  ...over,
});

describe("POST /calls/missed", () => {
  it("refuses a malformed batch before touching the database", async () => {
    const h = harness({});
    await expect(h.controller.missed(h.req, { calls: [entry({ reason: "blocked" })] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(h.queries).toHaveLength(0);
  });

  it.each([
    [{ device_status: "logged_out" }],
    [{ device_status: "wiped" }],
    [{ org_status: "suspended" }],
  ])("refuses an inactive device or org (%j) and writes nothing", async (ctx) => {
    const h = harness(ctx);
    await expect(h.controller.missed(h.req, { calls: [entry()] })).rejects.toBeInstanceOf(ConflictException);
    expect(h.inserted()).toBeNull();
  });

  it("refuses a device it cannot find", async () => {
    const h = harness(null);
    await expect(h.controller.missed(h.req, { calls: [entry()] })).rejects.toBeInstanceOf(ConflictException);
  });

  it("writes the whole batch in ONE statement, born NO_AUDIO, and counts replays as duplicates", async () => {
    const h = harness({}, 1);
    const result = await h.controller.missed(h.req, {
      calls: [entry(), entry({ idempotencyKey: "missed-1758531700000", startedAt: "2026-09-22T09:01:40.000Z", reason: "declined" })],
    });
    expect(result).toEqual({ accepted: 1, duplicates: 1, skipped: 0 });
    const inserts = h.queries.filter((q) => q.sql.includes("INSERT INTO calls"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].sql).toContain("x.direction");
    expect(inserts[0].sql).toContain("'NO_AUDIO'");
    // Leans on the same unique index create() does, so a replay is a no-op.
    expect(inserts[0].sql).toMatch(/ON CONFLICT \(device_id, idempotency_key\)\s+WHERE status <> 'FAILED_UPLOAD'/);
    expect(inserts[0].sql).toContain("DO NOTHING");
    expect(inserts[0].params.slice(0, 4)).toEqual(["org-1", "ws-1", "dev-1", "tc-1"]);
    expect(h.inserted()?.map((r) => r.reason)).toEqual(["unanswered", "declined"]);
    // No direction given - both default to incoming (0133's original shape).
    expect(h.inserted()?.map((r) => r.direction)).toEqual(["incoming", "incoming"]);
  });

  it("stores an outgoing attempt that rang out as its own direction and reason (0134)", async () => {
    const h = harness({}, 1);
    await h.controller.missed(h.req, {
      calls: [entry({ direction: "outgoing", reason: "no_answer" })],
    });
    expect(h.inserted()?.[0]).toMatchObject({ direction: "outgoing", reason: "no_answer" });
  });

  it("refuses a batch mixing an outgoing entry with an incoming-only reason before touching the database", async () => {
    const h = harness({});
    await expect(
      h.controller.missed(h.req, { calls: [entry({ direction: "outgoing", reason: "declined" })] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.queries).toHaveLength(0);
  });

  it("stores the privacy-lite number fragments, never the full number unless the org opted in", async () => {
    const h = harness({ store_full_number: false });
    await h.controller.missed(h.req, { calls: [entry()] });
    const [row] = h.inserted() ?? [];
    expect(row).toMatchObject({
      num_prefix: "91987",
      num_last3: "210",
      num_hash: sha("919876543210"),
      num_key: sha("9876543210"),
      num_full: null,
    });

    const opted = harness({ store_full_number: true });
    await opted.controller.missed(opted.req, { calls: [entry()] });
    expect(opted.inserted()?.[0].num_full).toBe("919876543210");
  });

  it("turns a withheld caller's placeholder into no number at all", async () => {
    const h = harness({});
    await h.controller.missed(h.req, { calls: [entry({ remoteNumber: "-1" }), entry({ idempotencyKey: "k2", remoteNumber: undefined })] });
    for (const row of h.inserted() ?? []) {
      expect(row).toMatchObject({ num_hash: null, num_key: null, num_prefix: null, num_last3: null });
    }
  });

  it("namespaces the idempotency key by install, exactly as create() does", async () => {
    const h = harness({ install_epoch: 2 });
    await h.controller.missed(h.req, { calls: [entry()] });
    expect(h.inserted()?.[0].idem_key).toBe("e2:missed-1758531600000");
  });

  it("skips an entry dated well into the future instead of storing a phone's bad clock", async () => {
    const h = harness({});
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const result = await h.controller.missed(h.req, { calls: [entry({ startedAt: future })] });
    expect(result).toEqual({ accepted: 0, duplicates: 0, skipped: 1 });
    expect(h.inserted()).toBeNull();
  });
});

describe("callNumberFields", () => {
  it("gives the +91, 0 and bare forms of one mobile the same key but their own hash", () => {
    const a = callNumberFields("+91 98765 43210", false);
    const b = callNumberFields("098765 43210", false);
    const c = callNumberFields("9876543210", false);
    expect(a.key).toBe(b.key);
    expect(b.key).toBe(c.key);
    // The hash is left exactly as it always was - leads join on it.
    expect(new Set([a.hash, b.hash, c.hash]).size).toBe(3);
    expect(c.hash).toBe(sha("9876543210"));
  });

  it("has nothing for no number", () => {
    expect(callNumberFields(undefined, true)).toEqual({ prefix: null, last3: null, hash: null, key: null, full: null });
  });
});

describe("recordedCallSeconds", () => {
  it("never stores an answered incoming call as 0 seconds - the console would call it missed", () => {
    expect(recordedCallSeconds("incoming", 0)).toBe(1);
    expect(recordedCallSeconds("incoming", 45)).toBe(45);
  });

  it("leaves an outgoing call's length alone", () => {
    expect(recordedCallSeconds("outgoing", 0)).toBe(0);
  });
});
