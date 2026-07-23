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
import { BrutalButton, Card, MonoLabel, StatusChip } from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import { monoInputClass } from "@/lib/form";
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
}: {
  integration: Integration;
  provider?: CrmProviderSpec;
  sourcePaths: Array<{ path: string; label: string }>;
}) {
  const [open, setOpen] = useState<"none" | "map" | "log" | "secret">("none");
  const [test, setTest] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const dead = integration.dead ?? 0;
  const queued = integration.queued ?? 0;

  const runTest = (dryRun: boolean) =>
    startTransition(async () => {
      setTestError(null);
      setTest(null);
      const res = await testIntegrationAction(integration.id, dryRun);
      if (res.error) setTestError(res.error);
      else setTest(res.result ?? null);
    });

  const remove = () =>
    startTransition(async () => {
      if (
        !window.confirm(
          `Disconnect ${integration.label ?? integration.provider}? Queued deliveries are dropped.`,
        )
      ) {
        return;
      }
      await deleteIntegrationAction(integration.id);
    });

  const toggleStatus = () =>
    startTransition(() =>
      updateIntegrationAction({
        id: integration.id,
        status: integration.status === "connected" ? "disconnected" : "connected",
      }).then(() => undefined),
    );

  return (
    <Card shadow className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <Link2 className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <h4 className="text-sm font-display font-black text-black uppercase tracking-tight truncate">
              {integration.label ?? provider?.label ?? integration.provider}
            </h4>
            <span className="text-[10px] font-mono text-neutral-400 font-bold block truncate">
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
            <KeyRound className="h-2.5 w-2.5" /> {integration.auth_type}
          </StatusChip>
        ) : null}
        {integration.last_success_at ? (
          <span className="text-[10px] font-mono text-neutral-400">
            last ok <LocalTime iso={integration.last_success_at} />
          </span>
        ) : null}
      </div>

      {integration.last_error ? (
        <p className="text-[11px] text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-2.5 flex items-start gap-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span className="break-words min-w-0">{integration.last_error}</span>
        </p>
      ) : null}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <BrutalButton variant="secondary" disabled={pending} onClick={() => runTest(true)}>
          Preview payload
        </BrutalButton>
        <BrutalButton shadow disabled={pending} onClick={() => runTest(false)}>
          <Zap className="h-3.5 w-3.5" />
          {pending ? "TESTING…" : "SEND TEST"}
        </BrutalButton>
        <BrutalButton
          variant="secondary"
          onClick={() => setOpen(open === "map" ? "none" : "map")}
        >
          {open === "map" ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          Field map
        </BrutalButton>
        <BrutalButton
          variant="secondary"
          onClick={() => setOpen(open === "log" ? "none" : "log")}
        >
          {open === "log" ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          Deliveries
        </BrutalButton>
        <BrutalButton
          variant="secondary"
          onClick={() => setOpen(open === "secret" ? "none" : "secret")}
        >
          <KeyRound className="h-3.5 w-3.5" /> Credential
        </BrutalButton>
        <BrutalButton variant="secondary" disabled={pending} onClick={toggleStatus}>
          {integration.status === "connected" ? "Pause" : "Resume"}
        </BrutalButton>
        <button
          onClick={remove}
          disabled={pending}
          className="p-2 text-black hover:text-white hover:bg-black rounded-none border-2 border-black disabled:opacity-40 ml-auto"
          aria-label="Disconnect integration"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {testError ? (
        <p className="text-xs text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-3">
          {testError}
        </p>
      ) : null}
      {test ? <TestPanel result={test} /> : null}

      {open === "map" ? (
        <FieldMapEditor integration={integration} sourcePaths={sourcePaths} />
      ) : null}
      {open === "log" ? <DeliveryLog integrationId={integration.id} dead={dead} /> : null}
      {open === "secret" ? <SecretRotator integration={integration} provider={provider} /> : null}
    </Card>
  );
}

