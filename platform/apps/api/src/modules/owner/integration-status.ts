import {
  type AppConnection,
  CHANNEL_PROBE_OUTCOMES,
  type ChannelProbeOutcome,
  type ConnectionState,
  type OwnerRole,
  providersForKind,
  readChannel,
} from "@aura/shared";

/**
 * Provider rows → the store's connections, per app (doc 28 §8.2).
 *
 * Pure, so the whole derivation table - "a LinkedIn row whose account is still
 * `pending:` is CONNECTING, not connected" - is a unit test rather than a
 * database session. The controller does the one round trip and hands the rows
 * here; nothing in this file knows SQL.
 *
 * ── WHOSE ROWS A VIEWER SEES ────────────────────────────────────────────────
 *
 * An org app's connections are the org's, and anyone who can see the app sees
 * them. A PERSON app (a mailbox, a personal WhatsApp) is different: its state
 * is the caller's own, and nobody else's rows are listed - not their address,
 * not their number. Owners and managers get a count instead ("3 people have
 * linked one"), which is the oversight they need without reading anybody's
 * inbox by proxy. 0125 made personal WhatsApp private to its owner, and this
 * does not reopen that through a side door.
 */

export interface ChannelRow {
  id: string;
  channel: string;
  provider: string;
  inbound_address: string;
  display_name: string | null;
  status: "active" | "disabled";
  has_api_key: boolean;
  has_forward_secret: boolean;
  last_probe_at: string | null;
  last_probe_outcome: string | null;
  last_probe_detail: string | null;
  last_inbound_at: string | null;
  owner_user_id: string | null;
  created_at: string;
}

export interface SourceRow {
  id: string;
  kind: string;
  name: string;
  provider: string;
  status: "active" | "paused" | "disabled";
  last_event_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  event_count: number;
  created_at: string;
  created_by: string | null;
}

export interface MetaPageRow {
  id: string;
  page_name: string | null;
  page_id: string;
  created_at: string;
  updated_at: string;
  connected_by: string | null;
}

export interface McpRow {
  id: string;
  label: string | null;
  server_url: string;
  status: "connected" | "error" | "revoked";
  last_error: string | null;
  last_sync_at: string | null;
  created_at: string;
  created_by: string | null;
}

export interface LinkedInRow {
  id: string;
  account_urn: string;
  account_name: string | null;
  status: "active" | "expired" | "revoked" | "error";
  last_synced_at: string | null;
  sync_failures: number;
  last_error: string | null;
  created_at: string;
  connected_by: string | null;
}

export interface AccountRow {
  id: string;
  user_id: string;
  provider: string;
  account_email: string;
  display_name: string | null;
  status: "active" | "expired" | "revoked" | "error";
  last_error: string | null;
  last_synced_at: string | null;
  created_at: string;
}

export interface GatewayRow {
  provider: string;
  enabled: boolean;
  configured: boolean;
  has_secret: boolean;
  updated_at: string;
}

export interface CrmRow {
  id: string;
  provider: string;
  label: string | null;
  status: "connected" | "disconnected" | "error";
  updated_at: string;
  created_at: string;
}

export interface ApiKeyRow {
  id: string;
  name: string | null;
  prefix: string;
  last_used_at: string | null;
  created_at: string;
}

/** A pending Meta page choice (doc 28 §11.3) - a connect somebody started. */
export interface PendingChoiceRow {
  id: string;
  provider: string;
  user_id: string;
  created_at: string;
}

export interface StatusRows {
  channels: ChannelRow[];
  sources: SourceRow[];
  metaPages: MetaPageRow[];
  mcp: McpRow[];
  linkedin: LinkedInRow[];
  accounts: AccountRow[];
  gateways: GatewayRow[];
  crm: CrmRow[];
  apiKeys: ApiKeyRow[];
  pending: PendingChoiceRow[];
}

export interface Viewer {
  userId: string | null;
  role: OwnerRole;
}

export interface AppConnections {
  connections: AppConnection[];
  /** Person apps, owner and manager only: distinct people with a working one. */
  teamCount: number | null;
}

const conn = (c: Omit<AppConnection, "detail" | "mine" | "lastError"> & Partial<AppConnection>): AppConnection => ({
  detail: null,
  lastError: null,
  mine: false,
  ...c,
});

/* ── Messaging ───────────────────────────────────────────────────────────── */

