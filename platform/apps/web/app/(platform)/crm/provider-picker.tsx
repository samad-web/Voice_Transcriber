"use client";

import { useMemo, useState, useTransition } from "react";
import { ArrowLeft, ExternalLink, Plug, Search } from "lucide-react";
import type { CrmProviderSpec } from "@aura/shared";
import { Button, Card, FormField, Input, MonoLabel, Select, StatusChip } from "@aura/ui";
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
  orgId,
  onConnected,
}: {
  providers: CrmProviderSpec[];
  workspaceId: string;
  /** Tenant to connect for; omitted means the environment's DEV_ORG_ID. */
  orgId?: string;
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
        orgId={orgId}
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
        <Plug aria-hidden="true" className="h-4 w-4 text-text-muted" />
        <h4 className="text-lg font-semibold text-text">Connect a CRM</h4>
      </div>
      <p className="text-sm text-text-muted">
        Extracted call facts are pushed to the CRM as each call finishes. Pick a provider to see
        exactly what it needs.
      </p>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-text-muted"
          />
          <Input
            type="search"
            aria-label="Search providers"
            className="pl-9"
            placeholder="Search providers…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {/* A radio group, not loose buttons: these four are one mutually
            exclusive choice, and aria-pressed on a toggle would announce four
            independent on/off switches instead of "Global, 2 of 4". */}
        <div role="group" aria-label="Filter providers by market" className="flex gap-1.5">
          {MARKET_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setMarket(f.id)}
              aria-pressed={market === f.id}
              className={`cursor-pointer rounded-md border px-2.5 py-2 text-sm font-medium transition-colors duration-150 ease-out ${
                market === f.id
                  ? "border-accent bg-accent text-accent-fg"
                  : "border-border-strong bg-surface text-text hover:bg-surface-hover"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {visible.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setSelected(p)}
            className="cursor-pointer space-y-1.5 rounded-md border border-border bg-surface p-4 text-left transition-colors duration-150 ease-out hover:border-border-strong hover:bg-surface-hover"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="text-sm font-semibold text-text">{p.label}</span>
              {p.category === "automation" ? (
                <StatusChip tone="outline">Automation</StatusChip>
              ) : p.markets.includes("india") && !p.markets.includes("global") ? (
                <StatusChip tone="muted">India</StatusChip>
              ) : null}
            </div>
            <p className="text-sm leading-snug text-text-muted">{p.blurb}</p>
            <span className="block pt-1 text-xs text-text-muted">
              {p.targets.length} target{p.targets.length === 1 ? "" : "s"} · {p.auth.scheme}
            </span>
          </button>
        ))}
        {visible.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-muted sm:col-span-2 xl:col-span-3">
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
  orgId,
  onBack,
  onConnected,
}: {
  provider: CrmProviderSpec;
  workspaceId: string;
  orgId?: string;
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
        orgId,
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
            type="button"
            onClick={onBack}
            className="cursor-pointer rounded-md border border-border-strong bg-surface p-1.5 text-text transition-colors duration-150 ease-out hover:bg-surface-hover"
            aria-label="Back to provider list"
          >
            <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
          <h4 className="text-lg font-semibold text-text">{provider.label}</h4>
        </div>
        {provider.docsUrl ? (
          <a
            href={provider.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 rounded-sm text-sm font-medium text-accent-text underline underline-offset-2 hover:text-accent"
          >
            API docs{" "}
            <ExternalLink aria-hidden="true" className="h-3 w-3" />
            {/* The link opens a new tab; say so rather than leaving a
                screen-reader user to discover it after the fact. */}
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        ) : null}
      </div>

      {provider.notes ? (
        <p className="rounded-sm border-l-2 border-accent bg-accent-subtle py-2 pl-3 text-sm leading-relaxed text-text">
          {provider.notes}
        </p>
      ) : null}

      {/* Target. FormField owns the label/for and aria-describedby wiring, which
          is why every control below is inside one rather than beside a bare
          <label> as it was in v1. */}
      {provider.targets.length > 1 ? (
        <FormField label="What to create" name="crm-target" hint={target?.blurb}>
          <Select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            {provider.targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </Select>
        </FormField>
      ) : (
        <p className="text-sm leading-snug text-text-muted">{target?.blurb}</p>
      )}

      {/* Provider-declared config */}
      {provider.config.map((field) => (
        <FormField
          key={field.key}
          label={field.label}
          name={`crm-config-${field.key}`}
          required={field.required}
          hint={field.help}
        >
          {field.options ? (
            <Select
              value={config[field.key] ?? ""}
              onChange={(e) => setConfig((c) => ({ ...c, [field.key]: e.target.value }))}
            >
              {field.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              className="font-mono"
              placeholder={field.placeholder}
              value={config[field.key] ?? ""}
              onChange={(e) => setConfig((c) => ({ ...c, [field.key]: e.target.value }))}
            />
          )}
        </FormField>
      ))}

      {/* Credential */}
      {needsSecret ? (
        <FormField
          label={provider.auth.secretLabel}
          name="crm-secret"
          required
          hint={provider.auth.secretHelp}
        >
          <Input
            className="font-mono"
            type="password"
            autoComplete="off"
            placeholder="Paste the credential"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </FormField>
      ) : (
        <p className="text-sm leading-snug text-text-muted">{provider.auth.secretHelp}</p>
      )}

      <FormField label="Name (optional)" name="crm-label">
        <Input
          placeholder={`${provider.label} — ${target?.label ?? ""}`}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </FormField>

      <div className="space-y-1.5 rounded-md border border-border bg-bg-subtle p-4">
        <MonoLabel>Starting field map</MonoLabel>
        <p className="text-sm leading-snug text-text-muted">
          {Object.keys(target?.fieldMap ?? {}).length === 0
            ? "No preset — the full call envelope is sent until you define a mapping."
            : "A sensible first mapping is applied on connect. Edit it on the integration card afterwards."}
        </p>
        {Object.entries(target?.fieldMap ?? {}).map(([dest, path]) => (
          <div key={dest} className="flex items-center gap-2 font-mono text-xs">
            <span className="font-medium text-text">{dest}</span>
            <span aria-hidden="true" className="text-text-muted">
              ←
            </span>
            <span className="text-text-muted">{path}</span>
          </div>
        ))}
      </div>

      {/* aria-live: this is the only explanation of why Connect is disabled,
          and it appears and disappears as fields are filled in. */}
      {missingConfig.length > 0 ? (
        <p aria-live="polite" className="text-sm text-text-muted">
          Required: {missingConfig.map((f) => f.label).join(", ")}
        </p>
      ) : null}

      {error ? (
        <p className="rounded-md border border-danger bg-danger-subtle p-3 text-sm font-medium text-danger-text">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-3">
        <Button type="button" variant="secondary" onClick={onBack}>
          Cancel
        </Button>
        <Button type="button" disabled={!canSubmit} onClick={submit}>
          <Plug aria-hidden="true" className="h-4 w-4" />
          {pending ? "Connecting…" : `Connect ${provider.label}`}
        </Button>
      </div>
    </Card>
  );
}
