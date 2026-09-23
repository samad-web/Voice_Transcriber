"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { LeadSourceKind } from "@aura/shared";
import { Button, Card, MonoLabel, SyncingHint, useToast } from "@aura/ui";
import { startOAuthAction } from "../../../connections/actions";
import { listIntakeEventsAction, listSheetAccountsAction, type IntakeEvent } from "../../../lead-sources/actions";
import { NewSourceForm } from "../../../lead-sources/lead-sources-client";
import { SheetsPanel } from "../../../lead-sources/sheets-panel";
import { startOAuthRedirect } from "../../../lib/oauth-redirect";
import { SuperfoneConnect } from "../../../superfone/superfone-connect";
import { connectHref } from "../../app-links";
import { StepActions, StepHeading, StepLoading } from "../step-heading";
import type { StepProps } from "../types";

/**
 * The apps that are lead sources underneath: web forms and inboxes, cloud
 * telephony, Superfone, and Google Sheets. Each hosts the form its old page
 * used - the Lead sources create form, Superfone's one-button setup, the
 * Sheets panel - so a source made here is exactly a source made there.
 */

const FORM_KINDS: Record<string, readonly LeadSourceKind[]> = {
  web_forms: ["web_form", "email"],
  cti: ["telephony"],
};

/** Web forms & API, and cloud telephony: name it, pick the provider, get the address. */
export function WebhookSourceAuth({ spec, data, next }: StepProps) {
  return (
    <>
      <StepHeading title={spec.id === "cti" ? "Create your phone line's address" : "Create your address"}>
        {spec.id === "cti"
          ? "Pick your telephony provider and name the line. Aura gives you an address to paste into its webhook settings."
          : "Name the form or inbox. Aura gives you an address to point it at - a form's action, a forwarding rule, or anything that can POST."}
      </StepHeading>
      <div className="mt-4">
        <NewSourceForm
          bare
          channels={data.channels ?? []}
          origin={data.intakeOrigin ?? ""}
          kinds={FORM_KINDS[spec.id] ?? ["web_form"]}
          // Superfone is its own app with its own call log; the generic
          // telephony list must not offer a second way to half-connect it.
          excludeProviders={spec.id === "cti" ? ["superfone"] : []}
          onDone={() => undefined}
          onCreated={(created) => next({ pending: created.id })}
        />
      </div>
    </>
  );
}

/** Superfone: its own panel, whose one button creates the source. */
export function SuperfoneAuth({ data, next }: StepProps) {
  return <SuperfoneConnect origin={data.intakeOrigin ?? ""} onCreated={(created) => next({ pending: created.id })} />;
}

const POLL_MS = 5000;
const POLL_LIMIT = 60; // five minutes: long enough to wander off and fill a form in

const TEST_HINT: Record<string, string> = {
  web_form: "Submit your form once, as a customer would.",
  email: "Forward one enquiry email to this address.",
  api: "Send one request from your system.",
  telephony: "Ring your number once from another phone.",
};

/**
 * The address, and a live look for the first thing to arrive at it. Skippable
 * - "I'll test later" is a real answer when the form is on a site somebody
 * else deploys - but when something does arrive, the person sees exactly
 * what Aura made of it, including a rejection in its own words.
 */
export function SourceCheck({ data, params, next }: StepProps) {
  const toast = useToast();
  const source = data.sources?.find((s) => s.id === params.pending) ?? null;
  const url = source?.endpointPath ? `${data.intakeOrigin ?? ""}/v1${source.endpointPath}` : null;
  const [event, setEvent] = useState<IntakeEvent | null>(null);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    if (!source || event || tries >= POLL_LIMIT) return;
    const timer = setTimeout(() => {
      void listIntakeEventsAction(source.id).then((result) => {
        const latest = result.data?.events[0];
        if (latest) setEvent(latest);
        setTries((n) => n + 1);
      });
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [source, event, tries]);

  if (!source) return <StepLoading label="Loading your new source" />;

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast("Address copied");
    } catch {
      // Selectable on screen - that is the fallback.
    }
  };

  const arrived = event && (event.outcome === "created" || event.outcome === "updated" || event.outcome === "duplicate");

  return (
    <>
      <StepHeading title="Send a test">{TEST_HINT[source.kind] ?? "Send one test event."}</StepHeading>

      {url ? (
        <div className="mt-4 space-y-2 rounded-md border border-border bg-bg-subtle p-3">
          <p className="text-xs font-medium tracking-wide text-text-muted uppercase">Your address</p>
          <p className="font-mono text-xs break-all text-text">{url}</p>
          <p className="text-xs leading-relaxed text-text-muted">
            The address is the credential - anyone holding it can send leads into your account, so treat it
            like a password. You can replace it from Lead sources if it ever leaks.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="secondary" size="sm" onClick={() => void copy()}>
              Copy address
            </Button>
            <Link href="/owner/lead-sources" className="text-xs text-text-muted underline-offset-2 hover:text-text hover:underline">
              Setup steps and a copy-paste snippet
            </Link>
          </div>
        </div>
      ) : null}

      <div className="mt-4">
        {event ? (
          arrived ? (
            <p className="text-sm text-text">
              It works - {event.lead_title ? <>&ldquo;{event.lead_title}&rdquo; arrived</> : "an event arrived"}.
            </p>
          ) : (
            <p className="text-sm text-orange-text">
              Something arrived, but Aura turned it away{event.reason ? `: ${event.reason}` : "."}
            </p>
          )
        ) : tries >= POLL_LIMIT ? (
          <p className="text-sm text-text-muted">Nothing has arrived yet. It will be picked up whenever it does.</p>
        ) : (
          <SyncingHint>Waiting for the first event…</SyncingHint>
        )}
      </div>

      <StepActions>
        <Button type="button" variant={arrived ? "primary" : "secondary"} onClick={() => next({ pending: null })}>
          {arrived ? "Continue" : "I'll test later"}
        </Button>
      </StepActions>
    </>
  );
}

/**
 * Google Sheets reads through a Google account the PERSON connected, with the
 * spreadsheet permission. No such account → connect Google first, and come
 * straight back to this step (the sign-in's return path is this route).
 */
export function SheetsAuth({ data, next, fail }: StepProps) {
  const [accounts, setAccounts] = useState<{ id: string; account_email: string }[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void listSheetAccountsAction().then((r) => setAccounts(r.accounts));
  }, []);

  if (accounts === null) {
    return (
      <Card>
        <StepLoading label="Looking for your Google account" />
      </Card>
    );
  }

  if (accounts.length === 0) {
    const connectGoogle = async () => {
      setBusy(true);
      const result = await startOAuthAction("google", `${connectHref("google_sheets")}?step=auth`);
      const error = startOAuthRedirect(result, "Could not start the Google sign-in.");
      if (error) {
        fail(error);
        setBusy(false);
      }
    };
    return (
      <Card>
        <MonoLabel>First, connect Google</MonoLabel>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-text-muted">
          Aura reads a sheet through a Google account you connect, with permission to open spreadsheets.
          If you already connected Google for mail or calendar, connect it again - the spreadsheet
          permission is granted separately.
        </p>
        <StepActions>
          <Button type="button" loading={busy} onClick={() => void connectGoogle()}>
            Connect Google
          </Button>
        </StepActions>
      </Card>
    );
  }

  return <SheetsPanel sources={data.sources ?? []} onConnected={() => next()} />;
}
