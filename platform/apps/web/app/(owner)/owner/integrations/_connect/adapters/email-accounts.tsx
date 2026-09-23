"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, FormField, Input } from "@aura/ui";
import { connectBasicAction, startOAuthAction } from "../../../connections/actions";
import { OAuthAppsPanel } from "../../../connections/oauth-apps-panel";
import { startOAuthRedirect } from "../../../lib/oauth-redirect";
import { connectHref } from "../../app-links";
import { StepActions, StepHeading } from "../step-heading";
import type { StepProps } from "../types";

/**
 * Gmail & Google Calendar, Outlook & Microsoft 365, and any other mailbox -
 * the three a person connects for themselves. What used to be the Connections
 * page's cards, as steps.
 */

const CAPABILITY_WORDS: Record<string, string> = {
  email: "mail",
  calendar: "calendar",
  sheets: "spreadsheets",
};

function capabilitySentence(capabilities: string[]): string | null {
  const words = capabilities.map((c) => CAPABILITY_WORDS[c]).filter(Boolean) as string[];
  if (words.length === 0) return null;
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
  return `Aura can now read your ${list} with people already in your CRM.`;
}

/** The sign-in: out to Google or Microsoft, and back to the check step. */
export function OAuthAccountAuth({ spec, data, fail }: StepProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const provider = spec.oauthProvider ?? "";
  const vendor = spec.vendor;

  // Not available because the organisation has no sign-in app of its own
  // (0120). The route only lets the OWNER get here in that state; everyone
  // else is shown "ask your account owner" on the app page.
  if (data.status.state === "unavailable") {
    return (
      <>
        <StepHeading title={`First, add your organisation's ${vendor} sign-in app`}>
          Every person&apos;s {vendor} sign-in goes through an app your organisation registers with {vendor}.
          Add its details below - once - and then continue.
        </StepHeading>
        {data.oauthApps ? (
          <div className="mt-4">
            <OAuthAppsPanel data={data.oauthApps} />
          </div>
        ) : null}
        <StepActions>
          <Button type="button" onClick={() => router.refresh()}>
            I&apos;ve added it - continue
          </Button>
        </StepActions>
      </>
    );
  }

  const begin = async () => {
    setBusy(true);
    const result = await startOAuthAction(provider, `${connectHref(spec.id)}?step=check`);
    const error = startOAuthRedirect(result, `Could not start the ${vendor} sign-in.`);
    if (error) {
      fail(error);
      setBusy(false);
    }
  };

  return (
    <>
      <StepHeading title={`Sign in to ${vendor}`}>
        You&apos;ll go to {vendor} to pick the account and approve access, then come straight back here.
        It connects your own account - nobody else on the team can send as you.
      </StepHeading>
      <StepActions>
        <Button type="button" loading={busy} onClick={() => void begin()}>
          Continue to {vendor}
        </Button>
      </StepActions>
    </>
  );
}

/** What came back from the sign-in, before calling it done. */
export function OAuthAccountCheck({ spec, data, params, next, goTo }: StepProps) {
  const email = params.connected;
  const provider = data.providers?.find((p) => p.id === spec.oauthProvider);
  const row = data.connections.find((c) => c.mine && c.label.toLowerCase() === email?.toLowerCase());

  if (!email) {
    return (
      <>
        <StepHeading title={`Nothing came back from ${spec.vendor} yet`}>
          The sign-in did not finish. Start it again - it only takes a moment.
        </StepHeading>
        <StepActions>
          <Button type="button" onClick={() => goTo("auth")}>
            Sign in again
          </Button>
        </StepActions>
      </>
    );
  }

  return (
    <>
      <StepHeading title={`Connected as ${email}`}>
        {capabilitySentence(provider?.capabilities ?? []) ?? `Aura can now use this ${spec.vendor} account.`}{" "}
        The first sync runs in the background; emails and meetings appear on timelines within a few minutes.
      </StepHeading>
      {row?.lastError ? <p className="mt-3 text-sm text-orange-text">{row.lastError}</p> : null}
      <StepActions>
        <Button type="button" onClick={() => next({ connected: null })}>
          Continue
        </Button>
      </StepActions>
    </>
  );
}

/** Any other mailbox: the provider's own fields, as the Connections page asked for them. */
export function SmtpAuth({ data, next, fail }: StepProps) {
  const view = data.providers?.find((p) => p.id === "imap");
  const [accountEmail, setAccountEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries((view?.fields ?? []).map((f) => [f.key, f.defaultValue ?? ""])),
  );
  const [busy, setBusy] = useState(false);

  if (!view) {
    return (
      <StepHeading title="Mail servers are not available here">
        This deployment does not offer IMAP and SMTP mailboxes. Your provider can switch it on.
      </StepHeading>
    );
  }

  const missing =
    !accountEmail.trim() || view.fields.some((f) => f.required && !(draft[f.key] ?? "").trim());

  const submit = async () => {
    setBusy(true);
    const result = await connectBasicAction({
      provider: view.id,
      accountEmail: accountEmail.trim(),
      displayName: displayName.trim() || undefined,
      config: draft,
    });
    setBusy(false);
    if (result.error) {
      fail(result.error);
      return;
    }
    next();
  };

  return (
    <>
      <StepHeading title="Enter your mail server">
        The details your mail provider gives for sending with an email app. The password is stored
        encrypted and never shown again.
      </StepHeading>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <FormField label="Email address" name="accountEmail" required>
          <Input
            type="email"
            value={accountEmail}
            onChange={(e) => setAccountEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </FormField>
        <FormField label="Your name on sent mail" name="displayName">
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </FormField>
        {view.fields.map((field) => (
          <FormField key={field.key} label={field.label} name={field.key} hint={field.help} required={field.required}>
            <Input
              value={draft[field.key] ?? ""}
              onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
              placeholder={field.placeholder}
              type={field.secret ? "password" : "text"}
            />
          </FormField>
        ))}
      </div>
      <StepActions>
        <Button type="button" loading={busy} disabled={missing} onClick={() => void submit()}>
          Connect
        </Button>
      </StepActions>
    </>
  );
}
