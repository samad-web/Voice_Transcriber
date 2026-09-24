"use client";

import { useState, useTransition } from "react";
import { useServerState, useDraftState } from "@/lib/use-server-state";
import { CheckCircle2, Plug, TriangleAlert } from "lucide-react";
import {
  Button,
  Card,
  ErrorBanner,
  FormField,
  Input,
  MonoLabel,
  STATE_TONE,
  StatusChip,
  useAlert,
  useConfirm,
  useToast,
} from "@aura/ui";
import { Time } from "@/components/org-time";
import {
  connectMetaMcpAction,
  disconnectMcpAction,
  testMcpConnectionAction,
  type McpCapabilities,
  type McpConnection,
} from "./actions";

/**
 * Connect a Meta MCP server, as an alternative to the OAuth flow above it.
 *
 * The token field is write-only by construction: the API never returns
 * `access_token` on any read, so an existing connection shows a blank box and
 * saving with it blank is how you keep the stored token. That is stated in
 * the UI rather than left to be discovered.
 */
export function McpConnect({ initial }: { initial: McpConnection | null }) {
  const [pending, startTransition] = useTransition();
  const [connection, setConnection] = useServerState<McpConnection | null>(initial, pending);
  const [capabilities, setCapabilities] = useState<McpCapabilities | null>(null);
  const [serverUrl, setServerUrl] = useDraftState(initial?.server_url ?? "");
  const [token, setToken] = useState("");
  const confirm = useConfirm();
  const alert = useAlert();
  const toast = useToast();

  const connect = () => {
    const url = serverUrl.trim();
    if (!url) {
      void alert({
        title: "Couldn't connect the MCP server",
        body: "Enter the MCP server URL first.",
        tone: "danger",
      });
      return;
    }
    startTransition(async () => {
      const result = await connectMetaMcpAction({
        serverUrl: url,
        accessToken: token.trim() || null,
      });
      if (result.error || !result.connection) {
        await alert({
          title: "Couldn't connect the MCP server",
          body: result.error ?? "Could not connect",
          tone: "danger",
        });
        return;
      }
      setConnection(result.connection);
      setCapabilities(result.capabilities ?? null);
      setToken("");
      toast("Connected");
    });
  };

  const test = () => {
    if (!connection) return;
    startTransition(async () => {
      const result = await testMcpConnectionAction(connection.id);
      if (result.connection) setConnection(result.connection);
      setCapabilities(result.capabilities ?? null);
      if (result.ok) toast("The server answered and the handshake succeeded");
      else
        await alert({
          title: "Couldn't reach the MCP server",
          body: result.error ?? "The server did not answer",
          tone: "danger",
        });
    });
  };

  const disconnect = async () => {
    if (!connection) return;
    const ok = await confirm({
      title: "Disconnect this MCP server?",
      body: "The stored token is deleted. Leads already pulled in stay exactly where they are.",
      confirmLabel: "Disconnect",
      tone: "danger",
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await disconnectMcpAction(connection.id);
      if (result.error) {
        await alert({
          title: "Couldn't disconnect the MCP server",
          body: result.error,
          tone: "danger",
        });
        return;
      }
      setConnection(null);
      setCapabilities(null);
      setToken("");
      toast("Disconnected");
    });
  };

  return (
    <Card elevated className="max-w-2xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Plug className="h-4 w-4" aria-hidden="true" />
          <MonoLabel>Meta via MCP</MonoLabel>
        </div>
        {connection ? (
          <StatusChip tone={connection.status === "connected" ? "solid" : "danger"}>
            {connection.status === "connected" ? "Connected" : "Error"}
          </StatusChip>
        ) : (
          <StatusChip tone="muted">Not connected</StatusChip>
        )}
      </div>

      <p className="text-sm leading-relaxed text-text-muted">
        Point Aura at a Meta MCP server and it will pull your Lead Ads leads onto the
        same board your phone leads land on - each one matched against your{" "}
        <a href="/owner/projects" className="text-accent-text underline underline-offset-2">
          project list
        </a>{" "}
        so it arrives already labelled. Unlike the Facebook sign-in above, this needs no
        app review and no public callback URL.
      </p>

      <FormField label="MCP server URL" name="mcp-url">
        <Input
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          placeholder="https://mcp.example.com/mcp"
          inputMode="url"
          maxLength={2000}
        />
      </FormField>

      <FormField
        label={connection ? "Access token (leave blank to keep the stored one)" : "Access token"}
        name="mcp-token"
      >
        <Input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          type="password"
          autoComplete="off"
          placeholder={connection ? "••••••••" : "Optional, if the server needs one"}
          maxLength={4000}
        />
      </FormField>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={connect} loading={pending}>
          {connection ? "Save & reconnect" : "Connect"}
        </Button>
        {connection ? (
          <>
            <Button type="button" variant="secondary" disabled={pending} onClick={test}>
              Test connection
            </Button>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => void disconnect()}>
              Disconnect
            </Button>
          </>
        ) : null}
      </div>

      {/* The most likely disappointment with this integration is a server that
          handshakes cleanly and advertises no lead tool - it looks connected
          and then never produces a lead. Saying so here is the difference
          between a five-second fix and a week of wondering. */}
      {capabilities ? (
        <div
          className={`flex items-start gap-2 rounded-md border p-3 text-xs ${
            // "It works" is not one of the four states and gets no colour -
            // the tick and the sentence say it. "It handshakes but advertises
            // no lead tool" IS an error: the integration looks connected and
            // will never produce a lead, which is the failure this panel was
            // written to catch. So only the bad branch is coloured, and it
            // takes the error tone rather than the old amber.
            capabilities.canFetchLeads
              ? "border-border bg-bg-subtle text-text-muted"
              : STATE_TONE.error.chip
          }`}
        >
          {capabilities.canFetchLeads ? (
            <CheckCircle2 aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <span>
            {capabilities.canFetchLeads ? (
              <>
                This server can fetch leads - using its{" "}
                <code className="font-mono">{capabilities.leadTool}</code> tool
                {capabilities.toolCount > 1 ? ` (of ${capabilities.toolCount} it offers)` : ""}.
              </>
            ) : (
              <>
                The server answered, but none of the {capabilities.toolCount} tools it offers
                fetches leads. Leads will not arrive until it exposes one.
              </>
            )}
          </span>
        </div>
      ) : null}

      {connection?.status === "error" && connection.last_error ? (
        <ErrorBanner>Last attempt failed: {connection.last_error}</ErrorBanner>
      ) : null}

      {connection ? (
        <dl className="grid grid-cols-2 gap-3 border-t border-border pt-3 text-xs">
          <div>
            <dt className="text-text-muted">Server</dt>
            <dd className="mt-0.5 font-medium break-words text-text">
              {connection.server_info?.name ?? "-"}
              {connection.server_info?.version ? ` v${connection.server_info.version}` : ""}
            </dd>
          </div>
          <div>
            <dt className="text-text-muted">Last sync</dt>
            <dd className="mt-0.5 font-medium text-text tabular-nums">
              {connection.last_sync_at ? (
                <Time iso={connection.last_sync_at} mode="datetime" />
              ) : (
                "Not yet"
              )}
            </dd>
          </div>
        </dl>
      ) : null}
    </Card>
  );
}
