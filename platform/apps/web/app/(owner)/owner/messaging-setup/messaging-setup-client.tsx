"use client";

import { useEffect, useState, useTransition } from "react";
import { Button, Card, Dialog, FormField, Input, MonoLabel, StatusChip, useAlert } from "@aura/ui";
import { providerSpec, readChannel } from "@aura/shared";
import { MetaChannelDialog } from "./meta-channel-dialog";
import { PersonalWhatsAppPanel } from "./personal-whatsapp-panel";
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
  const [channels, setChannels] = useState(initial);
  const [createOpen, setCreateOpen] = useState(false);
  const [metaOpen, setMetaOpen] = useState(false);
  const [secretDialogFor, setSecretDialogFor] = useState<string | null>(null);
  const [pending, start] = useTransition();
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
            <div className="mt-2 flex flex-wrap gap-2">
              <Button onClick={() => setMetaOpen(true)}>Connect through Meta</Button>
              <Button variant="secondary" onClick={() => setCreateOpen(true)}>
                Connect through Wasi
              </Button>
            </div>
          </div>

          <div className="border-t border-border pt-4">
            <p className="text-sm font-medium text-text">Your own WhatsApp number</p>
            <p className="mt-1 max-w-prose text-sm leading-relaxed text-text-muted">
              An ordinary WhatsApp account, linked the way WhatsApp Web links one — a code you type
              into your phone, or a QR you scan. No Meta approval and no waiting, but no templates
              either, and messages can only be sent while a conversation is live.
            </p>
            <div className="mt-2">
              <PersonalWhatsAppPanel onChanged={refresh} />
            </div>
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
                {c.last_probe_at
                  ? `Last checked ${new Date(c.last_probe_at).toLocaleString()}`
                  : "Never checked against the provider."}
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
              <div className="mt-3 space-y-2 rounded-md border border-border bg-surface-hover p-3 text-xs">
                <p className="font-medium text-text">Webhook URL for Wasi&rsquo;s &ldquo;CRM Inbound Forwarding&rdquo;</p>
                <p className="break-all font-mono text-text-muted">
                  {typeof window !== "undefined" ? window.location.origin : ""}
                  {c.webhook_path}
                </p>
                <p className="text-text-muted">
                  Paste this into the client&rsquo;s page in Wasi&rsquo;s admin panel (Clients → this
                  client → CRM Inbound Forwarding), tick all four events, and save. Wasi will show a
                  secret - paste it below.
                </p>
                <Button variant="secondary" size="sm" onClick={() => setSecretDialogFor(c.id)}>
                  Enter forward secret
                </Button>
              </div>
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

      <MetaChannelDialog
        open={metaOpen}
        onClose={() => setMetaOpen(false)}
        onCreated={() => {
          setMetaOpen(false);
          refresh();
        }}
      />

      <CreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          refresh();
        }}
      />
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

function CreateDialog({
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
          <Button onClick={submit} disabled={pending}>
            {pending ? "Connecting…" : "Connect"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField label="WhatsApp number" name="inboundAddress" required>
          <Input
            value={inboundAddress}
            onChange={(e) => setInboundAddress(e.target.value)}
            placeholder="919789961631"
          />
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

function SecretDialog({
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
