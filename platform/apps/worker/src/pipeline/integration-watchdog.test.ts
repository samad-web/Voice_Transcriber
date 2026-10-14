import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE CONNECTOR WATCHDOG'S RESTRAINT (doc 49 P10-C, migration 0204).
 *
 * ── WHY RESTRAINT IS THE THING WORTH TESTING ────────────────────────────────
 *
 * Detecting a broken connector is easy: the outbox already records every
 * failure. The hard part, and the part that decides whether this feature is
 * used or filtered into a folder, is NOT telling anybody most of the time. A
 * watchdog that raises a notice on every failed delivery is a notice per call
 * on a telecalling floor, which is the same burial doc 49's own escalation
 * queue was redesigned to avoid.
 *
 * So every case here is about a brake:
 *   - one failure is not a fault;
 *   - a fault that started ten minutes ago is not yet news;
 *   - a fault persisting for a week is not news every half hour;
 *   - a connector that has recovered must stop being counted.
 *
 * The SQL itself was verified by executing it against a real Postgres - which
 * is how its first draft was caught filtering `status = 'active'`, a value
 * `crm_integrations` does not have, making the whole sweep a silent no-op.
 */

const ORG = "bbbbbbbb-0000-4000-8000-000000000002";
const INTEGRATION = "cccccccc-0000-4000-8000-00000000c001";

interface Issued {
  text: string;
  values: unknown[];
}

let issued: Issued[] = [];
/** What FAILING_SQL returns this run. */
let failing: Array<Record<string, unknown>> = [];

