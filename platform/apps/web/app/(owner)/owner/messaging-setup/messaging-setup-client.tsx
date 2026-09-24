"use client";

import { useEffect, useState, useTransition } from "react";
import { useServerState } from "@/lib/use-server-state";
import Link from "next/link";
import {
  Button,
  Card,
  Dialog,
  FormField,
  Input,
  MonoLabel,
  StatusChip,
  buttonClasses,
  buttonStyle,
  useAlert,
} from "@aura/ui";
import { providerSpec, readChannel } from "@aura/shared";
import { Time } from "@/components/org-time";
import { PhoneInput, usePhoneCheck } from "@/components/phone-input";
import { MetaWebhookDetails } from "./meta-webhook-details";
import { WasiWebhookDetails } from "./wasi-webhook-details";

/** The store's connect route for an app, remembering that the person came from here. */
const storeDoor = (app: string) =>
  `/owner/integrations/${app}/connect?from=${encodeURIComponent("/owner/messaging-setup")}`;
import {
  createWasiChannelAction,
  listChannelsAction,
  setChannelStatusAction,
  setForwardSecretAction,
  verifyChannelAction,
  type MessagingChannel,
} from "./actions";

/**
 * WhatsApp-via-Wasi setup (Kailash gap Milestone 3). Aura is a Hub API
 * client of Wasi (the user's own WhatsApp Business Solution Provider) -
 * this page never talks to Meta directly, and there is no Embedded Signup
 * here: that already happened on Wasi's side for this org's WABA.
 */
