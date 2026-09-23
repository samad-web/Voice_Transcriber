import { Controller, Get, NotFoundException, Param, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import {
  type AppConnection,
  type FeatureKey,
  type FeatureOverrides,
  type IntegrationActivity,
  type IntegrationDetail,
  type IntegrationSpec,
  type IntegrationStatus,
  OwnerRole,
  appGate,
  canManageApp,
  canSeeApp,
  integrationById,
  resolveFeatures,
  resolveOwnerRole,
  rollUpState,
  storeIntegrations,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgFeatureGuard, RequireFeature } from "../../common/org-feature.guard";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { AuthService } from "../auth/auth.service";
import { SNAPSHOT_SQL, activityStatements } from "./integration-sql";
import { type AppConnections, type StatusRows, type Viewer, connectionsByApp } from "./integration-status";

/**
 * The Integrations store's reads (doc 28 Part B): what every app's state is
 * for this viewer, and one app's connections and history.
 *
 * ── WHY THE STATUS IS COMPUTED AND NOT STORED ───────────────────────────────
 *
 * There is no `integrations` table and there should not be. Every app already
 * has a home - `messaging_channels`, `lead_sources`, `meta_connections`,
 * `connected_accounts`, `payment_gateway_config` - and a status column beside
 * them would be a second copy of a fact those tables already hold, kept in step
 * by hand. The first time somebody paused a lead source without remembering to
 * update the mirror, the store would start lying.
 *
 * So it is a read across a dozen tables, in ONE round trip. The database is
 * ~125ms away and node-postgres does not pipeline, so a dozen sequential
 * queries would cost over a second on the page people open to check that
 * nothing is broken. Same multi-statement shape `/v1/owner/overview` uses, and
 * the same constraint comes with it: the protocol takes no bind parameters, so
 * nothing caller-supplied appears in this SQL. It does not need to - every
 * predicate is a constant, RLS supplies the tenant, and the per-person filter
 * (whose mailbox is whose) happens in integration-status.ts.
 *
 * ── EVERY PERSONA, FILTERED HERE ────────────────────────────────────────────
 *
 * Opened to every persona (Q7): a telecaller connects their own Gmail here.
 * What each persona gets is decided on this side (`canSeeApp`), so the page
 * never receives a row it would have to hide.
 */
@Controller("owner/integrations")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard, OrgFeatureGuard)
@RequireFeature("integrations")
// Every persona - but a real one. The guard resolves it from `memberships`,
// so a bare admin key with no person behind it has no store to see.
@RequireOwnerRole(...OwnerRole.options)
export class IntegrationsController {
  constructor(
    private readonly db: DbService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  async list(@OrgId() orgId: string, @Req() req: PrincipalRequest) {
    const [viewer, snapshot] = await Promise.all([
      this.viewer(req, orgId),
      this.snapshot(orgId, []),
    ]);
    const byApp = connectionsByApp(snapshot.rows, viewer);
    const integrations: IntegrationStatus[] = storeIntegrations()
      .filter((spec) => canSeeApp(spec, viewer.role))
      .map((spec) => statusFor(spec, snapshot, byApp.get(spec.id), viewer))
      .filter((status) => status.state !== "hidden");
    return { integrations };
  }

  @Get(":id")
  async detail(
    @OrgId() orgId: string,
    @Param("id") id: string,
    @Req() req: PrincipalRequest,
  ): Promise<IntegrationDetail> {
    // Resolved against the catalogue before anything else: `id` never reaches
    // SQL, it only picks which constant activity statements are sent.
    const spec = integrationById(id);
    if (!spec || spec.unlisted) throw new NotFoundException("no such app");

    const [viewer, snapshot] = await Promise.all([
      this.viewer(req, orgId),
      this.snapshot(orgId, activityStatements(spec.id)),
    ]);
    // A persona that cannot see the app gets the same answer as a missing one.
    if (!canSeeApp(spec, viewer.role)) throw new NotFoundException("no such app");

    const conns = connectionsByApp(snapshot.rows, viewer).get(spec.id);
    const status = statusFor(spec, snapshot, conns, viewer);
    if (status.state === "hidden") throw new NotFoundException("no such app");

    return {
      status,
      connections: conns?.connections ?? [],
      activity: activityFrom(spec, snapshot.activity, viewer),
    };
  }

  /** Who is asking, resolved the way OwnerRoleGuard resolves it. */
  private async viewer(req: PrincipalRequest, orgId: string): Promise<Viewer> {
    const principal = req.principal;
    const userId = z.string().uuid().safeParse(principal?.userId);
    if (principal?.viaAdminKey && userId.success) {
      // From `memberships`, not from the header the request carried.
      const role = await this.auth.ownerRoleFor(userId.data, orgId);
      return { userId: userId.data, role: resolveOwnerRole(role) };
    }
    return {
      userId: userId.success ? userId.data : null,
      role: resolveOwnerRole(principal?.ownerRole),
    };
  }

  private async snapshot(orgId: string, extra: string[]): Promise<Snapshot> {
    return this.db.withOrg(orgId, async (client) => {
      const batch = (await client.query([...SNAPSHOT_SQL, ...extra].join(";\n"))) as unknown as {
        rows: Record<string, unknown>[];
      }[];
      const [
        orgRes,
        channelsRes,
        sourcesRes,
        metaRes,
        mcpRes,
        linkedinRes,
        accountsRes,
        gatewaysRes,
        appsRes,
        crmRes,
        keysRes,
        pendingRes,
        ...activityRes
      ] = batch;

      const org = orgRes.rows[0] ?? {};
      return {
        modules: Array.isArray(org.modules) ? (org.modules as string[]) : [],
        overrides: (org.overrides ?? {}) as FeatureOverrides,
        ownOAuthApps: new Set((appsRes.rows as Array<{ provider: string }>).map((r) => r.provider)),
        rows: {
          channels: channelsRes.rows,
          sources: sourcesRes.rows,
          metaPages: metaRes.rows,
          mcp: mcpRes.rows,
          linkedin: linkedinRes.rows,
          accounts: accountsRes.rows,
          gateways: gatewaysRes.rows,
          crm: crmRes.rows,
          apiKeys: keysRes.rows,
          pending: pendingRes.rows,
        } as unknown as StatusRows,
        activity: activityRes.flatMap((r) => r.rows as unknown as ActivityRow[]),
      };
    });
  }
}

interface Snapshot {
  modules: string[];
  overrides: FeatureOverrides;
  ownOAuthApps: Set<string>;
  rows: StatusRows;
  activity: ActivityRow[];
}

/* ── Status ──────────────────────────────────────────────────────────────── */

function statusFor(
  spec: IntegrationSpec,
  snapshot: Snapshot,
  conns: AppConnections | undefined,
  viewer: Viewer,
): IntegrationStatus {
  const features = resolveFeatures(snapshot.modules, snapshot.overrides);
  const gate = appGate({
    spec,
    featureState: spec.feature ? (features.get(spec.feature as FeatureKey)?.state ?? "off") : null,
    modules: snapshot.modules,
    hasEnv: (key) => Boolean(process.env[key]?.trim()),
    ownOAuthApps: snapshot.ownOAuthApps,
  });
  const connections: AppConnection[] = conns?.connections ?? [];
  const canManage = canManageApp(spec, viewer.role);
  const base = {
    id: spec.id,
    count: connections.filter((c) => c.state === "connected").length,
    total: connections.length,
    teamCount: conns?.teamCount ?? null,
    canManage,
  };

  // Switched off or not on the plan: nothing else is worth saying. Not
  // AVAILABLE is weaker - an org that connected a sheet before the operator
  // unset the variable still has a sheet syncing, and the store must show it.
  if (gate === "hidden" || gate === "not_entitled" || (gate === "unavailable" && connections.length === 0)) {
    return { ...base, state: gate, attentionReason: null };
  }

  const state = rollUpState(connections);
  const failing = connections.find((c) => c.state === "attention");
  return {
    ...base,
    state,
    attentionReason: failing ? (failing.lastError ?? `${failing.label} needs attention.`) : null,
  };
}

/* ── Activity ────────────────────────────────────────────────────────────── */

interface ActivityRow {
  /** A Date from node-postgres; normalised to ISO in activityFrom. */
  at: string | Date;
  actor: string | null;
  actor_id: string | null;
  action: string;
  target: string | null;
  reason: string | null;
}

const ACTIVITY_TEXT: Record<string, (target: string) => string> = {
  "lead_source.create": (t) => `connected "${t}"`,
  "lead_source.update": (t) => `changed "${t}"`,
  "lead_source.rotate_token": (t) => `replaced the address for "${t}"`,
  "meta_connection.create": () => "connected a Facebook Page",
  "meta_connection.revoke": () => "disconnected a Facebook Page",
  "mcp_connection.connect": () => "connected an MCP server",
  "mcp_connection.disconnect": () => "disconnected an MCP server",
  "linkedin_connection.create": () => "signed in to LinkedIn",
  "linkedin_connection.select": () => "chose a LinkedIn ad account",
  "linkedin_connection.disconnect": () => "disconnected LinkedIn",
  "payment_gateway.update": () => "saved the payment settings",
  "connection.connect": () => "connected an account",
  "connection.disconnect": () => "disconnected an account",
};

/** Sign-ins that came back refused or broken - history worth reading in orange. */
const FAILED_ACTIONS: Record<string, string> = {
  "meta_connection.connect_failed": "tried to connect Facebook, and it did not finish",
  "linkedin_connection.connect_failed": "tried to connect LinkedIn, and it did not finish",
};

function activityFrom(spec: IntegrationSpec, rows: ActivityRow[], viewer: Viewer): IntegrationActivity[] {
  const personal = spec.scope === "person";
  return rows
    // A person app's history is the caller's own, and nobody else's.
    .filter((r) => !personal || (viewer.userId !== null && r.actor_id === viewer.userId))
    .map((r): IntegrationActivity => {
      const at = new Date(r.at).toISOString();
      if (r.action.startsWith("intake.")) {
        return {
          at,
          actor: null,
          text: `"${r.target ?? "A source"}" turned away a delivery${r.reason ? `: ${r.reason}` : ""}`,
          tone: "attention",
        };
      }
      const failed = FAILED_ACTIONS[r.action];
      if (failed) return { at, actor: r.actor, text: failed, tone: "attention" };
      const describe = ACTIVITY_TEXT[r.action];
      return {
        at,
        actor: r.actor,
        text: describe ? describe(r.target ?? "a source") : r.action,
        tone: "neutral",
      };
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 20);
}
