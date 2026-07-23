"use client";

import { useState, useTransition } from "react";
import { Link2, Plug, Plus, Trash2, Webhook } from "lucide-react";
import { BrutalButton, Card, MonoLabel, StatusChip } from "@aura/ui";
import { connectWebhookAction, updateFieldMapAction } from "./actions";
import { inputClass } from "@/lib/form";

export interface Integration {
  id: string;
  workspace_id: string;
  provider: string;
  status: string;
  field_map: Record<string, string> | null;
}

function statusTone(status: string): "solid" | "muted" | "danger" {
  if (status === "active" || status === "connected") return "solid";
  if (status === "error" || status === "failed") return "danger";
  return "muted";
}

function FieldMapEditor({ integration }: { integration: Integration }) {
  const initial = Object.entries(integration.field_map ?? {}).map(([key, value]) => ({
    key,
    value,
  }));
  const [pairs, setPairs] = useState<{ key: string; value: string }[]>(
    initial.length > 0 ? initial : [{ key: "", value: "" }],
  );
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
      const res = await updateFieldMapAction({ id: integration.id, fieldMap });
      if (res.error) setError(res.error);
      else {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    });

  return (
    <Card shadow className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Link2 className="h-4 w-4" />
          <h4 className="text-sm font-display font-black text-black uppercase tracking-tight">
            {integration.provider}
          </h4>
        </div>
        <StatusChip tone={statusTone(integration.status)}>{integration.status}</StatusChip>
      </div>
      <span className="text-[10px] font-mono text-neutral-400 font-bold block">
        workspace {integration.workspace_id.slice(0, 8)} · {integration.id.slice(0, 8)}
      </span>

      <div className="space-y-2">
        <MonoLabel>Field Map (call fact → CRM field)</MonoLabel>
        {pairs.map((pair, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              className={`${inputClass} font-mono text-xs`}
              placeholder="fact key"
              value={pair.key}
              onChange={(e) => update(i, { key: e.target.value })}
            />
            <span className="font-mono text-black font-bold">→</span>
            <input
              className={`${inputClass} font-mono text-xs`}
              placeholder="crm field"
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
        <BrutalButton
          variant="secondary"
          onClick={() => setPairs((p) => [...p, { key: "", value: "" }])}
        >
          <Plus className="h-3.5 w-3.5" /> Add Mapping
        </BrutalButton>
      </div>

      <div className="flex items-center gap-3">
        <BrutalButton shadow disabled={pending} onClick={save}>
          {pending ? "SAVING…" : "SAVE FIELD MAP"}
        </BrutalButton>
        {saved ? (
          <span className="text-xs font-mono font-bold uppercase text-black">Saved</span>
        ) : null}
      </div>

      {error ? (
        <p className="text-xs text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-3">
          {error}
        </p>
      ) : null}
    </Card>
  );
}

export function CrmManager({
  integrations,
  defaultWorkspaceId,
}: {
  integrations: Integration[];
  defaultWorkspaceId: string;
}) {
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const connect = () =>
    startTransition(async () => {
      setError(null);
      const res = await connectWebhookAction({
        workspaceId: workspaceId.trim(),
        webhookUrl: webhookUrl.trim(),
      });
      if (res.error) setError(res.error);
      else setWebhookUrl("");
    });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="space-y-6">
        {/* Connect webhook */}
        <Card shadow className="space-y-4">
          <div className="flex items-center gap-2">
            <Webhook className="h-4 w-4" />
            <h4 className="text-lg font-display font-black text-black uppercase tracking-tight">
              Connect Webhook
            </h4>
          </div>
          <p className="text-xs text-neutral-400 font-sans font-medium">
            Post extracted call facts to any HTTPS endpoint as they are produced.
          </p>

          <div className="space-y-1.5">
            <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
              Workspace ID
            </label>
            <input
              className={`${inputClass} font-mono text-xs`}
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
              Webhook URL
            </label>
            <input
              className={`${inputClass} font-mono text-xs`}
              placeholder="https://hooks.example.com/aura"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
            />
          </div>

          <BrutalButton
            className="w-full"
            shadow
            disabled={pending || !workspaceId.trim() || !webhookUrl.trim()}
            onClick={connect}
          >
            <Plug className="h-4 w-4" />
            {pending ? "CONNECTING…" : "CONNECT WEBHOOK"}
          </BrutalButton>

          {error ? (
            <p className="text-xs text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-3">
              {error}
            </p>
          ) : null}
        </Card>

        {/* HubSpot OAuth (disabled) */}
        <Card className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-lg font-display font-black text-neutral-400 uppercase tracking-tight">
              HubSpot
            </h4>
            <StatusChip tone="outline">not configured</StatusChip>
          </div>
          <p className="text-xs text-neutral-400 font-sans font-medium">
            Native two-way sync with contacts, deals and pipeline stages.
          </p>
          <BrutalButton variant="secondary" className="w-full" disabled title="OAuth credentials required">
            <Plug className="h-4 w-4" />
            Connect HubSpot (OAuth — needs credentials)
          </BrutalButton>
        </Card>
      </div>

      {/* Existing integrations */}
      <div className="space-y-6">
        <MonoLabel>Connected Integrations</MonoLabel>
        {integrations.length === 0 ? (
          <Card className="flex flex-col items-center py-12 gap-3">
            <Link2 className="h-8 w-8 text-neutral-300" />
            <p className="text-xs font-mono font-bold uppercase text-neutral-400">
              No integrations yet — connect a webhook to start syncing
            </p>
          </Card>
        ) : (
          integrations.map((integration) => (
            <FieldMapEditor key={integration.id} integration={integration} />
          ))
        )}
      </div>
    </div>
  );
}