const CHANNEL_KIND_LABEL: Record<string, string> = {
  waba: "Direct through Meta",
  wasi: "Through Wasi",
  meta: "Direct through Meta",
  evolution: "Linked phone",
};

/**
 * A channel's store state, from the same `readChannel` the Messaging page
 * uses - so the store and that page can never disagree about a number.
 */
export function channelState(row: ChannelRow): { state: ConnectionState; error: string | null } {
  if (row.provider === "evolution") {
    // Whether the phone is still linked is a question only the relay can
    // answer; the app page asks it live. From the row alone: switched off,
    // never finished, or linked.
    if (row.status === "disabled") return { state: "paused", error: null };
    return { state: row.has_api_key ? "connected" : "connecting", error: null };
  }
  const reading = readChannel({
    provider: row.provider,
    status: row.status,
    hasApiKey: row.has_api_key,
    hasForwardSecret: row.has_forward_secret,
    lastProbeAt: row.last_probe_at,
    // No CHECK on the column (0110); an unrecognised value reads as "never probed".
    lastProbeOutcome: CHANNEL_PROBE_OUTCOMES.includes(row.last_probe_outcome as ChannelProbeOutcome)
      ? (row.last_probe_outcome as ChannelProbeOutcome)
      : null,
    lastProbeDetail: row.last_probe_detail,
    lastInboundAt: row.last_inbound_at,
  });
  switch (reading.readiness) {
    case "disabled":
      return { state: "paused", error: null };
    case "incomplete":
    case "unverified":
      return { state: "connecting", error: null };
    case "connected":
      return { state: "connected", error: null };
    default:
      // send_only, credentials_rejected, unreachable: somebody has to act.
      return { state: "attention", error: row.last_probe_detail ?? reading.detail };
  }
}

function channelConnections(rows: ChannelRow[], channel: string, providers?: string[]): AppConnection[] {
  return rows
    .filter((r) => r.channel === channel && (!providers || providers.includes(r.provider)))
    .map((r) => {
      const { state, error } = channelState(r);
      return conn({
        id: r.id,
        rowKind: "channel",
        label: r.display_name ? `${r.display_name} · ${r.inbound_address}` : r.inbound_address,
        detail: CHANNEL_KIND_LABEL[r.provider] ?? r.provider,
        state,
        lastError: error,
        lastActivityAt: r.last_inbound_at,
        connectedBy: null,
        connectedAt: r.created_at,
      });
    });
}

/* ── Lead sources ────────────────────────────────────────────────────────── */

/**
 * `disabled` is how a source is retired (there is no DELETE, 0078), so it is
 * not a connection any more. A source that has never received anything is
 * CONNECTED - it is waiting for its first lead, which is the provider's move,
 * not a setup the person left unfinished.
 */
export function sourceState(row: SourceRow): ConnectionState {
  if (row.status === "paused") return "paused";
  const errorAt = epochMs(row.last_error_at);
  const eventAt = epochMs(row.last_event_at) ?? Number.NEGATIVE_INFINITY;
  if (errorAt !== null && errorAt > eventAt) return "attention";
  return "connected";
}

/**
 * node-postgres hands back `timestamptz` as a Date, not the ISO string the row
 * types say; `Date.parse(date)` would round-trip through `toString()` and drop
 * the milliseconds, which is exactly the precision an error-vs-event race
 * needs.
 */
