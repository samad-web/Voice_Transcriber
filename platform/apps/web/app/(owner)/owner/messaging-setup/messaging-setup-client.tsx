"use client";

import { useEffect, useState, useTransition } from "react";
import { Button, Card, Dialog, FormField, Input, MonoLabel, StatusChip, useAlert } from "@aura/ui";
import { MetaChannelDialog } from "./meta-channel-dialog";
import {
  createWasiChannelAction,
  listChannelsAction,
  setChannelStatusAction,
  setForwardSecretAction,
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
      {/* Two routes to WhatsApp, and the difference is worth stating rather
          than leaving somebody to work it out from two similar buttons. Meta's
          own API needs an approved business number and gives templates and a
          24-hour reply window; a BSP-relayed personal number needs neither and
          has neither. Instagram and Messenger exist only on the Meta side. */}
      <Card>
        <MonoLabel>{channels.length === 0 ? "No channel yet" : "Add a channel"}</MonoLabel>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-text-muted">
          Connect a WhatsApp Business number, an Instagram account or a Facebook Page directly
          through Meta — or relay an ordinary WhatsApp number through Wasi, which needs no Meta
          approval and has no templates.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={() => setMetaOpen(true)}>Connect through Meta</Button>
          <Button variant="secondary" onClick={() => setCreateOpen(true)}>
            Connect WhatsApp via Wasi
          </Button>
        </div>
      </Card>

      {channels.length === 0 ? null : (
        channels.map((c) => (
          <Card key={c.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-text">
                  {c.display_name ?? c.inbound_address}
                </p>
                <p className="mt-0.5 text-xs text-text-muted">
                  {c.inbound_address} · via {c.provider}
                </p>
              </div>
              <StatusChip tone={c.status === "active" ? "solid" : "muted"}>{c.status}</StatusChip>
            </div>

            <div className="mt-3 space-y-2 rounded-md border border-border bg-surface-hover p-3 text-xs">
              <p className="font-medium text-text">Webhook URL for Wasi's "CRM Inbound Forwarding"</p>
              <p className="break-all font-mono text-text-muted">
                {typeof window !== "undefined" ? window.location.origin : ""}
                {c.webhook_path}
              </p>
              <p className="text-text-muted">
                Paste this into the client's page in Wasi's admin panel (Clients → this client →
                CRM Inbound Forwarding), tick all four events, and save. Wasi will show a secret -
                paste it below.
              </p>
              <Button variant="secondary" size="sm" onClick={() => setSecretDialogFor(c.id)}>
                Enter forward secret
              </Button>
            </div>

            <div className="mt-3">
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
        ))
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
