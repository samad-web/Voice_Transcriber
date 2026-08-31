import { z } from "zod";

/**
 * A minimal Model Context Protocol client — Streamable HTTP transport only.
 *
 * ── WHY HAND-ROLLED RATHER THAN @modelcontextprotocol/sdk ───────────────
 *
 * The official SDK carries a stdio transport, an in-process server, an OAuth
 * client and a session manager. Aura needs exactly three calls against a
 * remote HTTP endpoint — `initialize`, `tools/list`, `tools/call` — and needs
 * them to be callable from the API tier, the worker, and a unit test with a
 * stub fetch. That is about a hundred lines of JSON-RPC, and writing it here
 * keeps the wire shape visible and testable rather than behind a dependency
 * whose transport assumptions we would have to work around anyway.
 *
 * What is deliberately NOT implemented, so nobody assumes otherwise:
 * server-initiated requests (sampling, roots, elicitation), resources,
 * prompts, notifications beyond the one the handshake requires, and the
 * resumable-stream / event-id replay part of Streamable HTTP. Aura is a
 * client that calls tools and reads the answer.
 */

export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** A tool as advertised by `tools/list`. */
export const McpTool = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
});
export type McpTool = z.infer<typeof McpTool>;

export const McpServerInfo = z.object({
  name: z.string(),
  version: z.string().optional(),
  title: z.string().optional(),
});
export type McpServerInfo = z.infer<typeof McpServerInfo>;

/**
 * One content block from a tool result. Only `text` is read — an MCP server
 * returning an image or an audio blob for a lead list is not something to
 * guess at, so those pass through unparsed rather than being coerced.
 */
const McpContent = z.object({
  type: z.string(),
  text: z.string().optional(),
});

const McpToolResult = z.object({
  content: z.array(McpContent).optional(),
  /** Newer servers return the parsed object directly; preferred when present. */
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
});
export type McpToolResult = z.infer<typeof McpToolResult>;

const JsonRpcResponse = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).nullish(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});

export class McpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "McpError";
  }
}

export interface McpClientOptions {
  serverUrl: string;
  accessToken?: string | null;
  fetchImpl?: typeof fetch;
  /**
   * Called before every request with the URL about to be hit. This is where
   * the SSRF guard is injected: the URL is tenant-supplied, and this package
   * cannot import the guard (it lives in @aura/db and does DNS) without
   * dragging node-only code into a package the browser bundles.
   */
  assertUrl?: (url: string) => Promise<void>;
  timeoutMs?: number;
}

/**
 * A server that speaks Streamable HTTP answers a POST with either JSON or an
 * SSE stream, its own choice, signalled by Content-Type. Both carry the same
 * JSON-RPC message; the stream just wraps it in `data:` lines. Handling only
 * the JSON case would work against some servers and mysteriously hang against
 * others, which is worse than not supporting it at all.
 */
function parseSseForResponse(body: string): unknown {
  let last: unknown;
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      last = JSON.parse(payload);
    } catch {
      // A non-JSON data line is a keep-alive or a comment; skip it rather
      // than failing the whole call.
    }
  }
  if (last === undefined) throw new McpError("MCP server sent an SSE stream with no JSON message");
  return last;
}

export class McpClient {
  private readonly serverUrl: string;
  private readonly accessToken: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly assertUrl: (url: string) => Promise<void>;
  private readonly timeoutMs: number;

  /** Set from the `Mcp-Session-Id` response header, echoed on every later call. */
  private sessionId: string | null = null;
  private nextId = 1;
  private initialized = false;

