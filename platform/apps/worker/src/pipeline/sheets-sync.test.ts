import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Google Sheets sweep, tested on the four decisions that can put wrong
 * data on somebody's board.
 *
 * None of them throws when it goes wrong. A stale column mapping produces
 * leads whose name is an email address; a first sync without a guard produces
 * three thousand leads dated today; a missing scope produces a retry loop with
 * no explanation. So each one is asserted directly.
 */

const ingestIntakeLead = vi.fn();
vi.mock("./lead-intake", () => ({
  ingestIntakeLead: (...args: unknown[]) => ingestIntakeLead(...args),
}));

const adminQuery = vi.fn().mockResolvedValue({ rows: [] });
vi.mock("@aura/db", () => ({
  getAdminPool: () => ({ query: adminQuery }),
  withOrgContext: (_o: string, fn: (c: unknown) => unknown) => fn({ query: vi.fn() }),
  decryptSecret: (v: string | null) => v,
  encryptSecret: (v: string) => v,
}));

vi.mock("./email-sync", () => ({
  oauthAppFor: vi.fn().mockResolvedValue({
    clientId: "1-org.apps.googleusercontent.com",
    clientSecret: "secret",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    source: "organization",
  }),
  refreshAccessToken: vi.fn().mockResolvedValue({ accessToken: "fresh", expiresIn: 3600 }),
}));

const ACCOUNT = {
  id: "acc-1",
  org_id: "org-1",
  provider: "google",
  access_token: "token",
  refresh_token: "refresh",
  token_expires_at: null,
  capabilities: ["email", "sheets"],
  oauth_client_id: "1-org.apps.googleusercontent.com",
};

const SOURCE = {
  id: "src-1",
  org_id: "org-1",
  name: "Partner list",
  status: "active",
  workspace_id: null,
  marketing_source_id: null,
  project_id: null,
  assigned_telecaller_id: null,
  error_count: 0,
  sync_state: null as Record<string, unknown> | null,
  config: {
    spreadsheetId: "1BxiMVs0XRA5nFMdKvBd2hbGr9x",
    sheetName: "Leads",
    connectedAccountId: "8f14e45f-ceea-4a6b-a3f4-1b2c3d4e5f60",
    columnMapping: { Name: "name", Mobile: "phone" },
  } as Record<string, unknown>,
};

