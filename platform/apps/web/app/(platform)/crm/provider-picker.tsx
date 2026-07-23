"use client";

import { useMemo, useState, useTransition } from "react";
import { ArrowLeft, ExternalLink, Plug, Search } from "lucide-react";
import type { CrmProviderSpec } from "@aura/shared";
import { BrutalButton, Card, MonoLabel, StatusChip } from "@aura/ui";
import { inputClass, monoInputClass, selectClass } from "@/lib/form";
import { connectProviderAction } from "./actions";

/**
 * Catalogue browser and connect form.
 *
 * The form is rendered from the provider spec rather than hand-written per
 * CRM: config fields, their help text and the credential's real name all come
 * from the same object the worker dispatches against. That is what keeps the
 * console honest — a field only appears here because something actually reads
 * it at send time.
 */

const MARKET_FILTERS = [
  { id: "all", label: "All" },
  { id: "global", label: "Global" },
  { id: "india", label: "India" },
  { id: "automation", label: "Automation" },
] as const;

type MarketFilter = (typeof MARKET_FILTERS)[number]["id"];

export function ProviderPicker({
  providers,
  workspaceId,
  onConnected,
}: {
  providers: CrmProviderSpec[];
  workspaceId: string;
  onConnected: () => void;
}) {
  const [query, setQuery] = useState("");
  const [market, setMarket] = useState<MarketFilter>("all");
  const [selected, setSelected] = useState<CrmProviderSpec | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return providers.filter((p) => {
      if (market === "automation" && p.category !== "automation") return false;
      if ((market === "global" || market === "india") && !p.markets.includes(market)) return false;
      if (!q) return true;
      return `${p.label} ${p.blurb}`.toLowerCase().includes(q);
    });
  }, [providers, query, market]);

  if (selected) {
    return (
      <ConnectForm
        provider={selected}
        workspaceId={workspaceId}
        onBack={() => setSelected(null)}
        onConnected={() => {
          setSelected(null);
          onConnected();
        }}
      />
    );
  }

  return (
    <Card shadow className="space-y-4">
      <div className="flex items-center gap-2">
        <Plug className="h-4 w-4" />
        <h4 className="text-lg font-display font-black text-black uppercase tracking-tight">
          Connect a CRM
        </h4>
      </div>
      <p className="text-xs text-neutral-400 font-sans font-medium">
        Extracted call facts are pushed to the CRM as each call finishes. Pick a provider to
        see exactly what it needs.
      </p>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input
            className={`${inputClass} pl-9`}
            placeholder="Search providers…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex gap-1.5">
          {MARKET_FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setMarket(f.id)}
              className={`text-[10px] font-mono font-bold uppercase tracking-wider px-2.5 py-2 border-2 border-black rounded-none ${
                market === f.id ? "bg-black text-white" : "bg-white text-black hover:bg-neutral-50"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {visible.map((p) => (
          <button
            key={p.id}
            onClick={() => setSelected(p)}
            className="text-left p-4 border-2 border-neutral-200 bg-white hover:border-black hover:bg-neutral-50 transition-colors space-y-1.5"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="font-display font-black text-black text-sm uppercase tracking-tight">
                {p.label}
              </span>
              {p.category === "automation" ? (
                <StatusChip tone="outline">auto</StatusChip>
              ) : p.markets.includes("india") && !p.markets.includes("global") ? (
                <StatusChip tone="muted">india</StatusChip>
              ) : null}
            </div>
            <p className="text-[11px] text-neutral-500 font-sans leading-snug">{p.blurb}</p>
            <span className="text-[9px] font-mono font-bold uppercase tracking-wider text-neutral-400 block pt-1">
              {p.targets.length} target{p.targets.length === 1 ? "" : "s"} · {p.auth.scheme}
            </span>
          </button>
        ))}
        {visible.length === 0 ? (
          <p className="text-xs font-mono font-bold uppercase text-neutral-400 py-8 text-center sm:col-span-2 xl:col-span-3">
            No provider matches “{query}”
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function ConnectForm({
  provider,
  workspaceId,
  onBack,
  onConnected,
}: {
  provider: CrmProviderSpec;
  workspaceId: string;
  onBack: () => void;
  onConnected: () => void;
}) {
  const [targetId, setTargetId] = useState(provider.targets[0]?.id ?? "");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [config, setConfig] = useState<Record<string, string>>(() =>
    Object.fromEntries(provider.config.map((f) => [f.key, f.defaultValue ?? ""])),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const target = provider.targets.find((t) => t.id === targetId) ?? provider.targets[0];
  const needsSecret = provider.auth.scheme !== "none";
  const missingConfig = provider.config.filter((f) => f.required && !config[f.key]?.trim());
  const canSubmit =
    missingConfig.length === 0 && (!needsSecret || secret.trim().length > 0) && !pending;

  const submit = () =>
    startTransition(async () => {
      setError(null);
      const res = await connectProviderAction({
        workspaceId,
        provider: provider.id,
        target: targetId,
        label: label.trim() || undefined,
        config,
        secret: secret.trim() || undefined,
      });
      if (res.error) setError(res.error);
      else onConnected();
    });

  return (
    <Card shadow className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="p-1.5 border-2 border-black bg-white hover:bg-black hover:text-white"
            aria-label="Back to provider list"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <h4 className="text-lg font-display font-black text-black uppercase tracking-tight">
            {provider.label}
          </h4>
        </div>
        {provider.docsUrl ? (
          <a
            href={provider.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[10px] font-mono font-bold uppercase tracking-wider text-black underline flex items-center gap-1"
          >
            API docs <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
      </div>

      {provider.notes ? (
        <p className="text-[11px] text-neutral-600 font-sans leading-relaxed border-l-4 border-black pl-3 py-1 bg-neutral-50">
          {provider.notes}
        </p>
      ) : null}

      {/* Target */}
      {provider.targets.length > 1 ? (
        <div className="space-y-1.5">
          <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
            What to create
          </label>
          <select
            className={selectClass}
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
          >
            {provider.targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-neutral-500 font-sans">{target?.blurb}</p>
        </div>
      ) : (
        <p className="text-[11px] text-neutral-500 font-sans">{target?.blurb}</p>
      )}

      {/* Provider-declared config */}
      {provider.config.map((field) => (
        <div key={field.key} className="space-y-1.5">
          <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
            {field.label}
            {field.required ? <span className="text-red-600"> *</span> : null}
          </label>
          {field.options ? (
            <select
              className={selectClass}
              value={config[field.key] ?? ""}
              onChange={(e) => setConfig((c) => ({ ...c, [field.key]: e.target.value }))}
            >
              {field.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              className={monoInputClass}
              placeholder={field.placeholder}
              value={config[field.key] ?? ""}
              onChange={(e) => setConfig((c) => ({ ...c, [field.key]: e.target.value }))}
            />
          )}
          {field.help ? (
            <p className="text-[11px] text-neutral-500 font-sans leading-snug">{field.help}</p>
          ) : null}
        </div>
      ))}

      {/* Credential */}
      {needsSecret ? (
        <div className="space-y-1.5">
          <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
            {provider.auth.secretLabel}
            <span className="text-red-600"> *</span>
          </label>
          <input
            className={monoInputClass}
            type="password"
            autoComplete="off"
            placeholder="Paste the credential"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          <p className="text-[11px] text-neutral-500 font-sans leading-snug">
            {provider.auth.secretHelp}
          </p>
        </div>
      ) : (
        <p className="text-[11px] text-neutral-500 font-sans leading-snug">
          {provider.auth.secretHelp}
        </p>
      )}

      <div className="space-y-1.5">
        <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
          Name (optional)
        </label>
        <input
          className={inputClass}
          placeholder={`${provider.label} — ${target?.label ?? ""}`}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>

      <div className="border-2 border-black bg-neutral-50 p-3.5 space-y-1.5">
        <MonoLabel>Starting field map</MonoLabel>
        <p className="text-[11px] text-neutral-600 font-sans leading-snug">
          {Object.keys(target?.fieldMap ?? {}).length === 0
            ? "No preset — the full call envelope is sent until you define a mapping."
            : "A sensible first mapping is applied on connect. Edit it on the integration card afterwards."}
        </p>
        {Object.entries(target?.fieldMap ?? {}).map(([dest, path]) => (
          <div key={dest} className="flex items-center gap-2 text-[10px] font-mono">
            <span className="font-bold text-black">{dest}</span>
            <span className="text-neutral-400">←</span>
            <span className="text-neutral-600">{path}</span>
          </div>
        ))}
      </div>

      {missingConfig.length > 0 ? (
        <p className="text-[11px] font-mono font-bold uppercase text-neutral-500">
          Required: {missingConfig.map((f) => f.label).join(", ")}
        </p>
      ) : null}

      {error ? (
        <p className="text-xs text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-3">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-3">
        <BrutalButton variant="secondary" onClick={onBack}>
          Cancel
        </BrutalButton>
        <BrutalButton shadow disabled={!canSubmit} onClick={submit}>
          <Plug className="h-4 w-4" />
          {pending ? "CONNECTING…" : `CONNECT ${provider.label.toUpperCase()}`}
        </BrutalButton>
      </div>
    </Card>
  );
}