  constructor(options: McpClientOptions) {
    this.serverUrl = options.serverUrl;
    this.accessToken = options.accessToken ?? null;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.assertUrl = options.assertUrl ?? (async () => {});
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // Both, because the server picks — see parseSseForResponse.
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    };
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    return headers;
  }

  private async send(body: unknown, expectResponse: boolean): Promise<unknown> {
    await this.assertUrl(this.serverUrl);

    // AbortSignal.timeout rather than a bare fetch: an MCP server that accepts
    // the connection and then never answers would otherwise hold a worker
    // sweep open indefinitely.
    const res = await this.fetchImpl(this.serverUrl, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const session = res.headers.get("mcp-session-id");
    if (session) this.sessionId = session;

    // 202 is the correct answer to a notification, and has no body.
    if (!expectResponse) {
      if (!res.ok && res.status !== 202) {
        throw new McpError(`MCP server returned ${res.status} for a notification`);
      }
      return undefined;
    }

    const text = await res.text();
    if (!res.ok) {
      // The body usually carries a JSON-RPC error explaining the status;
      // prefer that message to a bare status code.
      const detail = text.slice(0, 300).trim();
      throw new McpError(`MCP server returned ${res.status}${detail ? `: ${detail}` : ""}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    let raw: unknown;
    if (contentType.includes("text/event-stream")) {
      raw = parseSseForResponse(text);
    } else {
      try {
        raw = JSON.parse(text);
      } catch {
        throw new McpError("MCP server did not return JSON");
      }
    }

    const parsed = JsonRpcResponse.safeParse(raw);
    if (!parsed.success) throw new McpError("MCP server returned a malformed JSON-RPC message");
    if (parsed.data.error) {
      throw new McpError(parsed.data.error.message, parsed.data.error.code);
    }
    return parsed.data.result;
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    return this.send({ jsonrpc: "2.0", id: this.nextId++, method, params }, true);
  }

  /**
   * The handshake. Two messages, in order, and the notification is not
   * optional — a spec-following server rejects `tools/list` before it.
   */
  async initialize(): Promise<{ serverInfo: McpServerInfo | null; protocolVersion: string | null }> {
    const result = (await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "aura", version: "1.0.0" },
    })) as { serverInfo?: unknown; protocolVersion?: unknown } | null;

    await this.send({ jsonrpc: "2.0", method: "notifications/initialized" }, false);
    this.initialized = true;

    const info = McpServerInfo.safeParse(result?.serverInfo);
    return {
      serverInfo: info.success ? info.data : null,
      protocolVersion:
        typeof result?.protocolVersion === "string" ? result.protocolVersion : null,
    };
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }

  async listTools(): Promise<McpTool[]> {
    await this.ensureInitialized();
    const result = (await this.request("tools/list")) as { tools?: unknown } | null;
    if (!Array.isArray(result?.tools)) return [];
    // Per-entry parse: one malformed tool must not blank the whole list, or a
    // server adding an experimental tool breaks every other one.
    return result.tools.flatMap((tool) => {
      const parsed = McpTool.safeParse(tool);
      return parsed.success ? [parsed.data] : [];
    });
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    await this.ensureInitialized();
    const result = await this.request("tools/call", { name, arguments: args });
    const parsed = McpToolResult.safeParse(result);
    if (!parsed.success) throw new McpError(`tool "${name}" returned an unreadable result`);
    if (parsed.data.isError) {
      throw new McpError(`tool "${name}" failed: ${toolText(parsed.data).slice(0, 300)}`);
    }
    return parsed.data;
  }
}

/** The text blocks of a tool result, concatenated. */
export function toolText(result: McpToolResult): string {
  return (result.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

/**
 * A tool result as data.
 *
 * `structuredContent` is preferred and taken as-is. Otherwise the text blocks
 * are JSON-parsed, because in practice most servers answer a "list things"
 * tool with a JSON document in a text block. A text block that is not JSON
 * returns null rather than throwing — the caller decides whether prose is a
 * failure, and for some tools it legitimately is not.
 */
export function toolJson(result: McpToolResult): unknown {
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return result.structuredContent;
  }
  const text = toolText(result).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Pick the tool that does a job, given the names different servers use for it.
 *
 * There is no registry of canonical MCP tool names, so a Meta MCP server may
 * call the same operation `list_leads`, `get_leads` or `fetch_lead_ads`.
 * Matching a candidate list against what the server actually advertises is
 * how this stays working across servers without a per-vendor code branch —
 * and returning null (rather than guessing at the first tool) is what makes
 * "this server cannot do that" a clear message instead of a confusing failure
 * deep in an argument mismatch.
 */
export function findTool(tools: McpTool[], candidates: string[]): McpTool | null {
  const byName = new Map(tools.map((t) => [t.name.toLowerCase(), t]));
  for (const candidate of candidates) {
    const hit = byName.get(candidate.toLowerCase());
    if (hit) return hit;
  }
  // Fall back to a containment match: `meta_list_leadgen_forms` should still
  // be found by a candidate of `list_leadgen_forms`.
  for (const candidate of candidates) {
    const needle = candidate.toLowerCase();
    for (const tool of tools) {
      if (tool.name.toLowerCase().includes(needle)) return tool;
    }
  }
  return null;
}
