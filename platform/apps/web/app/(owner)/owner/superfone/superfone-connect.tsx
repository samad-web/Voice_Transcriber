"use client";

import { useState, useTransition } from "react";
import { Button, Card, Input, MonoLabel, useAlert } from "@aura/ui";
import { createLeadSourceAction } from "../lead-sources/actions";

/**
 * Turning Superfone on: one button and a URL to paste.
 *
 * ── WHY IT MAKES A LEAD SOURCE RATHER THAN ITS OWN ROW ──────────────────────
 *
 * Superfone posts a call event to a webhook, which is precisely what the
 * telephony intake channel already is (migration 0078). Giving it a table of
 * its own would mean a second webhook route, a second token scheme, a second
 * events ledger and a second replay path - to receive the same shape the
 * existing one already receives, from a vendor whose field names are in the
 * catalogue next to Exotel's and Knowlarity's.
 *
 * What it gets instead is its own SECTION of the console, which is the part
 * that was actually missing: a place to look that is about Superfone rather
 * than about lead sources in general.
 */
export function SuperfoneConnect({
  origin,
  onCreated,
}: {
  origin: string;
  /**
   * Hand the new source to the caller instead of showing the URL here - the
   * Integrations store's connect flow shows it on its own check step.
   */
  onCreated?: (created: { id: string; url: string }) => void;
}) {
  const [name, setName] = useState("Superfone");
  const [created, setCreated] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const alert = useAlert();

  const connect = () => {
    startTransition(async () => {
      const result = await createLeadSourceAction({
        kind: "telephony",
        name: name.trim() || "Superfone",
        provider: "superfone",
        // Inbound only. An outbound dial is a rep doing their job, not a new
        // prospect, and turning every one into a lead fills the board with the
        // company's own activity - the reasoning `inboundOnly` carries in
        // lead-intake.ts, applied by default here because a Superfone feed
        // carries both directions and nobody would guess that mattered.
        config: { inboundOnly: true },
      });
      if (result.error || !result.data?.endpointPath) {
        await alert({
          title: "Couldn't set Superfone up",
          body: result.error ?? "No endpoint came back.",
          tone: "danger",
        });
        return;
      }
      const url = `${origin}/v1${result.data.endpointPath}`;
      if (onCreated) {
        onCreated({ id: result.data.id, url });
        return;
      }
      setCreated(url);
    });
  };

  if (created) {
    return (
      <Card className="space-y-3">
        <MonoLabel>One thing left</MonoLabel>
        <p className="max-w-prose text-sm leading-relaxed text-text-muted">
          Paste this into Superfone as your call webhook. Every call on your virtual numbers will
          then appear here, and inbound calls from numbers you do not know yet will become leads.
        </p>
        <p className="rounded-md border border-border bg-bg-subtle p-3 font-mono text-xs break-all text-text">
          {created}
        </p>
        <p className="max-w-prose text-xs leading-relaxed text-text-muted">
          The URL is the credential — anyone holding it can post call events into your account, so
          treat it like a password. You can rotate it from Lead sources if it ever leaks.
        </p>
      </Card>
    );
  }

  return (
    <Card className="space-y-3">
      <MonoLabel>Connect Superfone</MonoLabel>
      <p className="max-w-prose text-sm leading-relaxed text-text-muted">
        Superfone gives you a webhook for your call logs. Point it at Aura and every call on your
        virtual numbers lands here — who rang, on which number, who answered and what they marked
        it as. Inbound calls from people you do not have yet become leads on the board.
      </p>
      <p className="max-w-prose text-sm leading-relaxed text-text-muted">
        This is separate from the recordings your handsets upload. Superfone reports that a call
        happened; it does not give Aura the audio, so there is no transcript on these.
      </p>
      <div className="flex flex-wrap gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-56"
          aria-label="Name for this connection"
        />
        <Button type="button" onClick={connect} disabled={pending}>
          Get my webhook URL
        </Button>
      </div>
    </Card>
  );
}