function TestPanel({ result }: { result: TestResult }) {
  return (
    <div
      className={`border-2 p-3.5 space-y-2 ${
        result.ok ? "border-black bg-neutral-50" : "border-red-600 bg-red-50"
      }`}
    >
      <div className="flex items-center gap-2">
        {result.ok ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : (
          <AlertTriangle className="h-4 w-4 text-red-700" />
        )}
        <span className="text-xs font-mono font-bold uppercase tracking-wider text-black">
          {result.dryRun ? "Payload preview" : result.ok ? "Test delivered" : "Test failed"}
          {result.status !== null ? ` · HTTP ${result.status}` : ""}
        </span>
      </div>

      <p className="text-[10px] font-mono text-neutral-600 break-all">
        {result.method} {result.url}
      </p>
      <p className="text-[10px] font-mono text-neutral-400">
        headers: {result.headerNames.join(", ") || "none"} ·{" "}
        {result.sampleCallId
          ? `sample call ${result.sampleCallId.slice(0, 8)}`
          : "synthetic sample (no completed calls yet)"}
      </p>

      {result.error ? (
        <p className="text-[11px] text-red-700 font-sans font-bold break-words">{result.error}</p>
      ) : null}
      {result.externalId ? (
        <p className="text-[11px] font-mono font-bold text-black">
          created record id: {result.externalId}
        </p>
      ) : null}

      <div className="bg-black p-3 text-[10px] font-mono text-neutral-300 overflow-x-auto max-h-56 overflow-y-auto border-2 border-black">
        <pre>{JSON.stringify(result.payload, null, 2)}</pre>
      </div>

      {result.responseBody ? (
        <div className="space-y-1">
          <MonoLabel>Response</MonoLabel>
          <div className="bg-white border-2 border-black p-2.5 text-[10px] font-mono text-neutral-700 overflow-x-auto max-h-32 overflow-y-auto">
            <pre className="whitespace-pre-wrap break-all">{result.responseBody}</pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FieldMapEditor({
  integration,
  sourcePaths,
}: {
  integration: Integration;
  sourcePaths: Array<{ path: string; label: string }>;
}) {
  const initial = Object.entries(integration.field_map ?? {}).map(([key, value]) => ({
    key,
    value,
  }));
  const [pairs, setPairs] = useState(initial.length > 0 ? initial : [{ key: "", value: "" }]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const update = (i: number, patch: Partial<{ key: string; value: string }>) =>
    setPairs((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));

  const save = () =>
    startTransition(async () => {
      setError(null);
      setSaved(false);
      const fieldMap = Object.fromEntries(
        pairs.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value.trim()]),
      );
      const res = await updateIntegrationAction({ id: integration.id, fieldMap });
      if (res.error) setError(res.error);
      else {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    });

  return (
    <div className="border-2 border-black bg-neutral-50 p-3.5 space-y-3">
      <MonoLabel>Field map — CRM field ← call data</MonoLabel>
      {pairs.map((pair, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            className={`${monoInputClass} text-xs`}
            placeholder="crm field"
            value={pair.key}
            onChange={(e) => update(i, { key: e.target.value })}
          />
          <span className="font-mono text-black font-bold shrink-0">←</span>
          <input
            className={`${monoInputClass} text-xs`}
            placeholder="source path"
            list="crm-source-paths"
            value={pair.value}
            onChange={(e) => update(i, { value: e.target.value })}
          />
          <button
            onClick={() => setPairs((p) => (p.length > 1 ? p.filter((_, idx) => idx !== i) : p))}
            className="p-1.5 text-black hover:text-white hover:bg-black rounded-none border border-transparent hover:border-black shrink-0"
            aria-label="Remove mapping"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}

      {/* One datalist for every path input on the page — the browser dedupes it. */}
      <datalist id="crm-source-paths">
        {sourcePaths.map((s) => (
          <option key={s.path} value={s.path}>
            {s.label}
          </option>
        ))}
      </datalist>

      <div className="flex items-center gap-3 flex-wrap">
        <BrutalButton
          variant="secondary"
          onClick={() => setPairs((p) => [...p, { key: "", value: "" }])}
        >
          <Plus className="h-3.5 w-3.5" /> Add
        </BrutalButton>
        <BrutalButton shadow disabled={pending} onClick={save}>
          {pending ? "SAVING…" : "SAVE FIELD MAP"}
        </BrutalButton>
        {saved ? (
          <span className="text-xs font-mono font-bold uppercase text-black">Saved</span>
        ) : null}
      </div>

      <p className="text-[10px] text-neutral-500 font-sans leading-snug">
        Paths index the call document: <code className="font-mono">facts.&lt;key&gt;</code> for
        anything your AI agent extracts, plus{" "}
        <code className="font-mono">intelligence.summary</code>,{" "}
        <code className="font-mono">meta.recordingUrl</code> and the{" "}
        <code className="font-mono">call.*</code> fields. An empty map sends the full envelope.
      </p>

      {error ? (
        <p className="text-xs text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-3">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function SecretRotator({
  integration,
  provider,
}: {
  integration: Integration;
  provider?: CrmProviderSpec;
}) {
  const [secret, setSecret] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () =>
    startTransition(async () => {
      setError(null);
      const res = await updateIntegrationAction({
        id: integration.id,
        authSecret: secret.trim(),
      });
      if (res.error) setError(res.error);
      else {
        setSecret("");
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    });

  return (
    <div className="border-2 border-black bg-neutral-50 p-3.5 space-y-2">
      <MonoLabel>{provider?.auth.secretLabel ?? "Credential"}</MonoLabel>
      <p className="text-[11px] text-neutral-600 font-sans leading-snug">
        {integration.has_auth_secret
          ? "A credential is stored and encrypted. It is never returned — paste a new one to rotate."
          : "No credential stored for this integration."}
      </p>
      <div className="flex items-center gap-2">
        <input
          className={`${monoInputClass} text-xs`}
          type="password"
          autoComplete="off"
          placeholder="New credential"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
        <BrutalButton shadow disabled={pending || !secret.trim()} onClick={save}>
          {pending ? "SAVING…" : "ROTATE"}
        </BrutalButton>
      </div>
      {saved ? (
        <span className="text-xs font-mono font-bold uppercase text-black">
          Credential replaced
        </span>
      ) : null}
      {error ? (
        <p className="text-xs text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-3">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function DeliveryLog({ integrationId, dead }: { integrationId: string; dead: number }) {
  const [rows, setRows] = useState<Delivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(
    () =>
      startTransition(async () => {
        setError(null);
        const res = await listDeliveriesAction(integrationId);
        if (res.error) setError(res.error);
        else setRows(res.deliveries ?? []);
      }),
    [integrationId],
  );

  // Fetch when the panel opens rather than with the page: an operator expands
  // this for one integration out of many, and having every card pay for a log
  // query on load would be wasted work.
  useEffect(() => {
    load();
  }, [load]);

  const retry = (id: string) =>
    startTransition(async () => {
      await retryDeliveryAction(id);
      load();
    });

  const retryAll = () =>
    startTransition(async () => {
      await retryDeadAction(integrationId);
      load();
    });

  return (
    <div className="border-2 border-black bg-neutral-50 p-3.5 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <MonoLabel>Recent deliveries</MonoLabel>
        <div className="flex items-center gap-2">
          {dead > 0 ? (
            <BrutalButton variant="secondary" disabled={pending} onClick={retryAll}>
              <RefreshCw className="h-3.5 w-3.5" /> Retry {dead} dead
            </BrutalButton>
          ) : null}
          <BrutalButton variant="secondary" disabled={pending} onClick={load}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </BrutalButton>
        </div>
      </div>

      {error ? (
        <p className="text-xs text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-3">
          {error}
        </p>
      ) : null}

      {rows === null ? (
        <p className="text-xs font-mono font-bold uppercase text-neutral-400 py-4 text-center">
          Loading…
        </p>
      ) : rows.length === 0 ? (
        <p className="text-xs font-mono font-bold uppercase text-neutral-400 py-4 text-center">
          No deliveries yet
        </p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((d) => (
            <div key={d.id} className="border-2 border-neutral-200 bg-white">
              <button
                onClick={() => setExpanded(expanded === d.id ? null : d.id)}
                className="w-full text-left p-2.5 flex items-center gap-2 hover:bg-neutral-50"
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
                <span className="font-mono text-[10px] text-black font-bold">
                  #{d.call_id.slice(0, 8)}
                </span>
                <span className="text-[10px] font-mono text-neutral-400 truncate min-w-0 flex-1">
                  {d.remote_name ?? "unknown"} · {d.attempts} attempt
                  {d.attempts === 1 ? "" : "s"}
                  {d.response_status ? ` · HTTP ${d.response_status}` : ""}
                </span>
                <span className="text-[10px] font-mono text-neutral-400 shrink-0 hidden sm:inline">
                  <LocalTime iso={d.updated_at} />
                </span>
              </button>

              {expanded === d.id ? (
                <div className="border-t-2 border-neutral-200 p-2.5 space-y-2">
                  {d.error ? (
                    <p className="text-[11px] text-red-700 font-sans font-bold break-words">
                      {d.error}
                    </p>
                  ) : null}
                  {d.external_id ? (
                    <p className="text-[10px] font-mono text-black font-bold">
                      CRM record: {d.external_id}
                    </p>
                  ) : null}
                  {d.request_url ? (
                    <p className="text-[10px] font-mono text-neutral-500 break-all">
                      {d.request_url}
                    </p>
                  ) : null}
                  <div className="bg-black p-2.5 text-[10px] font-mono text-neutral-300 overflow-x-auto max-h-40 overflow-y-auto">
                    <pre>{JSON.stringify(d.request_body, null, 2)}</pre>
                  </div>
                  {d.response_body ? (
                    <div className="bg-white border-2 border-neutral-200 p-2 text-[10px] font-mono text-neutral-600 overflow-x-auto max-h-28 overflow-y-auto">
                      <pre className="whitespace-pre-wrap break-all">{d.response_body}</pre>
                    </div>
                  ) : null}
                  {d.status !== "synced" ? (
                    <BrutalButton variant="secondary" disabled={pending} onClick={() => retry(d.id)}>
                      <RefreshCw className="h-3.5 w-3.5" /> Retry this delivery
                    </BrutalButton>
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
