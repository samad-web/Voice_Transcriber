"use client";

import { useState, useTransition } from "react";
import { Copy, ExternalLink } from "lucide-react";
import {
  Button,
  Card,
  FormField,
  Input,
  MonoLabel,
  RowHint,
  StatusChip,
  useAlert,
  useConfirm,
  useToast,
} from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import {
  removeOAuthAppAction,
  saveOAuthAppAction,
  type OAuthAppView,
  type OAuthAppsView,
} from "./actions";

/**
 * The organisation's own Google and Microsoft sign-in apps (migration 0120).
 *
 * ── WHY THE CLIENT BRINGS THEM ─────────────────────────────────────────────
 *
 * On a multi-tenant platform each client registers the app its team consents
 * to, in its own Google Cloud project or Entra directory. Rendered for owners
 * only: the page passes this panel data only when the owner-only API answered.
 *
 * ── THE SECRET IS WRITE-ONLY ───────────────────────────────────────────────
 *
 * The API never returns it, so the secret field is always blank and an empty
 * field on save means "keep the stored one" - the same contract as the
 * Razorpay keys in invoices/payment-settings.tsx. After a save the typed value
 * is cleared from the form, because a secret left sitting in an input is the
 * same disclosure the read path avoids.
 */
export function OAuthAppsPanel({ data }: { data: OAuthAppsView }) {
  const toast = useToast();
  const alert = useAlert();

  const copyRedirect = () => {
    // Sync handler, promise voided - see owner-accounts.tsx on why an async
    // onClick turns a rejected clipboard write into an unhandled rejection.
    void navigator.clipboard
      .writeText(data.redirectUri)
      .then(() => toast("Redirect URI copied"))
      .catch(() =>
        alert({
          title: "Couldn't copy the redirect URI",
          body: "Select the address and copy it by hand.",
          tone: "danger",
        }),
      );
  };

  return (
    <section aria-labelledby="oauth-apps-heading" className="space-y-4">
      <div className="border-b border-border pb-2">
        <h2 id="oauth-apps-heading" className="text-base font-semibold text-text">
          Organisation sign-in apps
        </h2>
        <p className="mt-0.5 max-w-2xl text-sm text-text-muted">
          Your team connects Google and Microsoft through apps your organisation registers. Add each
          app&rsquo;s client ID and secret once. The secret is encrypted and can be replaced, but
          it is never shown again - not to you, and not to anyone else.
        </p>
      </div>

      <Card className="space-y-2">
        <MonoLabel>Redirect URI - paste this into both app registrations</MonoLabel>
        <div className="flex items-center gap-2 rounded-md border border-border bg-bg-subtle py-1.5 pr-1.5 pl-3">
          <span className="min-w-0 flex-1 font-mono text-xs break-all text-text">
            {data.redirectUri}
          </span>
          <Button type="button" variant="secondary" size="sm" className="shrink-0" onClick={copyRedirect}>
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            Copy
          </Button>
        </div>
        <RowHint kind="action">
          It must match exactly - same https, no trailing slash. Google calls it an
          &ldquo;Authorised redirect URI&rdquo;; Microsoft a &ldquo;Web&rdquo; platform redirect URI.
        </RowHint>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {data.apps.map((app) => (
          <OAuthAppCard key={app.provider} app={app} />
        ))}
      </div>
    </section>
  );
}