function fakeClient() {
  return {
    query: async (text: string, values: unknown[] = []) => {
      issued.push({ text, values });
      if (/FROM crm_integrations i\s+JOIN windowed/.test(text)) {
        return { rows: failing, rowCount: failing.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

vi.mock("@aura/db", () => ({
  getAdminPool: () => fakeClient(),
  withOrgContext: (_orgId: string, fn: (client: unknown) => Promise<unknown>) => fn(fakeClient()),
}));

vi.mock("./realtime", () => ({ announce: vi.fn() }));

import { runIntegrationWatchdog } from "./integration-watchdog";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: INTEGRATION,
    org_id: ORG,
    provider: "zoho",
    label: "Zoho CRM",
    last_error: "HTTP 401 INVALID_TOKEN",
    last_success_at: new Date(Date.now() - 3 * 86_400_000),
    failing_since: new Date(Date.now() - 2 * 86_400_000),
    last_alerted_at: null,
    consecutive_failures: 3,
    dead_rows: 1,
    ...overrides,
  };
}

/** The notification INSERT, if one was written. */
function notice(): Issued | undefined {
  return issued.find((q) => /INSERT INTO notifications/.test(q.text));
}

beforeEach(() => {
  issued = [];
  failing = [];
  vi.stubEnv("INTEGRATION_WATCHDOG_MIN_FAILURES", "3");
  vi.stubEnv("INTEGRATION_WATCHDOG_GRACE_MS", String(30 * 60 * 1000));
  vi.stubEnv("INTEGRATION_WATCHDOG_REMIND_MS", String(24 * 60 * 60 * 1000));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("nothing to say", () => {
  it("writes no notification when nothing is failing", async () => {
    await expect(runIntegrationWatchdog()).resolves.toBe(0);
    expect(notice()).toBeUndefined();
  });

  it("clears the flag on a connector that has recovered, before anything else", async () => {
    // FIRST, deliberately: a connector fixed an hour ago must not be counted as
    // failing for the rest of the sweep. The clear is unconditional because a
    // success after the failure is the only evidence that matters.
    await runIntegrationWatchdog();
    const cleared = issued[0];
    expect(cleared.text).toMatch(/SET failing_since = NULL/);
    expect(cleared.text).toMatch(/last_success_at > failing_since/);
  });
});

describe("a broken connector", () => {
  it("raises one notice, naming the connector and what it means", async () => {
    failing = [row()];
    await expect(runIntegrationWatchdog()).resolves.toBe(1);

    const n = notice();
    expect(n).toBeDefined();
    const [, title, body] = n!.values as [string, string, string];
    expect(title).toContain("Zoho CRM");
    // The three things an owner needs: what broke, that nothing is lost, and
    // that it will stay broken until they act.
    expect(body).toMatch(/queued and will retry/);
    expect(body).toMatch(/nothing will reach/i);
    // And the likely cause, for a connector whose credential expires - rather
    // than making somebody deduce it from a 401 they cannot see.
    expect(body).toMatch(/credential expires one hour/);
    // The dead rows, because those need a reprocess once it works.
    expect(body).toMatch(/1 delivery\(s\) have given up/);
  });

  it("goes to admins only", async () => {
    // A telecaller cannot re-enter an API key and every page behind the notice
    // refuses them, so telling them would be a standing notice about somebody
    // else's job. Same choice channel-watchdog.ts makes.
    failing = [row()];
    await runIntegrationWatchdog();
    expect(notice()!.text).toMatch(/owner_role = ANY/);
    expect(notice()!.text).toMatch(/m\.status = 'active'/);
  });

  it("stamps failing_since and last_alerted_at", async () => {
    failing = [row()];
    await runIntegrationWatchdog();
    expect(issued.some((q) => /failing_since = COALESCE\(failing_since, now\(\)\)/.test(q.text))).toBe(
      true,
    );
    expect(issued.some((q) => /SET last_alerted_at = now\(\)/.test(q.text))).toBe(true);
  });

  it("de-duplicates to one notice per connector per day", async () => {
    failing = [row()];
    await runIntegrationWatchdog();
    const key = (notice()!.values as unknown[])[3] as string;
    expect(key).toContain(INTEGRATION);
    expect(key).toContain(new Date().toISOString().slice(0, 10));
    // The ON CONFLICT is what makes it safe to run on a timer at all.
    expect(notice()!.text).toMatch(/ON CONFLICT \(user_id, dedupe_key\)/);
  });
});

describe("the brakes", () => {
  it("says nothing again inside the reminder window", async () => {
    // The fault persisting is not news every half hour. It still stamps
    // failing_since, so the console can show "failing since" inside the quiet
    // window - the notice is throttled, not the state.
    failing = [row({ last_alerted_at: new Date(Date.now() - 60_000) })];
    await expect(runIntegrationWatchdog()).resolves.toBe(0);
    expect(notice()).toBeUndefined();
    expect(issued.some((q) => /failing_since = COALESCE/.test(q.text))).toBe(true);
  });

  it("speaks again once the reminder window has passed", async () => {
    failing = [row({ last_alerted_at: new Date(Date.now() - 2 * 86_400_000) })];
    await expect(runIntegrationWatchdog()).resolves.toBe(1);
  });

  it("passes the failure threshold and grace period into the query, not into code", async () => {
    // Both are SQL parameters, so the window is applied by the database rather
    // than by filtering in JavaScript after fetching every connector.
    vi.stubEnv("INTEGRATION_WATCHDOG_MIN_FAILURES", "5");
    vi.stubEnv("INTEGRATION_WATCHDOG_GRACE_MS", "600000");
    await runIntegrationWatchdog();
    const select = issued.find((q) => /JOIN windowed/.test(q.text));
    expect(select!.values).toEqual([5, 600]);
  });

  it("says 'no delivery has ever succeeded' rather than an invented date", async () => {
    failing = [row({ last_success_at: null })];
    await runIntegrationWatchdog();
    expect((notice()!.values as string[])[2]).toMatch(/No delivery has ever succeeded/);
  });

  it("omits the expiry hint for a connector whose credential does not expire", async () => {
    // Most of the catalogue takes a long-lived API key. Telling a HubSpot owner
    // their credential expires would send them to re-paste a key that is fine.
    failing = [row({ provider: "hubspot", label: "HubSpot" })];
    await runIntegrationWatchdog();
    expect((notice()!.values as string[])[2]).not.toMatch(/credential expires/);
  });
});

describe("it cannot take the worker down", () => {
  it("survives the recovery-clear failing", async () => {
    // Every write in this sweep is best-effort. A watchdog that throws out of
    // its own timer is a watchdog that stops watching.
    failing = [row()];
    const broken = {
      query: async (text: string, values: unknown[] = []) => {
        issued.push({ text, values });
        if (/SET failing_since = NULL/.test(text)) throw new Error("deadlock detected");
        if (/JOIN windowed/.test(text)) return { rows: failing, rowCount: failing.length };
        return { rows: [], rowCount: 0 };
      },
    };
    const db = await import("@aura/db");
    vi.spyOn(db, "getAdminPool").mockReturnValue(broken as never);
    await expect(runIntegrationWatchdog()).resolves.toBe(1);
    vi.restoreAllMocks();
  });
});
