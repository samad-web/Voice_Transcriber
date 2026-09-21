"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  KeyRound,
  Link2,
  Plus,
  RefreshCw,
  Trash2,
  Zap,
} from "lucide-react";
import type { CrmProviderSpec } from "@aura/shared";
import {
  Button,
  Card,
  ConsolePanel,
  Input,
  MonoLabel,
  Skeleton,
  StatusChip,
  useAlert,
  useConfirm,
  useToast,
} from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import { LoadingRegion } from "@/components/skeletons";
import {
  deleteIntegrationAction,
  listDeliveriesAction,
  retryDeadAction,
  retryDeliveryAction,
  testIntegrationAction,
  updateIntegrationAction,
  type Delivery,
  type TestResult,
} from "./actions";

export interface Integration {
  id: string;
  workspace_id: string;
  provider: string;
  label: string | null;
  target: string | null;
  endpoint: string | null;
  method: string;
  status: string;
  auth_type: string;
  has_auth_secret: boolean;
  config: Record<string, string> | null;
  field_map: Record<string, string> | null;
  max_attempts: number;
  rate_limit_per_min: number;
  last_success_at: string | null;
  last_error: string | null;
  queued?: number;
  dead?: number;
  synced?: number;
}

function statusTone(status: string): "solid" | "muted" | "danger" {
  if (status === "connected") return "solid";
  if (status === "error") return "danger";
  return "muted";
}