function OAuthAppCard({ app }: { app: OAuthAppView }) {
  const configured = Boolean(app.clientId && app.hasSecret);
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState(app.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [tenant, setTenant] = useState(app.tenant ?? "");
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const confirm = useConfirm();
  const toast = useToast();

  const trimmedId = clientId.trim();
  const idChanged = configured && trimmedId !== app.clientId;
  // A new app, or a different client ID, needs its own secret - the API
  // enforces the same rule; saying so here saves a round trip.
  const secretRequired = !configured || idChanged;
  const canSave = trimmedId.length >= 8 && (!secretRequired || clientSecret.trim().length >= 8);

  const openForm = () => {
    setClientId(app.clientId ?? "");
    setClientSecret("");
    setTenant(app.tenant ?? "");
    setOpen(true);
  };

  const save = async () => {
    if (idChanged && app.activeConnections > 0) {
      const ok = await confirm({
        title: `Switch to a different ${app.label} app?`,
        body:
          `${app.activeConnections} connected ${app.activeConnections === 1 ? "account was" : "accounts were"} ` +
          "signed in through the current app. Their access belongs to that app, so each person " +
          "will need to reconnect from this page after the switch.",
        confirmLabel: "Switch app",
      });
      if (!ok) return;
    }
    startTransition(async () => {
      const result = await saveOAuthAppAction(app.provider, {
        clientId: trimmedId,
        clientSecret: clientSecret.trim() || undefined,
        tenant: app.tenantField ? tenant.trim() || null : undefined,
      });
      if (result.error) {
        await alert({
          title: `Couldn't save the ${app.label} app`,
          body: result.error,
          tone: "danger",
        });
        return;
      }
      setClientSecret("");
      setOpen(false);
      toast(`${app.label} app saved`);
    });
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Remove your ${app.label} app?`,
      body:
        app.activeConnections > 0
          ? `${app.activeConnections} connected ${app.activeConnections === 1 ? "account stops" : "accounts stop"} ` +
            "syncing at their next token refresh, and nobody can connect until an app is added " +
            "again. Adding the same client ID back later picks them up where they left off."
          : "Nobody on your team can connect this provider until an app is added again.",
      confirmLabel: "Remove app",
      tone: "danger",
      // Recoverable: re-adding the same app restores every connection.
      requireTyped: false,
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await removeOAuthAppAction(app.provider);
      if (result.error) {
        await alert({
          title: `Couldn't remove the ${app.label} app`,
          body: result.error,
          tone: "danger",
        });
      }
    });
  };

  const chip = configured ? (
    <StatusChip tone="solid">Your app</StatusChip>
  ) : app.platformFallback ? (
    <StatusChip tone="outline">Platform app</StatusChip>
  ) : (
    <StatusChip tone="muted">Not set up</StatusChip>
  );

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-text">{app.label}</h3>
          <p className="mt-0.5 text-xs text-text-muted">
            {configured
              ? "Your team signs in through your organisation's own app."
              : app.platformFallback
                ? "Your team is using the platform's shared app until you add your own."
                : "Nobody can connect this provider until an app is added."}
          </p>
        </div>
        {chip}
      </div>

      {!open ? (
        configured ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg border border-border bg-bg-subtle p-3.5 text-xs">
            <dt className="text-text-muted">Client ID</dt>
            <dd className="min-w-0 font-mono break-all text-text">{app.clientId}</dd>
            <dt className="text-text-muted">Client secret</dt>
            <dd className="text-text">Stored, encrypted - never shown</dd>
            {app.tenantField ? (
              <>
                <dt className="text-text-muted">{app.tenantField.label}</dt>
                <dd className="min-w-0 font-mono break-all text-text">
                  {app.tenant ?? `${app.tenantField.default} (any account)`}
                </dd>
              </>
            ) : null}
            {app.updatedAt ? (
              <>
                <dt className="text-text-muted">Last changed</dt>
                <dd className="text-text">
                  <LocalTime iso={app.updatedAt} mode="date" />
                </dd>
              </>
            ) : null}
            <dt className="text-text-muted">In use by</dt>
            <dd className="text-text tabular-nums">
              {app.activeConnections} connected{" "}
              {app.activeConnections === 1 ? "account" : "accounts"}
            </dd>
          </dl>
        ) : null
      ) : (
        <div className="space-y-4">
          <FormField
            label="Client ID"
            name={`${app.provider}-client-id`}
            required
            hint={app.clientIdHint}
          >
            <Input
              name={`${app.provider}-client-id`}
              value={clientId}
              disabled={pending}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setClientId(e.target.value)}
            />
          </FormField>

          <FormField
            label="Client secret"
            name={`${app.provider}-client-secret`}
            required={secretRequired}
            hint={
              !configured
                ? "Shown by the provider once, when you create it. Copy the value, not its ID."
                : idChanged
                  ? "A different client ID needs its own secret."
                  : "Stored and never shown. Leave blank to keep the current one, or paste a new one to replace it."
            }
          >
            <Input
              name={`${app.provider}-client-secret`}
              type="password"
              autoComplete="new-password"
              value={clientSecret}
              disabled={pending}
              placeholder={secretRequired ? "" : "Unchanged"}
              onChange={(e) => setClientSecret(e.target.value)}
            />
          </FormField>

          {app.tenantField ? (
            <FormField
              label={app.tenantField.label}
              name={`${app.provider}-tenant`}
              hint={app.tenantField.help}
            >
              <Input
                name={`${app.provider}-tenant`}
                value={tenant}
                disabled={pending}
                autoComplete="off"
                spellCheck={false}
                placeholder={app.tenantField.default}
                onChange={(e) => setTenant(e.target.value)}
              />
            </FormField>
          ) : null}

          {idChanged && app.activeConnections > 0 ? (
            <RowHint kind="action">
              Changing the client ID disconnects {app.activeConnections} connected{" "}
              {app.activeConnections === 1 ? "account" : "accounts"} - each person reconnects
              afterwards.
            </RowHint>
          ) : null}
        </div>
      )}

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <a
          href={app.registerUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-xs text-text-muted underline-offset-2 hover:text-text hover:underline"
        >
          Open {app.registerLabel}
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
        <div className="flex flex-wrap items-center gap-2">
          {open ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                loading={pending}
                disabled={pending || !canSave}
                onClick={() => void save()}
              >
                Save app
              </Button>
            </>
          ) : configured ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => void remove()}
              >
                Remove
              </Button>
              <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={openForm}>
                Replace
              </Button>
            </>
          ) : (
            <Button type="button" size="sm" onClick={openForm}>
              Add {app.label} app
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
