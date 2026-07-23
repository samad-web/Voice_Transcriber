"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Link2, Settings2 } from "lucide-react";
import type { CrmProviderSpec } from "@aura/shared";
import { BrutalButton, Card, MonoLabel } from "@aura/ui";
import { inputClass, monoInputClass, selectClass } from "@/lib/form";
import { connectCustomAction } from "./actions";
import { IntegrationCard, type Integration } from "./integration-card";
import { ProviderPicker } from "./provider-picker";

export type { Integration };

/**
 * The CRM console.
 *
 * Left: the catalogue and the manual escape hatch. Right: what is connected,
 * with the mapping, credential, test and delivery log for each. Everything the
 * dispatcher reads is editable here — nothing about a connector requires a
 * deploy.
 */
export function CrmManager({
  integrations,
  providers,
  sourcePaths,
  defaultWorkspaceId,
}: {
  integrations: Integration[];
  providers: CrmProviderSpec[];
  sourcePaths: Array<{ path: string; label: string }>;
  defaultWorkspaceId: string;
}) {
  const router = useRouter();
  const [showCustom, setShowCustom] = useState(false);

  const byId = new Map(providers.map((p) => [p.id, p]));

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
      <div className="space-y-6">
        <ProviderPicker
          providers={providers}
          workspaceId={defaultWorkspaceId}
          onConnected={() => router.refresh()}
        />

        <Card className="space-y-3">
          <button
            onClick={() => setShowCustom((v) => !v)}
            className="flex items-center gap-2 w-full text-left"
          >
            <Settings2 className="h-4 w-4" />
            <h4 className="text-sm font-display font-black text-black uppercase tracking-tight">
              CRM not listed?
            </h4>
          </button>
          <p className="text-xs text-neutral-500 font-sans">
            Point Aura at any HTTPS endpoint and shape the payload yourself with a field map.
          </p>
          {showCustom ? (
            <CustomWebhookForm
              workspaceId={defaultWorkspaceId}
              onDone={() => {
                setShowCustom(false);
                router.refresh();
              }}
            />
          ) : (
            <BrutalButton variant="secondary" onClick={() => setShowCustom(true)}>
              Configure a custom endpoint
            </BrutalButton>
          )}
        </Card>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <MonoLabel>Connected integrations</MonoLabel>
          <span className="text-[10px] font-mono font-bold uppercase text-neutral-400">
            {integrations.length} total
          </span>
        </div>

        {integrations.length === 0 ? (
          <Card className="flex flex-col items-center py-12 gap-3">
            <Link2 className="h-8 w-8 text-neutral-300" />
            <p className="text-xs font-mono font-bold uppercase text-neutral-400 text-center px-6">
              Nothing connected — pick a CRM to start pushing call facts
            </p>
          </Card>
        ) : (
          integrations.map((integration) => (
            <IntegrationCard
              key={integration.id}
              integration={integration}
              provider={byId.get(integration.provider)}
              sourcePaths={sourcePaths}
            />
          ))
        )}
      </div>
    </div>
  );
}

const AUTH_TYPES = [
  { value: "none", label: "No auth" },
  { value: "bearer", label: "Bearer token" },
  { value: "header", label: "Custom header" },
  { value: "header_prefix", label: "Header with prefix" },
  { value: "basic", label: "HTTP Basic (key as username)" },
  { value: "query", label: "Query parameter" },
];

function CustomWebhookForm({
  workspaceId,
  onDone,
}: {
  workspaceId: string;
  onDone: () => void;
}) {
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [authType, setAuthType] = useState("none");
  const [authHeader, setAuthHeader] = useState("X-API-Key");
  const [authPrefix, setAuthPrefix] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const needsHeaderName = authType === "header" || authType === "header_prefix" || authType === "query";
  const needsSecret = authType !== "none";

  const submit = () =>
    startTransition(async () => {
      setError(null);
      const res = await connectCustomAction({
        workspaceId,
        label: label.trim() || undefined,
        webhookUrl: url.trim(),
        authType,
        authHeader: authHeader.trim() || undefined,
        authPrefix: authPrefix || undefined,
        authSecret: secret.trim() || undefined,
      });
      if (res.error) setError(res.error);
      else onDone();
    });

  return (
    <div className="space-y-3 border-t-2 border-neutral-200 pt-3">
      <div className="space-y-1.5">
        <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
          Name
        </label>
        <input
          className={inputClass}
          placeholder="e.g. Ops dashboard"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
          Endpoint URL
        </label>
        <input
          className={monoInputClass}
          placeholder="https://hooks.example.com/aura"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
          Auth
        </label>
        <select
          className={selectClass}
          value={authType}
          onChange={(e) => setAuthType(e.target.value)}
        >
          {AUTH_TYPES.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </div>

      {needsHeaderName ? (
        <input
          className={monoInputClass}
          placeholder={authType === "query" ? "query parameter name" : "header name"}
          value={authHeader}
          onChange={(e) => setAuthHeader(e.target.value)}
        />
      ) : null}
      {authType === "header_prefix" ? (
        <input
          className={monoInputClass}
          placeholder="prefix, e.g. “Token token=” (keep the trailing space if needed)"
          value={authPrefix}
          onChange={(e) => setAuthPrefix(e.target.value)}
        />
      ) : null}
      {needsSecret ? (
        <input
          className={monoInputClass}
          type="password"
          autoComplete="off"
          placeholder="credential"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
      ) : null}

      {error ? (
        <p className="text-xs text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-3">
          {error}
        </p>
      ) : null}

      <BrutalButton
        shadow
        className="w-full"
        disabled={pending || !url.trim() || (needsSecret && !secret.trim())}
        onClick={submit}
      >
        {pending ? "CONNECTING…" : "CONNECT ENDPOINT"}
      </BrutalButton>
    </div>
  );
}