export function MessagingSetup({ initial }: { initial: MessagingChannel[] }) {
  const [pending, start] = useTransition();
  const [channels, setChannels] = useServerState(initial, pending);
  const [secretDialogFor, setSecretDialogFor] = useState<string | null>(null);
  const alert = useAlert();

  function refresh() {
    start(async () => {
      const res = await listChannelsAction();
      if (res.channels) setChannels(res.channels);
    });
  }

  return (
    <div className="space-y-4">
      {/*
        ── THE SPLIT IS BY ACCOUNT KIND, NOT BY VENDOR ───────────────────────

        This card used to offer "Connect through Meta" beside "Connect WhatsApp
        via Wasi" and describe the SECOND as the ordinary-number option that
        "needs no Meta approval and has no templates". Both halves of that were
        false: Wasi is a Business Solution Provider, so a number connected
        through it IS a WhatsApp Business Account, with Embedded Signup,
        approved templates and the 24-hour window. Anyone who wanted to use
        their own phone picked that button and was routed into a business flow
        that could never accept them.

        So the question the page asks first is now which KIND of account this
        is, and the vendors sit underneath the answer.
      */}
      <Card>
        <MonoLabel>{channels.length === 0 ? "No channel yet" : "Add a channel"}</MonoLabel>

        <div className="mt-3 space-y-4">
          <div>
            <p className="text-sm font-medium text-text">A business number</p>
            <p className="mt-1 max-w-prose text-sm leading-relaxed text-text-muted">
              Your verified WhatsApp Business number, through Meta — directly, or resold by Wasi.
              Both give you approved templates, and both are bound by Meta&rsquo;s 24-hour reply
              window. Instagram and Facebook Messenger connect here too.
            </p>
            {/* Doors, not forms (doc 28 §15): connecting happens in the
                Integrations store's connect flow, which hosts the same forms
                these buttons used to open, and brings the person back here
                when they press Done. */}
            <div className="mt-2 flex flex-wrap gap-2">
              <Link href={storeDoor("whatsapp_waba")} className={buttonClasses()} style={buttonStyle()}>
                Connect a WhatsApp number
              </Link>
              <Link href={storeDoor("instagram")} className={buttonClasses({ variant: "secondary" })}>
                Instagram
              </Link>
              <Link href={storeDoor("facebook_messenger")} className={buttonClasses({ variant: "secondary" })}>
                Messenger
              </Link>
            </div>
          </div>

          {/* Personal numbers moved to the inbox (0125): each person links their
              own, and its chats are private to them - so an organisation-wide
              control here would be the wrong owner for the thing. Kept as a
              pointer rather than removed, because this is where people were
              told to look. */}
          <div className="border-t border-border pt-4">
            <p className="text-sm font-medium text-text">Personal WhatsApp numbers</p>
            <p className="mt-1 max-w-prose text-sm leading-relaxed text-text-muted">
              Each person links their own WhatsApp number from{" "}
              <span className="font-medium text-text">Inbox → My WhatsApp</span>, without needing
              anyone&rsquo;s approval. Chats on a personal number are visible only to that person.
            </p>
          </div>
        </div>
      </Card>

      {channels.length === 0 ? null : (
        channels.map((c) => {
          /*
           * The chip used to print `c.status`, which is an operator switch with
           * two values and was being read as health. A channel with a typo'd
           * key and one whose forward secret was never entered both said
           * "active"; neither could carry a message. `readChannel` answers the
           * question the chip was pretending to answer, and answers the send
           * half and the receive half separately, because they fail separately.
           */
          const reading = readChannel({
            provider: c.provider,
            status: c.status,
            hasApiKey: c.has_api_key,
            hasForwardSecret: c.has_forward_secret,
            lastProbeAt: c.last_probe_at,
            lastProbeOutcome: c.last_probe_outcome,
            lastProbeDetail: c.last_probe_detail,
            lastInboundAt: c.last_inbound_at,
          });
          return (
          <Card key={c.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-text">
                  {c.display_name ?? c.inbound_address}
                </p>
                {/* The provider's LABEL, not the stored enum, and the kind of
                    account beside it. "via wasi" told an owner nothing about
                    whether the thing they were looking at was their business
                    number or their own phone - which is the first question
                    anybody has on this page. */}
                <p className="mt-0.5 text-xs text-text-muted">
                  {c.inbound_address} · {providerSpec(c.provider)?.label ?? c.provider}
                </p>
              </div>
              <StatusChip tone={reading.tone}>{reading.label}</StatusChip>
            </div>

            <div className="mt-2 space-y-1">
              <p className="text-sm text-text-muted">{reading.detail}</p>
              {/*
                The provider's own words, kept out of the sentence above and
                shown only when there are any. "Could not connect" does not tell
                whoever has to fix this whether the key is wrong or the host is
                down, and that detail is the whole of the fix.
              */}
              {c.last_probe_detail ? (
                <p className="font-mono text-xs break-all text-text-muted">{c.last_probe_detail}</p>
              ) : null}
              <p className="text-xs text-text-muted">
                {c.last_probe_at ? (
                  <>
                    Last checked <Time iso={c.last_probe_at} mode="datetime" />
                  </>
                ) : (
                  "Never checked against the provider."
                )}
              </p>
            </div>

            {/*
              Wasi ONLY. This block was rendered on every channel, so a Meta
              channel and a personal number both displayed instructions to go
              and paste a URL into "Wasi's admin panel" and enter a forward
              secret - a panel their owner has no account for, for a secret
              that does not exist. A personal number's webhook is registered by
              Aura at pairing time and needs nothing from anybody; Meta's is
              entered on the Meta app dashboard with the verify token the
              connect dialog already showed.
            */}
            {c.provider === "wasi" ? (
              <WasiWebhookDetails
                path={c.webhook_path}
                hasForwardSecret={c.has_forward_secret}
                onEnterSecret={() => setSecretDialogFor(c.id)}
              />
            ) : c.provider === "waba" || c.provider === "meta" ? (
              // Meta's half: the connect form promised this URL "on the channel
              // once it is created", and nothing drew it (doc 28 §16, 6a).
              // messaging-webhook.controller.ts answers Meta's one-time check
              // at this path with the channel's own verify token.
              <MetaWebhookDetails
                path={c.webhook_path}
                verifyToken={(c.config as { verifyToken?: string } | null)?.verifyToken ?? null}
              />
            ) : null}

            <div className="mt-3 flex flex-wrap gap-2">
              {/*
                Proving the credentials is a BUTTON and not something `create`
                does, for the reason the API's verify handler states: a probe
                failure at save time throws away five hand-copied values over a
                condition that is often temporary, and a forward secret that
                does not exist yet is the NORMAL order of operations.
              */}
              {/*
                Only where there is something to ask. Meta's APIs have no probe
                Aura can run without sending a message, and the verify route now
                says so rather than recording an error - so offering the button
                here would be a control whose only outcome is "nothing changed".
              */}
              {providerSpec(c.provider)?.probe !== "none" ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const res = await verifyChannelAction(c.id);
                      // Only an unreachable Aura API is an error here. A refused
                      // key is the answer, and it belongs on the card - putting
                      // it in a modal would hide the finding behind an "error".
                      if (res.error) {
                        await alert({
                          title: "Couldn't run the check",
                          body: res.error,
                          tone: "danger",
                        });
                        return;
                      }
                      refresh();
                    })
                  }
                >
                  {pending ? "Checking…" : "Check this number"}
                </Button>
              ) : null}
              <Button
                variant="secondary"
                size="sm"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const res = await setChannelStatusAction(
                      c.id,
                      c.status === "active" ? "disabled" : "active",
                    );
                    if (res.error) {
                      await alert({
                        title: "Couldn't change the channel status",
                        body: res.error,
                        tone: "danger",
                      });
                      return;
                    }
                    refresh();
                  })
                }
              >
                {c.status === "active" ? "Disable" : "Re-enable"}
              </Button>
            </div>
          </Card>
          );
        })
      )}

      <SecretDialog
        channelId={secretDialogFor}
        onClose={() => setSecretDialogFor(null)}
        onSaved={() => {
          setSecretDialogFor(null);
          refresh();
        }}
      />
    </div>
  );
}

