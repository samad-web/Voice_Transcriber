import { describe, expect, it, vi } from "vitest";
import { findTool, McpClient, McpError, toolJson, toolText } from "./mcp";

/** A stub MCP server: answers by method, records what it was sent. */
function stubServer(
  handlers: Record<string, unknown>,
  opts: { sse?: boolean; sessionId?: string; status?: number; body?: string } = {},
) {
  const seen: Array<{
    method?: string;
    headers: Record<string, string>;
    body: { method?: string; id?: string | number; params?: unknown };
  }> = [];

  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    seen.push({ method: body.method, headers, body });

    const responseHeaders = new Headers({
      "content-type": opts.sse ? "text/event-stream" : "application/json",
    });
    if (opts.sessionId) responseHeaders.set("mcp-session-id", opts.sessionId);

    if (opts.status && opts.status >= 400) {
      return new Response(opts.body ?? "boom", { status: opts.status, headers: responseHeaders });
    }

    // A notification has no id and gets 202 with no body.
    if (body.id === undefined) return new Response(null, { status: 202 });

    const result = handlers[body.method as string];
    const message = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
    return new Response(opts.sse ? `event: message\ndata: ${message}\n\n` : message, {
      status: 200,
      headers: responseHeaders,
    });
  });

  return { fetchImpl: fetchImpl as unknown as typeof fetch, seen };
}

const HANDLERS = {
  initialize: {
    protocolVersion: "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name: "meta-mcp", version: "0.4.1" },
  },
  "tools/list": {
    tools: [
      { name: "list_leadgen_forms", description: "Lead forms" },
      { name: "fetch_leads", description: "Leads for a form" },
      { name: "broken" }, // still valid - only `name` is required
      { description: "no name at all" }, // malformed, must be skipped
    ],
  },
  "tools/call": { content: [{ type: "text", text: '{"leads":[{"id":"1"}]}' }] },
};

describe("McpClient handshake", () => {
  it("initializes, then sends notifications/initialized before anything else", async () => {
    const { fetchImpl, seen } = stubServer(HANDLERS);
    const client = new McpClient({ serverUrl: "https://mcp.example/x", fetchImpl });

    const { serverInfo } = await client.initialize();
    expect(serverInfo).toEqual({ name: "meta-mcp", version: "0.4.1" });
    // The order is load-bearing: a spec-following server rejects tools/list
    // before the initialized notification.
    expect(seen.map((s) => s.method)).toEqual(["initialize", "notifications/initialized"]);
    expect(seen[1].body.id).toBeUndefined();
  });

  it("initializes lazily exactly once, however many calls are made", async () => {
    const { fetchImpl, seen } = stubServer(HANDLERS);
    const client = new McpClient({ serverUrl: "https://mcp.example/x", fetchImpl });

    await client.listTools();
    await client.listTools();
    await client.callTool("fetch_leads");

    expect(seen.filter((s) => s.method === "initialize")).toHaveLength(1);
  });

  it("captures Mcp-Session-Id and echoes it on every later request", async () => {
    const { fetchImpl, seen } = stubServer(HANDLERS, { sessionId: "sess-123" });
    const client = new McpClient({ serverUrl: "https://mcp.example/x", fetchImpl });

    await client.listTools();
    // The very first request cannot carry it; everything after must.
    expect(seen[0].headers["mcp-session-id"]).toBeUndefined();
    for (const request of seen.slice(1)) {
      expect(request.headers["mcp-session-id"]).toBe("sess-123");
    }
  });

  it("sends the bearer token when there is one, and no header when there is not", async () => {
    const withToken = stubServer(HANDLERS);
    await new McpClient({
      serverUrl: "https://mcp.example/x",
      accessToken: "secret-token",
      fetchImpl: withToken.fetchImpl,
    }).listTools();
    expect(withToken.seen[0].headers.authorization).toBe("Bearer secret-token");

    const without = stubServer(HANDLERS);
    await new McpClient({ serverUrl: "https://mcp.example/x", fetchImpl: without.fetchImpl }).listTools();
    expect(without.seen[0].headers.authorization).toBeUndefined();
  });

  /**
   * The URL is tenant-supplied and this client POSTs to it, which is the
   * textbook SSRF shape. The guard must run on EVERY request, not just the
   * first - otherwise a redirect-free but slow-changing DNS name is only
   * checked once.
   */
  it("runs the URL guard before every request, and a rejection stops the call", async () => {
    const { fetchImpl, seen } = stubServer(HANDLERS);
    const assertUrl = vi.fn(async () => {});
    await new McpClient({ serverUrl: "https://mcp.example/x", fetchImpl, assertUrl }).listTools();
    expect(assertUrl).toHaveBeenCalledTimes(seen.length);

    const blocked = stubServer(HANDLERS);
    const client = new McpClient({
      serverUrl: "http://169.254.169.254/latest",
      fetchImpl: blocked.fetchImpl,
      assertUrl: async () => {
        throw new Error("refusing to send to a private/internal address");
      },
    });
    await expect(client.listTools()).rejects.toThrow("private/internal");
    expect(blocked.seen).toHaveLength(0);
  });
});