export function IntegrationCard({
  integration,
  provider,
  sourcePaths,
  orgId,
}: {
  integration: Integration;
  provider?: CrmProviderSpec;
  sourcePaths: Array<{ path: string; label: string }>;
  /** Tenant this integration belongs to; omitted means DEV_ORG_ID. */
  orgId?: string;
}) {
  const [open, setOpen] = useState<"none" | "map" | "log" | "secret">("none");
  const [test, setTest] = useState<TestResult | null>(null);
  const [pending, startTransition] = useTransition();
  const confirm = useConfirm();
  const alert = useAlert();

  const dead = integration.dead ?? 0;
  const queued = integration.queued ?? 0;

  // Derived from the row id rather than useId(): it is already unique on the
  // page and stays stable across renders, so aria-controls never dangles.
  const mapPanelId = `crm-map-${integration.id}`;
  const logPanelId = `crm-log-${integration.id}`;
  const secretPanelId = `crm-secret-${integration.id}`;

  const runTest = (dryRun: boolean) =>
    startTransition(async () => {
      setTest(null);
      const res = await testIntegrationAction(integration.id, dryRun, orgId);
      if (res.error) {
        await alert({
          title: dryRun ? "Couldn't build the payload preview" : "Couldn't send the test",
          body: res.error,
          tone: "danger",
        });
        return;
      }
      setTest(res.result ?? null);
    });

  // Both report through the same modal - same "something failed silently
  // otherwise" reasoning as runTest: a disconnect or pause/resume that fails
  // (network error, stale id, 500) used to just stop spinning with no sign
  // anything went wrong.
  const remove = async () => {
    const ok = await confirm({
      title: `Disconnect ${integration.label ?? integration.provider}?`,
      body: "Queued deliveries are dropped. Calls already synced stay in the destination CRM.",
      confirmLabel: "Disconnect",
      tone: "danger",
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await deleteIntegrationAction(integration.id, orgId);
      if (res.error) {
        await alert({
          title: "Couldn't disconnect the integration",
          body: res.error,
          tone: "danger",
        });
      }
    });
  };

  const toggleStatus = () => {
    const pausing = integration.status === "connected";
    startTransition(async () => {
      const res = await updateIntegrationAction({
        id: integration.id,
        orgId,
        status: pausing ? "disconnected" : "connected",
      });
      if (res.error) {
        await alert({
          title: pausing
            ? "Couldn't pause the integration"
            : "Couldn't resume the integration",
          body: res.error,
          tone: "danger",
        });
      }
    });
  };

  return (
    <Card elevated className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <Link2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
          <div className="min-w-0">
            <h4 className="truncate text-sm font-semibold text-text">
              {integration.label ?? provider?.label ?? integration.provider}
            </h4>
            <span className="block truncate font-mono text-xs text-text-muted">
              {integration.provider}
              {integration.target ? ` · ${integration.target}` : ""} ·{" "}
              {integration.method} {integration.endpoint ?? ""}
            </span>
          </div>
        </div>
        <StatusChip tone={statusTone(integration.status)}>{integration.status}</StatusChip>
      </div>

      {/* Counters */}
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusChip tone="outline">{integration.synced ?? 0} synced</StatusChip>
        <StatusChip tone={queued > 0 ? "muted" : "outline"}>{queued} queued</StatusChip>
        <StatusChip tone={dead > 0 ? "danger" : "outline"}>{dead} dead</StatusChip>
        {integration.has_auth_secret ? (
          <StatusChip tone="outline">
            <KeyRound aria-hidden="true" className="h-2.5 w-2.5" /> {integration.auth_type}
          </StatusChip>
        ) : null}
        {integration.last_success_at ? (
          <span className="text-xs text-text-muted">
            Last ok <LocalTime iso={integration.last_success_at} />
          </span>
        ) : null}
      </div>

      {integration.last_error ? (
        <p className="flex items-start gap-2 rounded-md border border-danger bg-danger-subtle p-2.5 text-sm font-medium text-danger-text">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{integration.last_error}</span>
        </p>
      ) : null}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={pending}
          onClick={() => runTest(true)}
        >
          Preview payload
        </Button>
        <Button type="button" size="sm" disabled={pending} onClick={() => runTest(false)}>
          <Zap aria-hidden="true" className="h-3.5 w-3.5" />
          {pending ? "Testing…" : "Send test"}
        </Button>
        {/* aria-expanded/controls: these three buttons reveal the panels at the
            bottom of the card, and without it a screen-reader user gets no
            signal that pressing one changed anything. Only one is open at a
            time, which is why each panel takes the id its button points at. */}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-expanded={open === "map"}
          aria-controls={mapPanelId}
          onClick={() => setOpen(open === "map" ? "none" : "map")}
        >
          {open === "map" ? (
            <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
          )}
          Field map
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-expanded={open === "log"}
          aria-controls={logPanelId}
          onClick={() => setOpen(open === "log" ? "none" : "log")}
        >
          {open === "log" ? (
            <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
          )}
          Deliveries
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-expanded={open === "secret"}
          aria-controls={secretPanelId}
          onClick={() => setOpen(open === "secret" ? "none" : "secret")}
        >
          <KeyRound aria-hidden="true" className="h-3.5 w-3.5" /> Credential
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={pending}
          onClick={toggleStatus}
        >
          {integration.status === "connected" ? "Pause" : "Resume"}
        </Button>
        {/* Bordered rather than a danger fill: this sits at the end of a row of
            six secondary buttons, and a solid red block there would read as the
            card's primary action. The colour is on the glyph; the confirm
            dialog is what actually guards it. */}
        <button
          type="button"
          onClick={() => void remove()}
          disabled={pending}
          className="ml-auto shrink-0 cursor-pointer rounded-md border border-border-strong bg-surface p-2 text-danger transition-colors duration-150 ease-out hover:border-danger hover:bg-danger-subtle hover:text-danger-text disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-hover disabled:text-text-subtle"
          aria-label="Disconnect integration"
        >
          <Trash2 aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>

      {test ? <TestPanel result={test} /> : null}

      {open === "map" ? (
        <FieldMapEditor
          panelId={mapPanelId}
          integration={integration}
          sourcePaths={sourcePaths}
          orgId={orgId}
        />
      ) : null}
      {open === "log" ? (
        <DeliveryLog
          panelId={logPanelId}
          integrationId={integration.id}
          dead={dead}
          orgId={orgId}
        />
      ) : null}
      {open === "secret" ? (
        <SecretRotator
          panelId={secretPanelId}
          integration={integration}
          provider={provider}
          orgId={orgId}
        />
      ) : null}
    </Card>
  );
}

