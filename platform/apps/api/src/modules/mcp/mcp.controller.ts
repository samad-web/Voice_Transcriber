import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { assertPublicHttpUrl, decryptSecret, encryptSecret } from "@aura/db";
import { findTool, LEAD_TOOL_CANDIDATES, McpClient } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OperatorMayCall, OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { auditActor } from "../../common/audit-actor";

const ConnectBody = z.object({
  provider: z.enum(["meta"]),
  label: z.string().max(120).nullish(),
  serverUrl: z.string().url().max(2000),
  accessToken: z.string().min(1).max(4000).nullish(),
});

/**
 * Columns every read returns. `access_token` is deliberately absent - the
 * same rule connections.controller.ts's CONNECTION_COLUMNS follows: a
 * credential that is never selected cannot be leaked by a future endpoint
 * that forgets to strip it.
 */
const CONNECTION_COLUMNS = `
  id, provider, label, server_url, status, last_error,
  server_info, tools, last_sync_at, created_at, updated_at`;

/**
 * MCP server connections (migration 0074) - today, the tenant's Meta MCP.
 *
 * Org CONFIGURATION, so AdminKeyGuard+TenantGuard, the same tier as
 * marketing-sources, pipelines and projects. Note this differs deliberately
 * from `connections.controller.ts`, which refuses the bare admin key because
 * a mailbox connection belongs to a signed-in PERSON. An MCP server does not:
 * it is the company's Meta ad account, it keeps working when the person who
 * connected it leaves, and the worker sweep that reads it has no user at all.
 *
 * ── SSRF ────────────────────────────────────────────────────────────────
 *
 * `server_url` is tenant-supplied and this service POSTs to it. Every
 * outbound request goes through assertPublicHttpUrl first, injected into the
 * client rather than checked once at save time - a hostname that resolves to
 * a public address when saved and a link-local one an hour later is the whole
 * point of re-checking.
 */
