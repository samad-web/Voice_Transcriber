import { rollUpState } from "@aura/shared";
import {
  type ChannelRow,
  type LinkedInRow,
  type SourceRow,
  type StatusRows,
  channelState,
  connectionsByApp,
  epochMs,
  gatewayConnections,
  linkedinState,
  sourceState,
} from "./integration-status";

/**
 * Provider rows → store states (doc 28 §8.2, §19.1). Each case is a row shape
 * the old hub got wrong or never looked at.
 */

const ME = "11111111-1111-4111-8111-111111111111";
const THEM = "22222222-2222-4222-8222-222222222222";

const empty = (): StatusRows => ({
  channels: [],
  sources: [],
  metaPages: [],
  mcp: [],
  linkedin: [],
  accounts: [],
  gateways: [],
  crm: [],
  apiKeys: [],
  pending: [],
});

const channel = (over: Partial<ChannelRow> = {}): ChannelRow => ({
  id: "c1",
  channel: "whatsapp",
  provider: "waba",
  inbound_address: "+919800000001",
  display_name: "Sales",
  status: "active",
  has_api_key: true,
  has_forward_secret: false,
  last_probe_at: "2026-09-20T10:00:00Z",
  last_probe_outcome: "ok",
  last_probe_detail: null,
  last_inbound_at: "2026-09-21T10:00:00Z",
  owner_user_id: null,
  created_at: "2026-09-01T00:00:00Z",
  ...over,
});

const source = (over: Partial<SourceRow> = {}): SourceRow => ({
  id: "s1",
  kind: "sheets",
  name: "Leads Q3",
  provider: "generic",
  status: "active",
  last_event_at: null,
  last_error: null,
  last_error_at: null,
  event_count: 0,
  created_at: "2026-09-01T00:00:00Z",
  created_by: "Priya",
  ...over,
});

const linkedin = (over: Partial<LinkedInRow> = {}): LinkedInRow => ({
  id: "l1",
  account_urn: "urn:li:sponsoredAccount:1",
  account_name: "Acme ads",
  status: "active",
  last_synced_at: null,
  sync_failures: 0,
  last_error: null,
  created_at: "2026-09-01T00:00:00Z",
  connected_by: null,
  ...over,
});

describe("messaging channels", () => {
  it("reads a probed WABA number as connected", () => {
    expect(channelState(channel()).state).toBe("connected");
  });

  it("reads a number never checked, or missing its key, as unfinished", () => {
    expect(channelState(channel({ last_probe_at: null, last_probe_outcome: null })).state).toBe("connecting");
    expect(channelState(channel({ has_api_key: false })).state).toBe("connecting");
  });

  it("reads a refused key as needing attention, in the probe's own words", () => {
    const read = channelState(
      channel({ last_probe_outcome: "credentials_rejected", last_probe_detail: "Invalid OAuth access token" }),
    );
    expect(read).toEqual({ state: "attention", error: "Invalid OAuth access token" });
  });

  it("reads a switched-off number as paused", () => {
    expect(channelState(channel({ status: "disabled" })).state).toBe("paused");
  });

  it("treats a probe outcome it does not recognise as never probed, not as a pass", () => {
    expect(channelState(channel({ last_probe_outcome: "maybe" })).state).toBe("connecting");
  });
});

describe("lead sources", () => {
  it("is connected and waiting when nothing has arrived yet - not unfinished", () => {
    expect(sourceState(source())).toBe("connected");
    const [only] = connectionsByApp({ ...empty(), sources: [source()] }, { userId: ME, role: "owner" }).get(
      "google_sheets",
    )!.connections;
    expect(only?.detail).toMatch(/waiting for the first lead/);
  });

  it("needs attention when the last error is newer than the last event", () => {
    expect(
      sourceState(source({ last_event_at: "2026-09-20T10:00:00Z", last_error_at: "2026-09-21T10:00:00Z" })),
    ).toBe("attention");
    expect(
      sourceState(source({ last_event_at: "2026-09-22T10:00:00Z", last_error_at: "2026-09-21T10:00:00Z" })),
    ).toBe("connected");
  });

  it("compares Dates the way node-postgres returns them, to the millisecond", () => {
    const event = new Date("2026-09-21T10:00:00.100Z");
    const error = new Date("2026-09-21T10:00:00.900Z");
    expect(sourceState(source({ last_event_at: event as never, last_error_at: error as never }))).toBe(
      "attention",
    );
    expect(epochMs(null)).toBeNull();
  });

  it("is paused when a person paused it, and gone when it was retired", () => {
    expect(sourceState(source({ status: "paused" }))).toBe("paused");
    const conns = connectionsByApp({ ...empty(), sources: [source({ status: "disabled" })] }, { userId: ME, role: "owner" });
    expect(conns.get("google_sheets")!.connections).toEqual([]);
  });

  it("files each kind under its own app", () => {
    const rows = {
      ...empty(),
      sources: [
        source({ id: "a", kind: "web_form" }),
        source({ id: "b", kind: "telephony", provider: "superfone" }),
        source({ id: "c", kind: "telephony", provider: "exotel" }),
        source({ id: "d", kind: "sheets" }),
      ],
    };
    const byApp = connectionsByApp(rows, { userId: ME, role: "owner" });
    expect(byApp.get("web_forms")!.connections.map((c) => c.id)).toEqual(["a"]);
    expect(byApp.get("superfone")!.connections.map((c) => c.id)).toEqual(["b"]);
    expect(byApp.get("cti")!.connections.map((c) => c.id)).toEqual(["c"]);
    expect(byApp.get("google_sheets")!.connections.map((c) => c.id)).toEqual(["d"]);
  });
});