describe("McpClient transport", () => {
  it("reads a JSON response and an SSE-framed response identically", async () => {
    const json = stubServer(HANDLERS);
    const sse = stubServer(HANDLERS, { sse: true });

    const a = await new McpClient({ serverUrl: "https://a", fetchImpl: json.fetchImpl }).listTools();
    const b = await new McpClient({ serverUrl: "https://b", fetchImpl: sse.fetchImpl }).listTools();
    expect(a).toEqual(b);
    expect(a.map((t) => t.name)).toEqual(["list_leadgen_forms", "fetch_leads", "broken"]);
  });

  it("accepts both content types, since the server picks which to send", async () => {
    const { fetchImpl, seen } = stubServer(HANDLERS);
    await new McpClient({ serverUrl: "https://mcp.example/x", fetchImpl }).listTools();
    expect(seen[0].headers.accept).toContain("application/json");
    expect(seen[0].headers.accept).toContain("text/event-stream");
  });

  it("skips a malformed tool rather than blanking the whole list", async () => {
    const { fetchImpl } = stubServer(HANDLERS);
    const tools = await new McpClient({ serverUrl: "https://a", fetchImpl }).listTools();
    expect(tools).toHaveLength(3);
    expect(tools.some((t) => t.description === "no name at all")).toBe(false);
  });

  it("surfaces a JSON-RPC error as an McpError carrying its code", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32601, message: "Method not found" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const client = new McpClient({ serverUrl: "https://a", fetchImpl });
    await expect(client.initialize()).rejects.toMatchObject({
      name: "McpError",
      code: -32601,
    });
  });

  it("puts the server's own explanation in the message on an HTTP error", async () => {
    const { fetchImpl } = stubServer(HANDLERS, { status: 401, body: "token expired" });
    const client = new McpClient({ serverUrl: "https://a", fetchImpl });
    await expect(client.initialize()).rejects.toThrow(/401.*token expired/);
  });

  it("rejects a non-JSON body instead of returning undefined", async () => {
    const fetchImpl = (async () =>
      new Response("<html>gateway</html>", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(
      new McpClient({ serverUrl: "https://a", fetchImpl }).initialize(),
    ).rejects.toThrow("did not return JSON");
  });

  it("throws rather than hanging when an SSE stream carries no message", async () => {
    const fetchImpl = (async () =>
      new Response(": keep-alive\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;
    await expect(
      new McpClient({ serverUrl: "https://a", fetchImpl }).initialize(),
    ).rejects.toThrow("no JSON message");
  });

  it("turns a tool's isError result into a thrown McpError", async () => {
    const { fetchImpl } = stubServer({
      ...HANDLERS,
      "tools/call": { isError: true, content: [{ type: "text", text: "rate limited" }] },
    });
    const client = new McpClient({ serverUrl: "https://a", fetchImpl });
    await expect(client.callTool("fetch_leads")).rejects.toThrow(/rate limited/);
  });
});

describe("toolJson", () => {
  it("prefers structuredContent over re-parsing the text block", () => {
    expect(
      toolJson({ structuredContent: { leads: [1] }, content: [{ type: "text", text: "{}" }] }),
    ).toEqual({ leads: [1] });
  });

  it("parses a JSON document out of the text blocks", () => {
    expect(toolJson({ content: [{ type: "text", text: '{"leads":[]}' }] })).toEqual({ leads: [] });
  });

  it("returns null for prose or nothing, rather than throwing", () => {
    expect(toolJson({ content: [{ type: "text", text: "no leads today" }] })).toBeNull();
    expect(toolJson({ content: [] })).toBeNull();
    expect(toolJson({})).toBeNull();
  });

  it("ignores non-text blocks when concatenating", () => {
    expect(
      toolText({ content: [{ type: "image" }, { type: "text", text: "hi" }] }),
    ).toBe("hi");
  });
});

describe("findTool", () => {
  const TOOLS = [
    { name: "meta_list_leadgen_forms" },
    { name: "fetch_leads" },
    { name: "unrelated" },
  ];

  it("prefers an exact name, case-insensitively", () => {
    expect(findTool(TOOLS, ["FETCH_LEADS"])?.name).toBe("fetch_leads");
  });

  it("tries candidates in order, so the preferred name wins", () => {
    expect(findTool(TOOLS, ["fetch_leads", "meta_list_leadgen_forms"])?.name).toBe("fetch_leads");
  });

  it("falls back to containment, so a vendor prefix still matches", () => {
    expect(findTool(TOOLS, ["list_leadgen_forms"])?.name).toBe("meta_list_leadgen_forms");
  });

  /** Returning null is what makes "this server can't do that" a clear message. */
  it("returns null rather than guessing at an unrelated tool", () => {
    expect(findTool(TOOLS, ["send_invoice"])).toBeNull();
    expect(findTool([], ["fetch_leads"])).toBeNull();
  });
});
