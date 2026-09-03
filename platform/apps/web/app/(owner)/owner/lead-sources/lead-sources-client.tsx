"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  Button,
  Card,
  EmptyState,
  FormField,
  Input,
  MonoLabel,
  Select,
  StatusChip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@aura/ui";
import type { LeadSourceKind } from "@aura/shared";
import { startOAuthRedirect } from "../lib/oauth-redirect";
import {
  createLeadSourceAction,
  listIntakeEventsAction,
  replayIntakeEventAction,
  rotateLeadSourceTokenAction,
  startLinkedInConnectAction,
  updateLeadSourceAction,
  type IntakeEvent,
} from "./actions";
import type { CatalogueChannel, LeadSourceRow, LinkedInStatus } from "./page";

/**
 * The lead intake engine's console (migration 0078).
 *
 * ── WHAT THIS PAGE IS ACTUALLY FOR ────────────────────────────────────────
 *
 * Not "configuration". The thing a person comes here to do is answer one of
 * two questions: "how do I wire my website up to this?" and "we submitted the
 * form, where did it go?". So the endpoint and its copy-paste snippet are the
 * first thing on a source, and the arrival log - including the arrivals that
 * produced NO lead, with the reason in words - is one click away on every
 * source. A ledger that only recorded successes would answer neither question.
 */
export function LeadSourcesClient({
  sources,
  channels,
  linkedin,
  origin,
}: {
  sources: LeadSourceRow[];
  channels: CatalogueChannel[];
  linkedin: LinkedInStatus;
  origin: string;
}) {
  const [adding, setAdding] = useState(false);
  const [openEvents, setOpenEvents] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <MonoLabel>{sources.length} source(s)</MonoLabel>
        <Button type="button" onClick={() => setAdding((open) => !open)}>
          {adding ? "Cancel" : "Add a source"}
        </Button>
      </div>

      {adding ? (
        <NewSourceForm channels={channels} onDone={() => setAdding(false)} origin={origin} />
      ) : null}

      {sources.length === 0 && !adding ? (
        <EmptyState
          title="No lead sources yet"
          description="Add your website form first - it takes one snippet and starts working immediately."
        />
      ) : null}

      {sources.map((source) => (
        <SourceCard
          key={source.id}
          source={source}
          channels={channels}
          origin={origin}
          eventsOpen={openEvents === source.id}
          onToggleEvents={() => setOpenEvents(openEvents === source.id ? null : source.id)}
        />
      ))}

      <LinkedInPanel status={linkedin} />
    </div>
  );
}

// ── one source ────────────────────────────────────────────────────────────