/** The Wasi channel form. Opened by the Integrations store's WhatsApp connect step. */
export function CreateDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [inboundAddress, setInboundAddress] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [wasiClientId, setWasiClientId] = useState("");
  const [pending, start] = useTransition();
  const alert = useAlert();
  // The business number the channel receives on: required, valid for its country.
  const numberOk = usePhoneCheck()(inboundAddress, { required: true }).ok;

  // The kit's <Dialog> only toggles the underlying <dialog> element and never
  // unmounts its children, so without this a cancelled (or completed) attempt
  // leaves its field values showing the next time the dialog opens - for a
  // different channel, or just a second try.
  useEffect(() => {
    if (!open) return;
    setInboundAddress("");
    setDisplayName("");
    setApiKey("");
    setApiBaseUrl("");
    setWasiClientId("");
  }, [open]);

  function submit() {
    if (!numberOk) return;
    start(async () => {
      const res = await createWasiChannelAction({
        inboundAddress,
        displayName,
        apiKey,
        apiBaseUrl,
        wasiClientId,
      });
      if (res.error) {
        await alert({
          title: "Couldn't connect WhatsApp",
          body: res.error,
          tone: "danger",
        });
        return;
      }
      onCreated();
    });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Connect WhatsApp via Wasi"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !numberOk}>
            {pending ? "Connecting…" : "Connect"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField label="WhatsApp number" name="inboundAddress" required>
          <PhoneInput value={inboundAddress} onChange={(value) => setInboundAddress(value)} />
        </FormField>
        <FormField label="Display name" name="displayName">
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </FormField>
        <FormField label="Wasi host URL" name="apiBaseUrl" required>
          <Input
            value={apiBaseUrl}
            onChange={(e) => setApiBaseUrl(e.target.value)}
            placeholder="https://wasi.example.com"
          />
        </FormField>
        <FormField label="Wasi client id" name="wasiClientId" required>
          <Input value={wasiClientId} onChange={(e) => setWasiClientId(e.target.value)} />
        </FormField>
        <FormField label="Hub API key" name="apiKey" required hint="Shown once, from Wasi's admin panel.">
          <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </FormField>
      </div>
    </Dialog>
  );
}

/** Wasi's forward secret, entered after the channel exists. Also used by the store's check step. */
export function SecretDialog({
  channelId,
  onClose,
  onSaved,
}: {
  channelId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [secret, setSecret] = useState("");
  const [pending, start] = useTransition();
  const alert = useAlert();

  // Same stale-content issue as CreateDialog above - reset when opened for a
  // (possibly different) channel, not just left over from the last attempt.
  useEffect(() => {
    if (channelId === null) return;
    setSecret("");
  }, [channelId]);

  return (
    <Dialog
      open={channelId !== null}
      onClose={onClose}
      title="Enter Wasi's forward secret"
      description="Shown once, after saving CRM Inbound Forwarding on this client's Wasi page."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={pending || !secret}
            onClick={() =>
              start(async () => {
                if (!channelId) return;
                const res = await setForwardSecretAction(channelId, secret);
                if (res.error) {
                  await alert({
                    title: "Couldn't save the forward secret",
                    body: res.error,
                    tone: "danger",
                  });
                  return;
                }
                setSecret("");
                onSaved();
              })
            }
          >
            {pending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField label="Forward secret" name="forwardSecret" required>
          <Input value={secret} onChange={(e) => setSecret(e.target.value)} />
        </FormField>
      </div>
    </Dialog>
  );
}
