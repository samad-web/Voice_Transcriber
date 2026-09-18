"use client";

import { useEffect, useState, useTransition } from "react";
import {
  Button,
  Card,
  FormField,
  Input,
  MonoLabel,
  StatusChip,
  useAlert,
  useToast,
} from "@aura/ui";
import { startOAuthRedirect } from "../lib/oauth-redirect";
import { connectBasicAction, disconnectAction, startOAuthAction } from "./actions";

export interface ProviderView {
  id: string;
  label: string;
  blurb: string;
  capabilities: string[];
  auth: "oauth2" | "basic";
  configured: boolean;
  /** Whose OAuth app a sign-in goes through (migration 0120); null for non-OAuth or unset. */
  source: "organization" | "platform" | null;
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
 * here - adding a provider server-side makes it appear with no change to this
 * file, which is the same contract provider-picker.tsx has for CRM
 * connectors.
 *
 * A provider with no OAuth app - neither the organisation's own (0120) nor
 * the platform's - renders disabled, with the reason. That is deliberately not
 * hidden: "Google is missing" is a support ticket, "your account owner adds the
 * Google app below" is an answer.
 */
export function ConnectionsManager({
  providers,
  connections,
  initialConnected = null,
  initialError = null,
}: {
  providers: ProviderView[];
  connections: ConnectionView[];
  /** From the OAuth callback's `?connected=<email>` - shown once, on arrival. */
  initialConnected?: string | null;
  /** From the OAuth callback's `?error=<message>` - shown once, on arrival. */
  initialError?: string | null;
}) {
  const [openForm, setOpenForm] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [accountEmail, setAccountEmail] = useState("");
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const toast = useToast();

  // The OAuth round trip ends on this page with ?connected= or ?error= in the
  // query. That is still the answer to a button somebody pressed here a moment
  // ago, so it is reported the same way as an attempt that never left the page
  // - the redirect is an implementation detail, not a different kind of event.
  // Both props are read from the URL by the server component and never change
  // while this stays mounted, so this announces once.
  useEffect(() => {
    if (initialConnected) toast(`Connected ${initialConnected}`);
    if (initialError) {
      void alert({ title: "Couldn't finish connecting", body: initialError, tone: "danger" });
    }
  }, [initialConnected, initialError, alert, toast]);

  const byProvider = new Map(providers.map((p) => [p.id, p]));

  const beginOAuth = (provider: string) => {
    startTransition(async () => {
      const result = await startOAuthAction(provider);
      const failure = startOAuthRedirect(result, "Could not start sign-in");
      if (failure) {
        await alert({ title: "Couldn't start sign-in", body: failure, tone: "danger" });
      }
    });
  };

  const openBasic = (provider: ProviderView) => {
    setOpenForm(provider.id);
    setAccountEmail("");
    setDraft(
      Object.fromEntries(provider.fields.map((f) => [f.key, f.defaultValue ?? ""])),
    );
  };

  const submitBasic = (provider: ProviderView) => {
    startTransition(async () => {
      const result = await connectBasicAction({
        provider: provider.id,
        accountEmail,
        config: draft,
      });
      if (result.error) {
        await alert({
          title: `Couldn't connect ${provider.label}`,
          body: result.error,
          tone: "danger",
        });
        return;
      }
      setOpenForm(null);
    });
  };

  const disconnect = (id: string) => {
    startTransition(async () => {
      const result = await disconnectAction(id);
      if (result.error) {
        await alert({
          title: "Couldn't disconnect the account",
          body: result.error,
          tone: "danger",
        });
      }
    });
  };

  return (
    <div className="space-y-6">
      <Card>
        <MonoLabel>Your connected accounts</MonoLabel>
        {connections.length === 0 ? (
          <p className="mt-2 text-sm text-text-muted">
            Nothing connected yet. Pick a provider below - these are yours alone; nobody else on the
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