function SourceCard({
  source,
  channels,
  origin,
  eventsOpen,
  onToggleEvents,
}: {
  source: LeadSourceRow;
  channels: CatalogueChannel[];
  origin: string;
  eventsOpen: boolean;
  onToggleEvents: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(source.intake_token);
  const [path, setPath] = useState(source.endpointPath);
  const channel = channels.find((c) => c.id === source.kind);
  const url = path ? `${origin}/v1${path}` : null;

  const setStatus = (status: "active" | "paused") => {
    setError(null);
    startTransition(async () => {
      const result = await updateLeadSourceAction(source.id, { status });
      if (result.error) setError(result.error);
    });
  };

  const rotate = () => {
    setError(null);
    startTransition(async () => {
      const result = await rotateLeadSourceTokenAction(source.id);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.data) {
        setToken(result.data.intakeToken);
        setPath(result.data.endpointPath);
      }
    });
  };

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-text">{source.name}</h3>
            <StatusChip tone={source.status === "active" ? "solid" : "outline"}>
              {source.status}
            </StatusChip>
            {source.recent_failures > 0 ? (
              <StatusChip tone="danger">{source.recent_failures} failed this week</StatusChip>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-text-muted">
            {channel?.label ?? source.kind}
            {source.provider !== "generic" ? ` · ${source.provider}` : ""}
            {" · "}
            {source.lead_count} lead(s) from {source.event_count} arrival(s)
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={onToggleEvents}
            aria-expanded={eventsOpen}
          >
            {eventsOpen ? "Hide arrivals" : "Recent arrivals"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            loading={pending}
            onClick={() => setStatus(source.status === "active" ? "paused" : "active")}
          >
            {source.status === "active" ? "Pause" : "Resume"}
          </Button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-3 rounded-md border border-danger bg-danger-subtle p-3 text-sm text-danger-text">
          {error}
        </p>
      ) : null}

      {source.last_error ? (
        <p className="mt-3 rounded-md border border-border bg-surface-hover p-3 text-sm text-text-muted">
          <span className="font-medium text-text">Last error:</span> {source.last_error}
        </p>
      ) : null}

      {url ? (
        <div className="mt-4 space-y-3">
          <div>
            <MonoLabel>Endpoint</MonoLabel>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <code className="flex-1 break-all rounded-md border border-border bg-surface-hover px-3 py-2 text-xs">
                {url}
              </code>
              <CopyButton value={url} label="Copy URL" />
              <Button type="button" variant="secondary" loading={pending} onClick={rotate}>
                Rotate token
              </Button>
            </div>
            <p className="mt-1 text-xs text-text-muted">
              {/* Said plainly because a tenant WILL paste this into a public page
                  and should not be surprised by that later. */}
              This URL is the credential. It is safe in your own website&rsquo;s HTML - it can
              only create a lead on this source and can read nothing - but rotate it if it
              ends up somewhere you did not choose.
            </p>
          </div>

          {source.kind === "web_form" ? <FormSnippet url={url} /> : null}
          {source.kind === "email" ? <EmailInstructions url={url} /> : null}
          {source.kind === "telephony" ? <TelephonyInstructions url={url} provider={source.provider} /> : null}
        </div>
      ) : null}

      {eventsOpen ? <EventLog sourceId={source.id} /> : null}

      {/* Deliberately last and understated: the token itself is only needed if
          somebody is wiring this up by hand rather than copying the URL. */}
      <p className="mt-4 text-xs text-text-muted">
        Token <code className="break-all">{token.slice(0, 8)}…</code>
        {source.has_signing_secret ? " · signature verification on" : ""}
      </p>
    </Card>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

/**
 * The whole point of the web-form channel: something a person can paste into
 * their own site and be done.
 *
 * Posts JSON rather than a native form submission so the page stays put and
 * the visitor sees a thank-you instead of a browser navigating to an API
 * response. The honeypot input is included because it costs one line and stops
 * the overwhelming majority of form spam.
 */
function FormSnippet({ url }: { url: string }) {
  const snippet = `<form id="aura-lead-form">
  <input name="name" placeholder="Your name" required />
  <input name="email" type="email" placeholder="Email" />
  <input name="phone" placeholder="Phone" />
  <textarea name="message" placeholder="How can we help?"></textarea>
  <!-- Leave this empty. Bots fill it in; people never see it. -->
  <input name="_hp" tabindex="-1" autocomplete="off" style="display:none" />
  <button type="submit">Send</button>
</form>
<script>
document.getElementById("aura-lead-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  const params = new URLSearchParams(location.search);
  for (const k of ["utm_source", "utm_medium", "utm_campaign"]) {
    if (params.get(k)) body[k] = params.get(k);
  }
  await fetch(${JSON.stringify(url)}, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  e.target.innerHTML = "<p>Thanks - we'll be in touch.</p>";
});
</script>`;

  return (
    <div>
      <MonoLabel>Paste this into your website</MonoLabel>
      <pre className="mt-1 max-h-64 overflow-auto rounded-md border border-border bg-surface-hover p-3 text-xs leading-relaxed">
        <code>{snippet}</code>
      </pre>
      <div className="mt-2 flex gap-2">
        <CopyButton value={snippet} label="Copy snippet" />
      </div>
      <p className="mt-1 text-xs text-text-muted">
        Field names are matched flexibly - <code>name</code>, <code>full_name</code> and Contact
        Form 7&rsquo;s <code>your-name</code> all work. The UTM parameters are read from the
        landing page&rsquo;s own query string, which is what makes per-campaign attribution work
        without tagging anything by hand.
      </p>
    </div>
  );
}

function EmailInstructions({ url }: { url: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-hover p-3 text-sm text-text-muted">
      <p className="font-medium text-text">How to connect your enquiry inbox</p>
      <p className="mt-1">
        Point your mail relay&rsquo;s inbound route (Mailgun Routes, SendGrid Inbound Parse,
        Postmark Inbound, or SES + SNS) at <code className="break-all">{url}</code>, then forward
        your public enquiry address - sales@, info@, enquiries@ - into it. Every new message
        becomes a lead, with the sender as the contact and the subject and body as the enquiry.
      </p>
      <p className="mt-2">
        Forward a shared enquiry inbox, never a person&rsquo;s own mailbox. To put a
        colleague&rsquo;s Gmail or Outlook conversations on the CRM timeline, use{" "}
        <strong>Connections</strong> instead - that path only records messages with people who are
        already contacts, and never stores a message body.
      </p>
    </div>
  );
}

function TelephonyInstructions({ url, provider }: { url: string; provider: string }) {
  const label =
    provider === "exotel"
      ? "Exotel passthrough / call-status callback"
      : provider === "knowlarity"
        ? "Knowlarity SR notification URL"
        : provider === "ozonetel"
          ? "Ozonetel CloudAgent callback URL"
          : provider === "twilio"
            ? "Twilio voice status callback"
            : "your provider's call webhook";
  return (
    <div className="rounded-md border border-border bg-surface-hover p-3 text-sm text-text-muted">
      <p className="font-medium text-text">How to connect your phone system</p>
      <p className="mt-1">
        Paste <code className="break-all">{url}</code> into {label}. Inbound and missed calls
        become leads as the phone rings, with the caller&rsquo;s number as the identity - so a
        missed call is a card on the board rather than a line in a log nobody reads.
      </p>
      <p className="mt-2">
        Outbound calls your team places are ignored: those are your own activity, not new
        business. {provider === "twilio" ? "Add your Twilio auth token as the signing secret to verify every callback." : ""}
      </p>
    </div>
  );
}

// ── arrivals ──────────────────────────────────────────────────────────────

const OUTCOME_TONE = {
  created: "solid",
  updated: "solid",
  duplicate: "muted",
  rejected: "outline",
  error: "danger",
} as const;

function EventLog({ sourceId }: { sourceId: string }) {
  const [events, setEvents] = useState<IntakeEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    const result = await listIntakeEventsAction(sourceId);
    if (result.error) setError(result.error);
    else setEvents(result.data?.events ?? []);
  }, [sourceId]);

  // In an effect, not during render: a fetch kicked off from the render body
  // fires again on every re-render the parent causes, which on a page with a
  // pending transition is a request loop rather than one load.
  useEffect(() => {
    let live = true;
    void listIntakeEventsAction(sourceId).then((result) => {
      if (!live) return;
      if (result.error) setError(result.error);
      else setEvents(result.data?.events ?? []);
    });
    return () => {
      live = false;
    };
  }, [sourceId]);

  const replay = (eventId: string) => {
    startTransition(async () => {
      const result = await replayIntakeEventAction(eventId);
      if (result.error) {
        setError(result.error);
        return;
      }
      await load();
    });
  };

  if (error) {
    return (
      <p role="alert" className="mt-4 rounded-md border border-danger bg-danger-subtle p-3 text-sm text-danger-text">
        {error}
      </p>
    );
  }
  if (events === null) {
    return <p className="mt-4 text-sm text-text-muted">Loading arrivals…</p>;
  }
  if (events.length === 0) {
    return (
      <p className="mt-4 text-sm text-text-muted">
        Nothing has arrived here yet. Once your form or provider posts to the endpoint above,
        every attempt shows up here - including the ones that produced no lead, with the reason.
      </p>
    );
  }

  return (
    <div className="mt-4 overflow-x-auto">
      <Table caption="Recent arrivals at this lead source">
        <TableHead>
          <TableRow>
            <TableHeaderCell>When</TableHeaderCell>
            <TableHeaderCell>Outcome</TableHeaderCell>
            <TableHeaderCell>Lead</TableHeaderCell>
            <TableHeaderCell>Detail</TableHeaderCell>
            <TableHeaderCell> </TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {events.map((event) => (
            <TableRow key={event.id}>
              <TableCell>{new Date(event.received_at).toLocaleString()}</TableCell>
              <TableCell>
                <StatusChip tone={OUTCOME_TONE[event.outcome] ?? "muted"}>{event.outcome}</StatusChip>
              </TableCell>
              <TableCell>{event.lead_title ?? "-"}</TableCell>
              <TableCell className="max-w-md text-sm text-text-muted">
                {event.reason ?? summarisePayload(event.payload)}
              </TableCell>
              <TableCell>
                {/* Replaying an arrival that already produced a lead is refused
                    by the API, so this cannot duplicate anybody - which is why
                    the button is shown rather than hidden behind a guess about
                    which rows are safe. */}
                {event.outcome === "rejected" || event.outcome === "error" ? (
                  <Button type="button" variant="secondary" loading={pending} onClick={() => replay(event.id)}>
                    Retry
                  </Button>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** The first few fields, so a row is recognisable without opening anything. */
function summarisePayload(payload: Record<string, unknown>): string {
  return (
    Object.entries(payload)
      .filter(([, value]) => typeof value === "string" || typeof value === "number")
      .slice(0, 3)
      .map(([key, value]) => `${key}: ${String(value).slice(0, 40)}`)
      .join(" · ") || "-"
  );
}

// ── adding one ────────────────────────────────────────────────────────────

function NewSourceForm({
  channels,
  onDone,
  origin,
}: {
  channels: CatalogueChannel[];
  onDone: () => void;
  origin: string;
}) {
  // Only the channels with an endpoint or a connect flow are offered. `api` is
  // real but is set up on the API-keys page, and offering it here would send
  // somebody to create a source that does nothing.
  const offered = channels.filter((c) => c.delivery === "browser" || c.delivery === "webhook");
  const [kind, setKind] = useState<LeadSourceKind>(offered[0]?.id ?? "web_form");
  const [provider, setProvider] = useState("generic");
  const [name, setName] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [created, setCreated] = useState<{ url: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const channel = channels.find((c) => c.id === kind);
  const providers = channel?.providers ?? [];

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await createLeadSourceAction({
        kind,
        name: name.trim(),
        provider,
        signingSecret: signingSecret.trim() || null,
        config: kind === "web_form" ? { honeypotField: "_hp" } : {},
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      setCreated({
        url: result.data?.endpointPath ? `${origin}/v1${result.data.endpointPath}` : null,
      });
    });
  };

  if (created) {
    return (
      <Card>
        <MonoLabel>Source created</MonoLabel>
        <p className="mt-2 text-sm text-text-muted">
          {created.url
            ? "Its endpoint and copy-paste snippet are on the card below."
            : "This channel is connected from its own panel rather than a URL."}
        </p>
        <Button type="button" className="mt-3" onClick={onDone}>
          Done
        </Button>
      </Card>
    );
  }

  return (
    <Card>
      <MonoLabel>New lead source</MonoLabel>
      {error ? (
        <p role="alert" className="mt-3 rounded-md border border-danger bg-danger-subtle p-3 text-sm text-danger-text">
          {error}
        </p>
      ) : null}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <FormField label="Channel" name="kind" hint={channel?.blurb}>
          <Select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as LeadSourceKind);
              setProvider("generic");
            }}
          >
            {offered.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField
          label="Provider"
          name="provider"
          hint={providers.find((p) => p.id === provider)?.blurb}
        >
          <Select value={provider} onChange={(e) => setProvider(e.target.value)}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField
          label="Name"
          name="name"
          required
          hint="What you'll recognise it by on the board - 'Homepage form', 'Exotel main line'."
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </FormField>

        {providers.find((p) => p.id === provider)?.signature !== "none" ? (
          <FormField
            label="Signing secret"
            name="signingSecret"
            hint="Optional. Your provider's signing key or auth token - every payload is then verified against it."
          >
            <Input
              type="password"
              value={signingSecret}
              onChange={(e) => setSigningSecret(e.target.value)}
              maxLength={400}
            />
          </FormField>
        ) : null}
      </div>

      <div className="mt-4 flex gap-2">
        <Button type="button" loading={pending} disabled={!name.trim()} onClick={submit}>
          Create source
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

// ── LinkedIn ──────────────────────────────────────────────────────────────

/**
 * LinkedIn gets its own panel rather than a row in the list, because it is the
 * one channel with nothing to paste: there is no lead webhook in the Marketing
 * API, so leads are polled from a connected ad account.
 */
function LinkedInPanel({ status }: { status: LinkedInStatus }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const connect = () => {
    setError(null);
    startTransition(async () => {
      const result = await startLinkedInConnectAction();
      if ("notConfigured" in result) {
        setError("LinkedIn isn't set up on this deployment yet - ask your platform admin.");
        return;
      }
      const failure = startOAuthRedirect(
        result.data ?? { error: result.error },
        "Could not start LinkedIn sign-in",
      );
      if (failure) setError(failure);
    });
  };

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-text">LinkedIn Lead Gen Forms</h3>
          <p className="mt-1 max-w-xl text-sm text-text-muted">
            LinkedIn has no lead webhook, so Aura checks your ad account for new form responses
            every few minutes rather than receiving them instantly.
          </p>
        </div>
        {status.configured ? (
          <Button type="button" loading={pending} onClick={connect}>
            Connect LinkedIn
          </Button>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mt-3 rounded-md border border-danger bg-danger-subtle p-3 text-sm text-danger-text">
          {error}
        </p>
      ) : null}

      {!status.configured ? (
        <p className="mt-3 rounded-md border border-border bg-surface-hover p-3 text-sm text-text-muted">
          {/* Honest about WHY rather than showing a button that fails: Lead Sync
              access needs a LinkedIn app your operator has to get approved. */}
          Not available on this deployment yet. Connecting LinkedIn needs an approved LinkedIn
          Marketing Developer Platform app, which your platform admin registers once for
          everyone. Everything else on this page works without it.
        </p>
      ) : null}

      {status.connections.length > 0 ? (
        <Table caption="Connected LinkedIn ad accounts" className="mt-4">
          <TableHead>
            <TableRow>
              <TableHeaderCell>Ad account</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Last checked</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {status.connections.map((connection) => (
              <TableRow key={connection.id}>
                <TableCell>
                  {connection.account_name ??
                    (connection.account_urn.startsWith("pending:")
                      ? "Connected - pick an ad account"
                      : connection.account_urn)}
                </TableCell>
                <TableCell>
                  <StatusChip tone={connection.status === "active" ? "solid" : "danger"}>
                    {connection.status}
                  </StatusChip>
                </TableCell>
                <TableCell>
                  {connection.last_synced_at
                    ? new Date(connection.last_synced_at).toLocaleString()
                    : "not yet"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </Card>
  );
}
