"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Link2, Settings2 } from "lucide-react";
import type { CrmProviderSpec } from "@aura/shared";
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  FormField,
  Input,
  MonoLabel,
  Select,
} from "@aura/ui";
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
  workspaces,
  orgId,
}: {
  integrations: Integration[];
  providers: CrmProviderSpec[];
  sourcePaths: Array<{ path: string; label: string }>;
  /**
   * Workspaces a connector may deliver into. A tenant with more than one
   * instance has more than one workspace, and defaulting to the first silently
   * routed leads to whichever instance happened to sort first.
   */
  workspaces: Array<{ id: string; name: string }>;
  /** The tenant being configured — supplied by every caller. */
  orgId?: string;
}) {
  const router = useRouter();
  const [showCustom, setShowCustom] = useState(false);
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");

  const byId = new Map(providers.map((p) => [p.id, p]));

  return (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
      <div className="space-y-6">
        {workspaces.length > 1 ? (
          <Card>
            <FormField
              label="Deliver leads into"
              name="crm-workspace"
              hint="This tenant has several workspaces. New connectors are created against the one selected here."
            >
              <Select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </FormField>
          </Card>
        ) : null}

        <ProviderPicker
          providers={providers}
          workspaceId={workspaceId}
          orgId={orgId}
          onConnected={() => router.refresh()}
        />

        <Card className="space-y-3">
          <button
            type="button"
            onClick={() => setShowCustom((v) => !v)}
            aria-expanded={showCustom}
            aria-controls="crm-custom-endpoint"
            className="flex w-full cursor-pointer items-center gap-2 rounded-sm text-left"
          >
            <Settings2 aria-hidden="true" className="h-4 w-4 text-text-muted" />
            <h4 className="text-sm font-semibold text-text">CRM not listed?</h4>
          </button>
          <p className="text-sm text-text-muted">
            Point Aura at any HTTPS endpoint and shape the payload yourself with a field map.
          </p>
          {showCustom ? (
            <CustomWebhookForm
              panelId="crm-custom-endpoint"
              workspaceId={workspaceId}
              orgId={orgId}
              onDone={() => {
                setShowCustom(false);
                router.refresh();
              }}
            />
          ) : (
            <Button type="button" variant="secondary" onClick={() => setShowCustom(true)}>
              Configure a custom endpoint
            </Button>
          )}
        </Card>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <MonoLabel>Connected integrations</MonoLabel>
          <span className="text-xs text-text-muted tabular-nums">{integrations.length} total</span>
        </div>

        {integrations.length === 0 ? (
          <EmptyState
            icon={<Link2 className="h-8 w-8" />}
            title="Nothing connected yet"
            description="Pick a CRM from the catalogue to start pushing call facts — or point Aura at your own HTTPS endpoint."
          />
        ) : (
          integrations.map((integration) => (
            <IntegrationCard
              key={integration.id}
              integration={integration}
              provider={byId.get(integration.provider)}
              sourcePaths={sourcePaths}
              orgId={orgId}
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
  panelId,
  workspaceId,
  orgId,
  onDone,
}: {
  panelId: string;
  workspaceId: string;
  orgId?: string;
  onDone: () => void;
}) {
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [authType, setAuthType] = useState("none");
  const [authHeader, setAuthHeader] = useState("X-API-Key");
  const [authPrefix, setAuthPrefix] = useState("");
  const [secret, setSecret] = useState("");
  const [onlyQualified, setOnlyQualified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const needsHeaderName = authType === "header" || authType === "header_prefix" || authType === "query";
  const needsSecret = authType !== "none";

  const submit = () =>
    startTransition(async () => {
      setError(null);
      const res = await connectCustomAction({
        workspaceId,
        orgId,
        label: label.trim() || undefined,
        webhookUrl: url.trim(),
        authType,
        authHeader: authHeader.trim() || undefined,
        authPrefix: authPrefix || undefined,
        authSecret: secret.trim() || undefined,
        onlyQualified,
      });
      if (res.error) setError(res.error);
      else onDone();
    });

  return (
    <div id={panelId} className="space-y-3 border-t border-border pt-3">
      <FormField label="Name" name="custom-label">
        <Input
          placeholder="e.g. Ops dashboard"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </FormField>

      <FormField label="Endpoint URL" name="custom-url" required>
        <Input
          className="font-mono"
          type="url"
          inputMode="url"
          placeholder="https://hooks.example.com/aura"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </FormField>

      <FormField label="Auth" name="custom-auth-type">
        <Select value={authType} onChange={(e) => setAuthType(e.target.value)}>
          {AUTH_TYPES.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </Select>
      </FormField>

      {/* These three appear and disappear with the auth scheme, so each needs
          its own label rather than the shared placeholder-as-label the v1 form
          relied on — a field that materialises unlabelled mid-form is the
          worst case for WCAG 3.3.2. */}
      {needsHeaderName ? (
        <FormField
          label={authType === "query" ? "Query parameter name" : "Header name"}
          name="custom-auth-header"
        >
          <Input
            className="font-mono"
            value={authHeader}
            onChange={(e) => setAuthHeader(e.target.value)}
          />
        </FormField>
      ) : null}
      {authType === "header_prefix" ? (
        <FormField
          label="Header prefix"
          name="custom-auth-prefix"
          hint="Keep the trailing space if the scheme needs one."
        >
          <Input
            className="font-mono"
            placeholder="e.g. “Token token=”"
            value={authPrefix}
            onChange={(e) => setAuthPrefix(e.target.value)}
          />
        </FormField>
      ) : null}
      {needsSecret ? (
        <FormField label="Credential" name="custom-secret" required>
          <Input
            className="font-mono"
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </FormField>
      ) : null}

      <div className="rounded-md border border-border p-3">
        <Checkbox
          label="Qualified leads only"
          description="Send only calls the AI agent qualified as a lead. Leave off to receive every completed call, including no-answers and wrong numbers."
          checked={onlyQualified}
          onChange={(e) => setOnlyQualified(e.target.checked)}
        />
      </div>

      {error ? (
        <p className="rounded-md border border-danger bg-danger-subtle p-3 text-sm font-medium text-danger-text">
          {error}
        </p>
      ) : null}

      <Button
        type="button"
        className="w-full"
        disabled={pending || !url.trim() || (needsSecret && !secret.trim())}
        onClick={submit}
      >
        {pending ? "Connecting…" : "Connect endpoint"}
      </Button>
    </div>
  );
}