export function epochMs(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

const SOURCE_KIND_LABEL: Record<string, string> = {
  meta_ads: "Webhook relay",
  web_form: "Web form",
  email: "Email forwarding",
  api: "API",
  sheets: "Google Sheet",
  telephony: "Telephony",
};

function sourceConnections(rows: SourceRow[], match: (r: SourceRow) => boolean): AppConnection[] {
  return rows
    .filter((r) => r.status !== "disabled" && match(r))
    .map((r) => {
      const state = sourceState(r);
      const kind = SOURCE_KIND_LABEL[r.kind] ?? r.kind;
      return conn({
        id: r.id,
        rowKind: "lead_source",
        label: r.name,
        detail:
          r.last_event_at === null && state === "connected"
            ? `${kind} · waiting for the first lead`
            : r.provider && r.provider !== "generic"
              ? `${kind} · ${r.provider}`
              : kind,
        state,
        lastError: state === "attention" ? r.last_error : null,
        lastActivityAt: r.last_event_at,
        connectedBy: r.created_by,
        connectedAt: r.created_at,
      });
    });
}

/* ── Meta, LinkedIn, MCP ─────────────────────────────────────────────────── */

function metaConnections(rows: StatusRows, viewer: Viewer): AppConnection[] {
  const pages = rows.metaPages.map((p) =>
    conn({
      id: p.id,
      rowKind: "meta_page",
      label: p.page_name ?? `Page ${p.page_id}`,
      detail: "Facebook Page",
      state: "connected",
      lastActivityAt: p.updated_at,
      connectedBy: p.connected_by,
      connectedAt: p.created_at,
    }),
  );
  const servers = rows.mcp.map((m) =>
    conn({
      id: m.id,
      rowKind: "mcp_server",
      label: m.label ?? m.server_url,
      detail: "Through an MCP server",
      state: m.status === "error" ? "attention" : "connected",
      lastError: m.status === "error" ? m.last_error : null,
      lastActivityAt: m.last_sync_at,
      connectedBy: m.created_by,
      connectedAt: m.created_at,
    }),
  );
  // A sign-in that came back with pages to choose from and has not been
  // finished. Only the person who started it can pick up where they left off.
  const pending = rows.pending
    .filter((p) => p.provider === "meta")
    .map((p) =>
      conn({
        id: p.id,
        rowKind: "pending_choice",
        label: "Pages waiting to be chosen",
        detail: "Signed in to Facebook - choose which Pages send leads",
        state: "connecting",
        lastActivityAt: null,
        connectedBy: null,
        connectedAt: p.created_at,
        mine: p.user_id === viewer.userId,
      }),
    );
  // The third way Meta leads arrive: a webhook source that another tool
  // relays lead-ad submissions into (lead_sources.kind 'meta_ads').
  const relays = sourceConnections(rows.sources, (s) => s.kind === "meta_ads");
  return [...pending, ...pages, ...servers, ...relays];
}

export function linkedinState(row: LinkedInRow): ConnectionState {
  // The callback writes `pending:<uuid>` with status 'active' before anyone
  // has chosen an ad account; the old hub counted that as connected.
  if (row.account_urn.startsWith("pending:")) return "connecting";
  if (row.status === "expired" || row.status === "error") return "attention";
  if (row.sync_failures > 0) return "attention";
  return "connected";
}

function linkedinConnections(rows: LinkedInRow[]): AppConnection[] {
  return rows.map((r) => {
    const state = linkedinState(r);
    return conn({
      id: r.id,
      rowKind: "linkedin_account",
      label: state === "connecting" ? "Ad account not chosen yet" : (r.account_name ?? r.account_urn),
      detail: "LinkedIn ad account",
      state,
      lastError: state === "attention" ? (r.last_error ?? "LinkedIn stopped answering Aura's requests.") : null,
      lastActivityAt: r.last_synced_at,
      connectedBy: r.connected_by,
      connectedAt: r.created_at,
    });
  });
}

/* ── Personal accounts ───────────────────────────────────────────────────── */

function personApp(all: AppConnection[], owners: (string | null)[], viewer: Viewer): AppConnections {
  const mine = all.filter((c) => c.mine);
  const admin = viewer.role === "owner" || viewer.role === "manager";
  const team = new Set(
    all.flatMap((c, i) => (c.state === "connected" && owners[i] ? [owners[i]!] : [])),
  );
  return { connections: mine, teamCount: admin ? team.size : null };
}

function accountApp(rows: AccountRow[], provider: string, viewer: Viewer): AppConnections {
  const matching = rows.filter((r) => r.provider === provider);
  const all = matching.map((r) =>
    conn({
      id: r.id,
      rowKind: "mailbox",
      label: r.account_email,
      detail: r.display_name,
      state: r.status === "expired" || r.status === "error" ? "attention" : "connected",
      lastError:
        r.status === "expired"
          ? (r.last_error ?? "The sign-in expired. Connect the account again to resume syncing.")
          : r.status === "error"
            ? r.last_error
            : null,
      lastActivityAt: r.last_synced_at,
      connectedBy: null,
      connectedAt: r.created_at,
      mine: r.user_id === viewer.userId,
    }),
  );
  return personApp(all, matching.map((r) => r.user_id), viewer);
}

function personalWhatsApp(rows: ChannelRow[], viewer: Viewer): AppConnections {
  const matching = rows.filter(
    (r) => r.channel === "whatsapp" && (providersForKind("personal") as readonly string[]).includes(r.provider),
  );
  const all = matching.map((r) => {
    const { state } = channelState(r);
    return conn({
      id: r.id,
      rowKind: "channel",
      label: r.inbound_address,
      detail: "Linked phone",
      state,
      lastActivityAt: r.last_inbound_at,
      connectedBy: null,
      connectedAt: r.created_at,
      mine: r.owner_user_id !== null && r.owner_user_id === viewer.userId,
    });
  });
  return personApp(all, matching.map((r) => r.owner_user_id), viewer);
}

/* ── Payments, CRM, API ──────────────────────────────────────────────────── */

export function gatewayConnections(rows: GatewayRow[], provider: string): AppConnection[] {
  const row = rows.find((g) => g.provider === provider);
  if (!row) return [];
  const keyed = row.configured && row.has_secret;
  const state: ConnectionState = !keyed ? "connecting" : row.enabled ? "connected" : "paused";
  return [
    conn({
      id: provider,
      rowKind: "gateway",
      label: provider === "razorpay" ? "Razorpay account" : "Stripe account",
      detail: keyed ? "Keys saved" : "Keys not saved yet",
      state,
      lastActivityAt: row.updated_at,
      connectedBy: null,
      connectedAt: row.updated_at,
    }),
  ];
}

function crmConnections(rows: CrmRow[], provider: string): AppConnection[] {
  return rows
    .filter((r) => r.provider === provider)
    .map((r) =>
      conn({
        id: r.id,
        rowKind: "crm_connector",
        label: r.label ?? "Connector",
        detail: "Set up by your provider",
        state: r.status === "error" ? "attention" : r.status === "connected" ? "connected" : "paused",
        lastError: r.status === "error" ? "Deliveries to this system are failing." : null,
        lastActivityAt: r.updated_at,
        connectedBy: null,
        connectedAt: r.created_at,
      }),
    );
}

function apiKeyConnections(rows: ApiKeyRow[]): AppConnection[] {
  return rows.map((k) =>
    conn({
      id: k.id,
      rowKind: "api_key",
      label: k.name ?? `Key ${k.prefix}…`,
      detail: `${k.prefix}…`,
      state: "connected",
      lastActivityAt: k.last_used_at,
      connectedBy: null,
      connectedAt: k.created_at,
    }),
  );
}

/* ── Every app at once ───────────────────────────────────────────────────── */

const org = (connections: AppConnection[]): AppConnections => ({ connections, teamCount: null });

/** The connections each app shows this viewer, keyed by catalogue id. */
export function connectionsByApp(rows: StatusRows, viewer: Viewer): Map<string, AppConnections> {
  const out = new Map<string, AppConnections>();
  const put = (id: string, value: AppConnections) => out.set(id, value);

  put("whatsapp_waba", org(channelConnections(rows.channels, "whatsapp", providersForKind("waba"))));
  put("whatsapp_personal", personalWhatsApp(rows.channels, viewer));
  put("instagram", org(channelConnections(rows.channels, "instagram")));
  put("facebook_messenger", org(channelConnections(rows.channels, "facebook")));

  put("meta_lead_ads", org(metaConnections(rows, viewer)));
  put("google_sheets", org(sourceConnections(rows.sources, (s) => s.kind === "sheets")));
  put("linkedin_ads", org(linkedinConnections(rows.linkedin)));
  put("web_forms", org(sourceConnections(rows.sources, (s) => ["web_form", "email", "api"].includes(s.kind))));

  put("razorpay", org(gatewayConnections(rows.gateways, "razorpay")));
  put("stripe", org(gatewayConnections(rows.gateways, "stripe")));

  put("superfone", org(sourceConnections(rows.sources, (s) => s.kind === "telephony" && s.provider === "superfone")));
  put("cti", org(sourceConnections(rows.sources, (s) => s.kind === "telephony" && s.provider !== "superfone")));

  put("google_workspace", accountApp(rows.accounts, "google", viewer));
  put("microsoft_365", accountApp(rows.accounts, "microsoft", viewer));
  put("smtp", accountApp(rows.accounts, "imap", viewer));

  for (const provider of new Set(rows.crm.map((r) => r.provider))) {
    put(`crm_${provider}`, org(crmConnections(rows.crm, provider)));
  }
  put("aura_api", org(apiKeyConnections(rows.apiKeys)));
  return out;
}