describe("LinkedIn", () => {
  it("reads a `pending:` account as connecting - the old hub counted it as connected", () => {
    expect(linkedinState(linkedin({ account_urn: "pending:abc" }))).toBe("connecting");
  });

  it("needs attention on an expired grant or repeated sync failures", () => {
    expect(linkedinState(linkedin({ status: "expired" }))).toBe("attention");
    expect(linkedinState(linkedin({ sync_failures: 3 }))).toBe("attention");
    expect(linkedinState(linkedin())).toBe("connected");
  });
});

describe("Meta lead ads", () => {
  it("counts an MCP server as a way in - the old hub never looked", () => {
    const rows: StatusRows = {
      ...empty(),
      mcp: [
        {
          id: "m1",
          label: null,
          server_url: "https://mcp.example.com",
          status: "error",
          last_error: "401 from the server",
          last_sync_at: null,
          created_at: "2026-09-01T00:00:00Z",
          created_by: null,
        },
      ],
    };
    const conns = connectionsByApp(rows, { userId: ME, role: "owner" }).get("meta_lead_ads")!.connections;
    expect(rollUpState(conns)).toBe("attention");
    expect(conns[0]!.lastError).toBe("401 from the server");
  });

  it("counts a webhook relay as a third way in, as a lead source (pausable, not revocable)", () => {
    const rows: StatusRows = { ...empty(), sources: [source({ id: "r1", kind: "meta_ads", name: "Zap relay" })] };
    const conns = connectionsByApp(rows, { userId: ME, role: "owner" }).get("meta_lead_ads")!.connections;
    expect(conns.map((c) => [c.id, c.rowKind])).toEqual([["r1", "lead_source"]]);
    // And it is not double-counted under Web forms.
    expect(connectionsByApp(rows, { userId: ME, role: "owner" }).get("web_forms")!.connections).toEqual([]);
  });

  it("marks which table each row came from, so the console offers the right controls", () => {
    const rows: StatusRows = {
      ...empty(),
      metaPages: [
        { id: "pg", page_id: "1", page_name: "Acme", created_at: "x", updated_at: "x", connected_by: null },
      ],
      pending: [{ id: "p1", provider: "meta", user_id: ME, created_at: "x" }],
    };
    const kinds = connectionsByApp(rows, { userId: ME, role: "owner" })
      .get("meta_lead_ads")!
      .connections.map((c) => c.rowKind);
    expect(kinds).toEqual(["pending_choice", "meta_page"]);
  });

  it("shows a sign-in waiting for its page choice as unfinished", () => {
    const rows: StatusRows = {
      ...empty(),
      pending: [{ id: "p1", provider: "meta", user_id: ME, created_at: "2026-09-22T00:00:00Z" }],
    };
    const conns = connectionsByApp(rows, { userId: ME, role: "owner" }).get("meta_lead_ads")!.connections;
    expect(rollUpState(conns)).toBe("connecting");
    expect(conns[0]!.mine).toBe(true);
  });
});

describe("payments", () => {
  it("is connected only with both keys and switched on", () => {
    const row = { provider: "razorpay", enabled: true, configured: true, has_secret: true, updated_at: "x" };
    expect(gatewayConnections([row], "razorpay")[0]!.state).toBe("connected");
    expect(gatewayConnections([{ ...row, has_secret: false }], "razorpay")[0]!.state).toBe("connecting");
    expect(gatewayConnections([{ ...row, enabled: false }], "razorpay")[0]!.state).toBe("paused");
    expect(gatewayConnections([], "razorpay")).toEqual([]);
  });
});

describe("person apps are private to the person", () => {
  const rows: StatusRows = {
    ...empty(),
    accounts: [
      {
        id: "a1",
        user_id: ME,
        provider: "google",
        account_email: "me@acme.in",
        display_name: null,
        status: "active",
        last_error: null,
        last_synced_at: null,
        created_at: "2026-09-01T00:00:00Z",
      },
      {
        id: "a2",
        user_id: THEM,
        provider: "google",
        account_email: "them@acme.in",
        display_name: null,
        status: "expired",
        last_error: null,
        last_synced_at: null,
        created_at: "2026-09-01T00:00:00Z",
      },
    ],
    channels: [channel({ id: "p1", provider: "evolution", owner_user_id: THEM, inbound_address: "+919811111111" })],
  };

  it("lists only the caller's own mailbox, and states it from theirs alone", () => {
    const google = connectionsByApp(rows, { userId: ME, role: "telecaller" }).get("google_workspace")!;
    expect(google.connections.map((c) => c.id)).toEqual(["a1"]);
    // Their colleague's expired grant is not the caller's problem.
    expect(rollUpState(google.connections)).toBe("connected");
    expect(google.teamCount).toBeNull();
  });

  it("gives owners and managers a count, never the other people's addresses", () => {
    const google = connectionsByApp(rows, { userId: ME, role: "owner" }).get("google_workspace")!;
    expect(google.connections.map((c) => c.label)).toEqual(["me@acme.in"]);
    expect(google.teamCount).toBe(1);
  });

  it("never lists somebody else's personal WhatsApp number (0125)", () => {
    const wa = connectionsByApp(rows, { userId: ME, role: "owner" }).get("whatsapp_personal")!;
    expect(wa.connections).toEqual([]);
    expect(wa.teamCount).toBe(1);
  });
});