@Controller("mcp/connections")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
@OperatorMayCall()
@RequireOwnerRole("owner", "manager", "marketing")
export class McpController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT ${CONNECTION_COLUMNS} FROM mcp_connections
          WHERE org_id = $1 AND status <> 'revoked'
          ORDER BY provider`,
        [orgId],
      );
      return { connections: rows };
    });
  }

  /**
   * Connect, verifying before storing.
   *
   * The handshake runs FIRST and a failure is a 400, so a server URL that
   * does not answer never becomes a saved "connected" row the owner has to
   * discover is broken from a silent sweep three hours later.
   */
  @Post()
  async connect(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Body() body: unknown,
  ) {
    const parsed = ConnectBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { provider, label, serverUrl, accessToken } = parsed.data;

    const probe = await probeServer(serverUrl, accessToken ?? null);
    if (probe.error) throw new BadRequestException(probe.error);

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [connection],
      } = await client.query(
        `INSERT INTO mcp_connections
           (org_id, provider, label, server_url, access_token, status,
            server_info, tools, created_by_user_id, last_error)
         VALUES ($1, $2, $3, $4, $5, 'connected', $6::jsonb, $7::jsonb, $8, NULL)
         -- Reconnecting replaces the credential and re-reads the tool list
         -- rather than erroring; a rotated token is the common case.
         ON CONFLICT (org_id, provider) WHERE status <> 'revoked'
         DO UPDATE SET
           label        = EXCLUDED.label,
           server_url   = EXCLUDED.server_url,
           access_token = EXCLUDED.access_token,
           status       = 'connected',
           last_error   = NULL,
           server_info  = EXCLUDED.server_info,
           tools        = EXCLUDED.tools
         RETURNING ${CONNECTION_COLUMNS}`,
        [
          orgId,
          provider,
          label ?? null,
          serverUrl,
          accessToken ? encryptSecret(accessToken) : null,
          JSON.stringify(probe.serverInfo ?? {}),
          JSON.stringify(probe.tools),
          actorUserId(req),
        ],
      );

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, $5, $2, 'mcp_connection.connect', 'mcp_connection', $3, $4::jsonb)`,
        [
          orgId,
          auditActor(req).id,
          connection.id,
          // The URL is safe to log; the token is not, and is not here.
          JSON.stringify({ provider, serverUrl }),
          auditActor(req).type,
        ],
      );

      return { connection, capabilities: describeCapabilities(probe.tools) };
    });
  }

  /** Re-run the handshake against a stored connection and record the outcome. */
  @Post(":id/test")
  async test(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<{ server_url: string; access_token: string | null }>(
        `SELECT server_url, access_token FROM mcp_connections
          WHERE id = $1 AND status <> 'revoked'`,
        [id],
      );
      if (!row) throw new NotFoundException("connection not found");

      const probe = await probeServer(
        row.server_url,
        row.access_token ? decryptSecret(row.access_token) : null,
      );

      // The outcome is stored either way, so the console shows the same state
      // the sweep will meet rather than a stale "connected".
      const {
        rows: [connection],
      } = await client.query(
        `UPDATE mcp_connections
            SET status      = $2,
                last_error  = $3,
                server_info = COALESCE($4::jsonb, server_info),
                tools       = COALESCE($5::jsonb, tools)
          WHERE id = $1
          RETURNING ${CONNECTION_COLUMNS}`,
        [
          id,
          probe.error ? "error" : "connected",
          probe.error ?? null,
          probe.error ? null : JSON.stringify(probe.serverInfo ?? {}),
          probe.error ? null : JSON.stringify(probe.tools),
        ],
      );

      return {
        ok: !probe.error,
        error: probe.error ?? null,
        connection,
        capabilities: describeCapabilities(probe.tools),
      };
    });
  }

  /**
   * Disconnect. A soft revoke, not a DELETE: `meta_leadgen_events` rows point
   * at this connection to record how each lead arrived, and that history is
   * worth more than a tidy table. The credential IS destroyed.
   */
  @Delete(":id")
  async disconnect(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [connection],
      } = await client.query(
        `UPDATE mcp_connections
            SET status = 'revoked', access_token = NULL, last_error = NULL
          WHERE id = $1 AND status <> 'revoked'
          RETURNING ${CONNECTION_COLUMNS}`,
        [id],
      );
      if (!connection) throw new NotFoundException("connection not found");

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, $4, $2, 'mcp_connection.disconnect', 'mcp_connection', $3, '{}'::jsonb)`,
        [orgId, auditActor(req).id, id, auditActor(req).type],
      );

      return { connection };
    });
  }
}

interface Probe {
  serverInfo: unknown;
  tools: Array<{ name: string; description?: string }>;
  error: string | null;
}

/**
 * Handshake + tool discovery, with every failure turned into a sentence
 * someone can act on. A raw fetch stack trace in a console panel tells the
 * owner nothing about whether they pasted the wrong URL or the wrong token.
 */
async function probeServer(serverUrl: string, accessToken: string | null): Promise<Probe> {
  try {
    const client = new McpClient({
      serverUrl,
      accessToken,
      assertUrl: assertPublicHttpUrl,
    });
    const { serverInfo } = await client.initialize();
    const tools = await client.listTools();
    return { serverInfo, tools, error: null };
  } catch (err) {
    return {
      serverInfo: null,
      tools: [],
      error: err instanceof Error ? err.message : "could not reach the MCP server",
    };
  }
}

/**
 * Whether this server can actually do the job, reported at connect time.
 *
 * A server that handshakes cleanly but advertises no lead tool is the most
 * likely way this integration disappoints someone - it looks connected and
 * then never produces a lead. Saying so up front is the difference between a
 * five-second fix and a week of wondering.
 */
function describeCapabilities(tools: Array<{ name: string }>): {
  canFetchLeads: boolean;
  leadTool: string | null;
  toolCount: number;
} {
  const leadTool = findTool(tools, LEAD_TOOL_CANDIDATES);
  return {
    canFetchLeads: leadTool !== null,
    leadTool: leadTool?.name ?? null,
    toolCount: tools.length,
  };
}

function actorUserId(req: PrincipalRequest): string | null {
  const parsed = z.string().uuid().safeParse(req.principal?.userId);
  return parsed.success ? parsed.data : null;
}