/** A client that answers the account lookup and records every write. */
function makeClient(account: unknown = ACCOUNT) {
  const writes: { sql: string; params: unknown[] }[] = [];
  return {
    writes,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      writes.push({ sql: String(sql).replace(/\s+/g, " "), params });
      if (String(sql).includes("FROM connected_accounts")) {
        return { rows: account ? [account] : [] };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
}

/** A fetch that returns one header row and the given data rows. */
function makeFetch(headers: string[], rows: string[][], ok = true, status = 200) {
  return vi.fn(async () =>
    ok
      ? ({
          ok: true,
          json: async () => ({
            valueRanges: [{ values: [headers] }, { values: rows }],
          }),
        } as unknown as Response)
      : ({ ok: false, status, text: async () => "denied" } as unknown as Response),
  );
}

beforeEach(() => {
  vi.resetModules();
  ingestIntakeLead.mockReset().mockResolvedValue("created");
});

async function load() {
  return import("./sheets-sync");
}

describe("first sync", () => {
  it("watches from the bottom and imports nothing", async () => {
    const client = makeClient();
    const { syncSheetSource } = await load();
    const created = await syncSheetSource(
      client as never,
      { ...SOURCE, sync_state: null } as never,
      makeFetch(
        ["Name", "Mobile"],
        [
          ["Priya", "900"],
          ["Ravi", "901"],
        ],
      ) as never,
    );

    // Connecting a sheet must not retroactively create the leads that were
    // already in it - they would arrive dated today, as new work, in front of
    // whoever opens the board.
    expect(created).toBe(0);
    expect(ingestIntakeLead).not.toHaveBeenCalled();
    // But the watermark IS set, or the next tick would import them all.
    const cursor = client.writes.find((w) => w.sql.includes("lastRowSynced"));
    expect(cursor?.params[1]).toBe(3); // header row 1 + 2 existing rows
  });

  it("imports the history when somebody explicitly asks", async () => {
    const client = makeClient();
    const { syncSheetSource } = await load();
    const created = await syncSheetSource(
      client as never,
      {
        ...SOURCE,
        sync_state: null,
        config: { ...SOURCE.config, importExisting: true },
      } as never,
      makeFetch(
        ["Name", "Mobile"],
        [
          ["Priya", "900"],
          ["Ravi", "901"],
        ],
      ) as never,
    );
    expect(created).toBe(2);
  });
});

describe("the header check", () => {
  it("stops and pauses the source when the columns changed", async () => {
    const client = makeClient();
    const { syncSheetSource, headerFingerprint } = await load();
    const created = await syncSheetSource(
      client as never,
      {
        ...SOURCE,
        sync_state: { lastRowSynced: 1, headerFingerprint: headerFingerprint(["Name", "Mobile"]) },
      } as never,
      // The sheet now has an extra column in front - every mapping is off by
      // one, and importing would put phone numbers in the name field.
      makeFetch(["Date", "Name", "Mobile"], [["1 Sep", "Priya", "900"]]) as never,
    );

    expect(created).toBe(0);
    expect(ingestIntakeLead).not.toHaveBeenCalled();
    // Paused rather than merely logged: the leads are still in the sheet and
    // can be imported once the mapping is fixed, whereas a thousand mis-parsed
    // leads cannot be un-created.
    expect(client.writes.some((w) => w.sql.includes("status = 'paused'"))).toBe(true);
    const error = client.writes.find((w) => w.sql.includes("last_error"));
    expect(String(error?.params[1])).toContain("columns in this sheet changed");
  });

  it("proceeds when the columns are unchanged", async () => {
    const client = makeClient();
    const { syncSheetSource, headerFingerprint } = await load();
    const created = await syncSheetSource(
      client as never,
      {
        ...SOURCE,
        sync_state: { lastRowSynced: 1, headerFingerprint: headerFingerprint(["Name", "Mobile"]) },
      } as never,
      makeFetch(["Name", "Mobile"], [["Priya", "900"]]) as never,
    );
    expect(created).toBe(1);
  });
});

describe("the connection", () => {
  it("refuses before the request when the grant never covered sheets", async () => {
    const client = makeClient({ ...ACCOUNT, capabilities: ["email", "calendar"] });
    const fetchImpl = makeFetch(["Name"], [["Priya"]]);
    const { syncSheetSource } = await load();

    const created = await syncSheetSource(
      client as never,
      { ...SOURCE, sync_state: { lastRowSynced: 1 } } as never,
      fetchImpl as never,
    );

    expect(created).toBe(0);
    // Checked BEFORE the call, so the message can say what to do. Google's own
    // 403 says "insufficient authentication scopes", which nobody can act on.
    expect(fetchImpl).not.toHaveBeenCalled();
    const error = client.writes.find((w) => w.sql.includes("last_error"));
    expect(String(error?.params[1])).toContain("reconnect");
  });

  it("says so when the account has been removed", async () => {
    const client = makeClient(null);
    const { syncSheetSource } = await load();
    expect(
      await syncSheetSource(
        client as never,
        { ...SOURCE, sync_state: { lastRowSynced: 1 } } as never,
        makeFetch(["Name"], []) as never,
      ),
    ).toBe(0);
    const error = client.writes.find((w) => w.sql.includes("last_error"));
    expect(String(error?.params[1])).toContain("Google account");
  });
});

describe("reading rows", () => {
  it("claims each row under an identity, not a row number", async () => {
    const client = makeClient();
    const { syncSheetSource } = await load();
    await syncSheetSource(
      client as never,
      { ...SOURCE, sync_state: { lastRowSynced: 5 } } as never,
      makeFetch(["Name", "Mobile"], [["Priya", "9876543210"]]) as never,
    );

    const [, , , , lead] = ingestIntakeLead.mock.calls[0] as unknown[];
    const input = lead as { externalId: string; phone: string | null };
    // A spreadsheet is not append-only: people insert rows, sort by name and
    // delete the ones they have called, and every one of those shifts the row
    // numbers below. An id derived from the row's own identity survives that;
    // a row number does not, and would re-import a block of leads.
    expect(input.externalId).toMatch(/^[0-9a-f]{40}$/);
    expect(input.phone).toContain("9876543210");
  });

  it("skips a blank spacer row without consuming an id", async () => {
    const client = makeClient();
    const { syncSheetSource } = await load();
    const created = await syncSheetSource(
      client as never,
      { ...SOURCE, sync_state: { lastRowSynced: 1 } } as never,
      makeFetch(["Name", "Mobile"], [[], ["Priya", "900"]]) as never,
    );
    expect(created).toBe(1);
    expect(ingestIntakeLead).toHaveBeenCalledTimes(1);
  });

  it("caps how much one tick imports", async () => {
    const client = makeClient();
    const rows = Array.from({ length: 500 }, (_, i) => [`Person ${i}`, `90000000${i}`]);
    const { syncSheetSource } = await load();
    await syncSheetSource(
      client as never,
      { ...SOURCE, sync_state: { lastRowSynced: 1 } } as never,
      makeFetch(["Name", "Mobile"], rows) as never,
    );
    // A backfill drains over several ticks rather than in one transaction that
    // holds a connection for minutes and floods the notification table.
    expect(ingestIntakeLead.mock.calls.length).toBe(200);
  });

  it("advances the watermark to the last row it looked at", async () => {
    const client = makeClient();
    const { syncSheetSource } = await load();
    await syncSheetSource(
      client as never,
      { ...SOURCE, sync_state: { lastRowSynced: 10 } } as never,
      makeFetch(
        ["Name", "Mobile"],
        [
          ["A", "1"],
          ["B", "2"],
          ["C", "3"],
        ],
      ) as never,
    );
    const cursor = client.writes.filter((w) => w.sql.includes("lastRowSynced")).at(-1);
    expect(cursor?.params[1]).toBe(13);
  });
});

describe("configuration", () => {
  it("does nothing but complain when the mapping is missing", async () => {
    const client = makeClient();
    const { syncSheetSource } = await load();
    const created = await syncSheetSource(
      client as never,
      { ...SOURCE, config: { spreadsheetId: "1BxiMVs0XRA5nFMdKvBd2hbGr9x" } } as never,
      makeFetch(["Name"], [["Priya"]]) as never,
    );
    expect(created).toBe(0);
    const error = client.writes.find((w) => w.sql.includes("last_error"));
    expect(String(error?.params[1])).toContain("not finished being set up");
  });
});
describe("the client's own switch (migration 0101)", () => {
  it("stops polling when the workspace switches Google Sheets off", async () => {
    // THE gate that could not be done in the console. Hiding the panel would
    // leave this sweep importing rows every ten minutes into a page that no
    // longer shows where they came from - "I turned Google Sheets off and
    // leads kept appearing" is the bug report a nav filter cannot prevent.
    adminQuery.mockClear();
    const { runSheetsSync } = await import("./sheets-sync");
    await runSheetsSync();

    const sql = String(adminQuery.mock.calls[0]?.[0] ?? "").replace(/\s+/g, " ");
    expect(sql).toContain("org_feature_enabled(o.id, $2, $3, $4)");

    // The key, module and default come from the catalogue rather than being
    // written here, so the worker and the console can never disagree about
    // what "off" means.
    const params = adminQuery.mock.calls[0]?.[1] as unknown[];
    expect(params.slice(1)).toEqual(["sheets_sync", "aura", true]);
  });
});
