"use client";

import { useState, useTransition } from "react";
import { Button, Card, FormField, Input, MonoLabel, StatusChip } from "@aura/ui";
import { startOAuthRedirect } from "../lib/oauth-redirect";
import { connectBasicAction, disconnectAction, startOAuthAction } from "./actions";

export interface ProviderView {
  id: string;
  label: string;
  blurb: string;
  capabilities: string[];
  auth: "oauth2" | "basic";
  configured: boolean;
  setupHint: string | null;
  fields: Array<{
    key: string;
    label: string;
    placeholder?: string;
    help?: string;
    required: boolean;
    defaultValue?: string;
    secret?: boolean;
  }>;
}

export interface ConnectionView {
  id: string;
  provider: string;
  capabilities: string[];
  account_email: string;
  display_name: string | null;
  status: "active" | "expired" | "revoked" | "error";
  last_error: string | null;
  last_synced_at: string | null;
  created_at: string;
}

/**
 * Connect your own mailbox and calendar (PRD Layer 1).
 *
 * The provider list is rendered from the API's catalogue, not hard-coded
 * here — adding a provider server-side makes it appear with no change to this
 * file, which is the same contract provider-picker.tsx has for CRM
 * connectors.
 *
 * A provider whose OAuth app the operator has not registered renders
 * disabled, with the reason. That is deliberately not hidden: "Google is
 * missing" is a support ticket, "Google needs two environment variables set"
 * is an answer.
 */
export function ConnectionsManager({
  providers,
  connections,
  initialConnected = null,
  initialError = null,
}: {
  providers: ProviderView[];
  connections: ConnectionView[];
  /** From the OAuth callback's `?connected=<email>` — shown once, on arrival. */
  initialConnected?: string | null;
  /** From the OAuth callback's `?error=<message>` — shown once, on arrival. */
  initialError?: string | null;
}) {
  const [openForm, setOpenForm] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [accountEmail, setAccountEmail] = useState("");
  const [error, setError] = useState<string | null>(initialError);
  const [connectedEmail, setConnectedEmail] = useState<string | null>(initialConnected);
  const [pending, startTransition] = useTransition();

  const byProvider = new Map(providers.map((p) => [p.id, p]));

  const beginOAuth = (provider: string) => {
    setError(null);
    setConnectedEmail(null);
    startTransition(async () => {
      const result = await startOAuthAction(provider);
      const failure = startOAuthRedirect(result, "Could not start sign-in");
      if (failure) setError(failure);
    });
  };

  const openBasic = (provider: ProviderView) => {
    setError(null);
    setOpenForm(provider.id);
    setAccountEmail("");
    setDraft(
      Object.fromEntries(provider.fields.map((f) => [f.key, f.defaultValue ?? ""])),
    );
  };

  const submitBasic = (provider: ProviderView) => {
    setError(null);
    startTransition(async () => {
      const result = await connectBasicAction({
        provider: provider.id,
        accountEmail,
        config: draft,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      setOpenForm(null);
    });
  };

  const disconnect = (id: string) => {
    setError(null);
    startTransition(async () => {
      const result = await disconnectAction(id);
      if (result.error) setError(result.error);
    });
  };

  return (
    <div className="space-y-6">
      {connectedEmail ? (
        <p
          role="status"
          className="rounded-md border border-success bg-success-subtle p-3 text-sm font-medium text-success-text"
        >
          Connected {connectedEmail}.
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-danger bg-danger-subtle p-3 text-sm font-medium text-danger-text"
        >
          {error}
        </p>
      ) : null}

      <Card>
        <MonoLabel>Your connected accounts</MonoLabel>
        {connections.length === 0 ? (
          <p className="mt-2 text-sm text-text-muted">
            Nothing connected yet. Pick a provider below — these are yours alone; nobody else on the
            team can see or use them.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border rounded-md border border-border">
            {connections.map((connection) => {
              const spec = byProvider.get(connection.provider);
              return (
                <li
                  key={connection.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <span className="block truncate text-sm font-medium text-text">
                      {connection.account_email}
                    </span>
                    <span className="text-xs text-text-muted">
                      {spec?.label ?? connection.provider}
                      {connection.capabilities.length > 0
                        ? ` · ${connection.capabilities.join(" + ")}`
                        : ""}
                      {connection.last_synced_at
                        ? ` · synced ${new Date(connection.last_synced_at).toLocaleString()}`
                        : " · not synced yet"}
                    </span>
                    {connection.last_error ? (
                      <span className="mt-0.5 block text-xs text-danger-text">
                        {connection.last_error}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusChip tone={connection.status === "active" ? "solid" : "outline"}>
                      {connection.status}
                    </StatusChip>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      loading={pending}
                      onClick={() => disconnect(connection.id)}
                    >
                      Disconnect
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {providers.map((provider) => (
          <Card key={provider.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <MonoLabel>{provider.label}</MonoLabel>
                <p className="mt-1 text-xs text-text-muted">{provider.blurb}</p>
              </div>
              <div className="flex shrink-0 gap-1">
                {provider.capabilities.map((capability) => (
                  <StatusChip key={capability} tone="outline">
                    {capability}
                  </StatusChip>
                ))}
              </div>
            </div>

            {!provider.configured ? (
              <div className="mt-3">
                <Button type="button" size="sm" disabled>
                  Connect
                </Button>
                <p className="mt-2 text-xs text-text-muted">
                  {provider.setupHint ?? "Not available on this deployment."}
                </p>
              </div>
            ) : provider.auth === "oauth2" ? (
              <div className="mt-3">
                <Button
                  type="button"
                  size="sm"
                  loading={pending}
                  onClick={() => beginOAuth(provider.id)}
                >
                  Connect {provider.label}
                </Button>
              </div>
            ) : openForm === provider.id ? (
              <div className="mt-3 space-y-3">
                <FormField label="Email address" name={`${provider.id}-email`}>
                  <Input
                    value={accountEmail}
                    onChange={(e) => setAccountEmail(e.target.value)}
                    placeholder="you@example.com"
                    type="email"
                  />
                </FormField>
                {provider.fields.map((field) => (
                  <FormField
                    key={field.key}
                    label={field.label}
                    name={`${provider.id}-${field.key}`}
                    hint={field.help}
                  >
                    <Input
                      value={draft[field.key] ?? ""}
                      onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
                      placeholder={field.placeholder}
                      type={field.secret ? "password" : "text"}
                    />
                  </FormField>
                ))}
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    loading={pending}
                    onClick={() => submitBasic(provider)}
                  >
                    Save
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setOpenForm(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-3">
                <Button type="button" size="sm" onClick={() => openBasic(provider)}>
                  Connect {provider.label}
                </Button>
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