function TestPanel({ result }: { result: TestResult }) {
  return (
    <div
      className={`space-y-2 rounded-md border p-4 ${
        result.ok ? "border-border bg-bg-subtle" : "border-danger bg-danger-subtle"
      }`}
    >
      {/* The icon shape carries the outcome as well as the tint, so a
          greyscale screenshot of a failed test still reads as a failure. */}
      <div className="flex items-center gap-2">
        {result.ok ? (
          <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-success" />
        ) : (
          <AlertTriangle aria-hidden="true" className="h-4 w-4 text-danger" />
        )}
        <span
          className={`text-sm font-medium ${result.ok ? "text-text" : "text-danger-text"}`}
        >
          {result.dryRun ? "Payload preview" : result.ok ? "Test delivered" : "Test failed"}
          {result.status !== null ? ` · HTTP ${result.status}` : ""}
        </span>
      </div>

      <p className="font-mono text-xs break-all text-text-muted">
        {result.method} {result.url}
      </p>
      <p className="text-xs text-text-muted">
        Headers: {result.headerNames.join(", ") || "none"} ·{" "}
        {result.sampleCallId
          ? `sample call ${result.sampleCallId.slice(0, 8)}`
          : "synthetic sample (no completed calls yet)"}
      </p>

      {result.error ? (
        <p className="text-sm font-medium break-words text-danger-text">{result.error}</p>
      ) : null}
      {result.externalId ? (
        <p className="font-mono text-xs font-medium text-text">
          Created record id: {result.externalId}
        </p>
      ) : null}

      <ConsolePanel
        className="max-h-56"
        tone="neutral"
        lines={JSON.stringify(result.payload, null, 2).split("\n")}
      />

      {result.responseBody ? (
        <div className="space-y-1">
          <MonoLabel>Response</MonoLabel>
          {/* The response body is arbitrary remote text, not our JSON, so it
              stays on the page surface rather than the terminal one. */}
          <div className="max-h-32 overflow-y-auto rounded-sm border border-border bg-surface p-2.5">
            <pre className="font-mono text-xs break-all whitespace-pre-wrap text-text-muted">
              {result.responseBody}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FieldMapEditor({
  panelId,
  integration,
  sourcePaths,
  orgId,
}: {
  panelId: string;
  integration: Integration;
  sourcePaths: Array<{ path: string; label: string }>;
  orgId?: string;
}) {
  const initial = Object.entries(integration.field_map ?? {}).map(([key, value]) => ({
    key,
    value,
  }));
  const [pairs, setPairs] = useState(initial.length > 0 ? initial : [{ key: "", value: "" }]);
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const toast = useToast();

  const update = (i: number, patch: Partial<{ key: string; value: string }>) =>
    setPairs((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));

  const save = () =>
    startTransition(async () => {
      const fieldMap = Object.fromEntries(
        pairs.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value.trim()]),
      );
      const res = await updateIntegrationAction({ id: integration.id, orgId, fieldMap });
      if (res.error) {
        await alert({
          title: "Couldn't save the field map",
          body: res.error,
          tone: "danger",
        });
        return;
      }
      toast("Field map saved");
    });

  return (
    <div id={panelId} className="space-y-3 rounded-md border border-border bg-bg-subtle p-4">
      <MonoLabel>Field map - CRM field ← call data</MonoLabel>
      {pairs.map((pair, i) => (
        <div key={i} className="flex items-center gap-2">
          {/* Both inputs are labelled by aria-label: a visible <label> per row
              would triple the height of a mapping table, and a placeholder is
              not a label - it disappears as soon as anything is typed. */}
          <Input
            className="min-w-0 font-mono"
            aria-label={`CRM field ${i + 1}`}
            placeholder="crm field"
            value={pair.key}
            onChange={(e) => update(i, { key: e.target.value })}
          />
          <span aria-hidden="true" className="shrink-0 font-mono text-text-muted">
            ←
          </span>
          <Input
            className="min-w-0 font-mono"
            aria-label={`Source path ${i + 1}`}
            placeholder="source path"
            list="crm-source-paths"
            value={pair.value}
            onChange={(e) => update(i, { value: e.target.value })}
          />
          <button
            type="button"
            onClick={() => setPairs((p) => (p.length > 1 ? p.filter((_, idx) => idx !== i) : p))}
            className="shrink-0 cursor-pointer rounded-sm p-1.5 text-text-muted transition-colors duration-150 ease-out hover:bg-danger-subtle hover:text-danger-text"
            aria-label={`Remove mapping ${i + 1}`}
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      ))}

      {/* One datalist for every path input on the page - the browser dedupes it. */}
      <datalist id="crm-source-paths">
        {sourcePaths.map((s) => (
          <option key={s.path} value={s.path}>
            {s.label}
          </option>
        ))}
      </datalist>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setPairs((p) => [...p, { key: "", value: "" }])}
        >
          <Plus aria-hidden="true" className="h-3.5 w-3.5" /> Add
        </Button>
        <Button type="button" size="sm" disabled={pending} onClick={save}>
          {pending ? "Saving…" : "Save field map"}
        </Button>
      </div>

      <p className="text-xs leading-snug text-text-muted">
        Paths index the call document: <code className="font-mono">facts.&lt;key&gt;</code> for
        anything your AI agent extracts, plus{" "}
        <code className="font-mono">intelligence.summary</code>,{" "}
        <code className="font-mono">meta.recordingUrl</code> and the{" "}
        <code className="font-mono">call.*</code> fields. An empty map sends the full envelope.
      </p>
    </div>
  );
}

function SecretRotator({
  panelId,
  integration,
  provider,
  orgId,
}: {
  panelId: string;
  integration: Integration;
  provider?: CrmProviderSpec;
  orgId?: string;
}) {
  const [secret, setSecret] = useState("");
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const toast = useToast();

  const save = () =>
    startTransition(async () => {
      const res = await updateIntegrationAction({
        id: integration.id,
        orgId,
        authSecret: secret.trim(),
      });
      if (res.error) {
        await alert({
          title: "Couldn't replace the credential",
          body: res.error,
          tone: "danger",
        });
        return;
      }
      setSecret("");
      toast("Credential replaced");
    });

  return (
    <div id={panelId} className="space-y-2 rounded-md border border-border bg-bg-subtle p-4">
      <MonoLabel>{provider?.auth.secretLabel ?? "Credential"}</MonoLabel>
      <p className="text-sm leading-snug text-text-muted">
        {integration.has_auth_secret
          ? "A credential is stored and encrypted. It is never returned - paste a new one to rotate."
          : "No credential stored for this integration."}
      </p>
      <div className="flex items-center gap-2">
        <Input
          className="min-w-0 font-mono"
          aria-label={provider?.auth.secretLabel ?? "New credential"}
          type="password"
          autoComplete="off"
          placeholder="New credential"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
        <Button
          type="button"
          className="shrink-0"
          disabled={pending || !secret.trim()}
          onClick={save}
        >
          {pending ? "Saving…" : "Rotate"}
        </Button>
      </div>
    </div>
  );
}

function DeliveryLog({
  panelId,
  integrationId,
  dead,
  orgId,
}: {
  panelId: string;
  integrationId: string;
  dead: number;
  orgId?: string;
}) {
  const [rows, setRows] = useState<Delivery[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const alert = useAlert();

  const load = useCallback(
    () =>
      startTransition(async () => {
        const res = await listDeliveriesAction(integrationId, orgId);
        if (res.error) {
          await alert({
            title: "Couldn't load the delivery log",
            body: res.error,
            tone: "danger",
          });
          return;
        }
        setRows(res.deliveries ?? []);
      }),
    [integrationId, orgId, alert],
  );

  // Fetch when the panel opens rather than with the page: an operator expands
  // this for one integration out of many, and having every card pay for a log
  // query on load would be wasted work.
  useEffect(() => {
    load();
  }, [load]);

  const retry = (id: string) =>
    startTransition(async () => {
      await retryDeliveryAction(id, orgId);
      load();
    });

  const retryAll = () =>
    startTransition(async () => {
      await retryDeadAction(integrationId, orgId);
      load();
    });

  return (
    <div id={panelId} className="space-y-3 rounded-md border border-border bg-bg-subtle p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <MonoLabel>Recent deliveries</MonoLabel>
        <div className="flex items-center gap-2">
          {dead > 0 ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={retryAll}
            >
              <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" /> Retry {dead} dead
            </Button>
          ) : null}
          <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={load}>
            <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
      </div>

      {rows === null ? (
        <LoadingRegion label="Loading deliveries" className="space-y-1.5">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex items-center gap-2 rounded-md border border-border bg-surface p-2.5"
            >
              <Skeleton className="h-5 w-14 shrink-0 rounded-full" />
              <Skeleton className="h-3 w-16 shrink-0" />
              <Skeleton className="h-3 flex-1" />
            </div>
          ))}
        </LoadingRegion>
      ) : rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-text-muted">No deliveries yet</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((d) => (
            <div key={d.id} className="overflow-hidden rounded-md border border-border bg-surface">
              <button
                type="button"
                onClick={() => setExpanded(expanded === d.id ? null : d.id)}
                aria-expanded={expanded === d.id}
                className="flex w-full cursor-pointer items-center gap-2 p-2.5 text-left transition-colors duration-150 ease-out hover:bg-surface-hover"
              >
                <StatusChip
                  tone={
                    d.status === "synced"
                      ? "solid"
                      : d.status === "dead"
                        ? "danger"
                        : "muted"
                  }
                >
                  {d.status}
                </StatusChip>
                <span className="font-mono text-xs font-medium text-text tabular-nums">
                  #{d.call_id.slice(0, 8)}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-text-muted">
                  {d.remote_name ?? "Unknown"} · {d.attempts} attempt
                  {d.attempts === 1 ? "" : "s"}
                  {d.response_status ? ` · HTTP ${d.response_status}` : ""}
                </span>
                <span className="hidden shrink-0 text-xs text-text-muted tabular-nums sm:inline">
                  <LocalTime iso={d.updated_at} />
                </span>
              </button>

              {expanded === d.id ? (
                <div className="space-y-2 border-t border-border p-2.5">
                  {d.error ? (
                    <p className="text-sm font-medium break-words text-danger-text">{d.error}</p>
                  ) : null}
                  {d.external_id ? (
                    <p className="font-mono text-xs font-medium text-text">
                      CRM record: {d.external_id}
                    </p>
                  ) : null}
                  {d.request_url ? (
                    <p className="font-mono text-xs break-all text-text-muted">{d.request_url}</p>
                  ) : null}
                  <ConsolePanel
                    className="max-h-40"
                    tone="neutral"
                    lines={JSON.stringify(d.request_body, null, 2).split("\n")}
                  />
                  {d.response_body ? (
                    <div className="max-h-28 overflow-y-auto rounded-sm border border-border bg-bg-subtle p-2">
                      <pre className="font-mono text-xs break-all whitespace-pre-wrap text-text-muted">
                        {d.response_body}
                      </pre>
                    </div>
                  ) : null}
                  {d.status !== "synced" ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={pending}
                      onClick={() => retry(d.id)}
                    >
                      <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" /> Retry this delivery
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
