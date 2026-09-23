"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { providerSpec, readChannel } from "@aura/shared";
import { Button, Card, MonoLabel, Radio, RadioGroup, StatusChip } from "@aura/ui";
import { listChannelsAction, verifyChannelAction, type MessagingChannel } from "../../../messaging-setup/actions";
import { EmbeddedSignup } from "../../../messaging-setup/embedded-signup";
import { CreateDialog, SecretDialog } from "../../../messaging-setup/messaging-setup-client";
import { useMetaChannelForm, type MetaChannelKind } from "../../../messaging-setup/meta-channel-form";
import { MetaWebhookDetails } from "../../../messaging-setup/meta-webhook-details";
import { WasiWebhookDetails } from "../../../messaging-setup/wasi-webhook-details";
import { StepActions, StepHeading, StepLoading } from "../step-heading";
import type { StepProps } from "../types";

/**
 * WhatsApp Business, Instagram Direct and Facebook Messenger. Every form here
 * is the Messaging page's own - the Meta form (as a hook), Wasi's dialog,
 * Embedded Signup, the forward-secret dialog - hosted rather than copied
 * (doc 28 §6.2, P3), so the store and that page cannot disagree about what
 * connecting a number takes.
 */

/**
 * The channel a create just made. The create actions answer `{ ok }` without
 * the row, so it is found by what the person typed - or, for a flow that
 * types nothing (Wasi's popup, Embedded Signup), as the newest channel of
 * that kind that did not exist when the step opened.
 */
async function findCreated(
  channel: string,
  match: { inboundAddress?: string; notIn?: ReadonlySet<string> },
): Promise<MessagingChannel | null> {
  const result = await listChannelsAction();
  const rows = (result.channels ?? []).filter((c) => c.channel === channel);
  if (match.inboundAddress) {
    const wanted = match.inboundAddress.replace(/\s+/g, "");
    const hit = rows.find((c) => c.inbound_address.replace(/\s+/g, "") === wanted);
    if (hit) return hit;
  }
  const fresh = rows.filter((c) => !match.notIn?.has(c.id));
  return fresh.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null;
}

/** The ids that existed when the step opened, so "the new one" can be told apart. */
function useExistingIds(channel: string) {
  const ids = useRef<Set<string> | null>(null);
  useEffect(() => {
    void listChannelsAction().then((r) => {
      ids.current = new Set((r.channels ?? []).filter((c) => c.channel === channel).map((c) => c.id));
    });
  }, [channel]);
  return ids;
}

type Method = "facebook" | "cloud" | "wasi";

const METHODS: { value: Method; label: string; description: string }[] = [
  {
    value: "facebook",
    label: "I manage it through Facebook",
    description:
      "You - or your marketing agency - administer the number from Facebook Business Manager. You sign in with Facebook and pick the number; nothing to copy or paste.",
  },
  {
    value: "cloud",
    label: "I have a Meta app and a permanent token",
    description:
      "You run your own Meta app on WhatsApp's Cloud API and can copy a phone number ID and a system-user access token from it.",
  },
  {
    value: "wasi",
    label: "Someone set it up for me and gave me keys",
    description:
      "Your provider ran the setup and handed you a host URL, a client id and an API key. Have those in front of you.",
  },
];

/**
 * WhatsApp Business: first HOW the number is run, then the one route that
 * fits. The question the Messaging page used to ask now lives here: an owner who does not know what a Business Solution Provider
 * is cannot choose between vendors, but can say how they already use the
 * number.
 */
export function WhatsAppBusinessAuth({ data, params, next, fail }: StepProps) {
  const preset = METHODS.find((m) => m.value === params.via)?.value ?? null;
  const [method, setMethod] = useState<Method | null>(preset);
  const [wasiOpen, setWasiOpen] = useState(false);
  const [locating, setLocating] = useState(false);
  const existing = useExistingIds("whatsapp");
  const signup = data.signup;

  const moveOn = useCallback(
    async (match: { inboundAddress?: string }) => {
      setLocating(true);
      const created = await findCreated("whatsapp", { ...match, notIn: existing.current ?? undefined });
      setLocating(false);
      if (!created) {
        fail("No new number has arrived yet. Finish connecting it above, then continue.");
        return;
      }
      next({ pending: created.id, via: null });
    },
    [existing, fail, next],
  );

  const form = useMetaChannelForm({
    active: method === "cloud",
    fixedKind: "waba",
    onCreated: ({ inboundAddress }) => void moveOn({ inboundAddress }),
  });

  return (
    <>
      <StepHeading title="Connect your WhatsApp number">
        There is more than one kind of WhatsApp business account, and they connect in different ways.
      </StepHeading>
      <div className="mt-4">
        <RadioGroup legend="How do you use this number today?">
          {METHODS.map((m) => (
            <Radio
              key={m.value}
              name="whatsapp-method"
              value={m.value}
              checked={method === m.value}
              onChange={() => setMethod(m.value)}
              label={m.label}
              description={m.description}
            />
          ))}
        </RadioGroup>
      </div>

      {method === "facebook" && signup ? (
        <div className="mt-5 space-y-3 border-t border-border pt-5">
          <EmbeddedSignup config={signup} />
          {signup.ready ? (
            <StepActions>
              <Button type="button" loading={locating} onClick={() => void moveOn({})}>
                I&apos;ve finished in Facebook
              </Button>
            </StepActions>
          ) : (
            // Only true of this route, so said here rather than as a
            // page-level warning: the cost of getting it wrong is a person
            // hunting a Facebook problem that does not exist.
            <Card>
              <MonoLabel>Not available on this workspace yet</MonoLabel>
              <p className="mt-2 max-w-2xl text-sm text-text-muted">
                Signing in with Facebook needs your provider account linked here first, and it is not
                linked yet. The keys route works now, and you can switch later without disconnecting the
                number.
              </p>
              <button
                type="button"
                onClick={() => setMethod("wasi")}
                className="mt-3 text-sm font-semibold text-text underline underline-offset-4"
              >
                Use the keys my provider gave me
              </button>
            </Card>
          )}
        </div>
      ) : null}

      {method === "cloud" ? (
        <div className="mt-5 border-t border-border pt-5">
          {form.fields}
          <StepActions>
            <Button type="button" loading={form.pending || locating} disabled={!form.canSubmit} onClick={form.submit}>
              Connect the number
            </Button>
          </StepActions>
        </div>
      ) : null}

      {method === "wasi" ? (
        <div className="mt-5 border-t border-border pt-5">
          <p className="max-w-prose text-sm leading-relaxed text-text-muted">
            Three values from your provider&rsquo;s admin panel: the host URL, the client id and the API key.
            There is a fourth - a forward secret - that only appears after the number is saved, so the next
            step asks for it.
          </p>
          <StepActions>
            <Button type="button" loading={locating} onClick={() => setWasiOpen(true)}>
              Enter the keys
            </Button>
          </StepActions>
          <CreateDialog
            open={wasiOpen}
            onClose={() => setWasiOpen(false)}
            onCreated={() => {
              setWasiOpen(false);
              void moveOn({});
            }}
          />
        </div>
      ) : null}
    </>
  );
}

/** Instagram Direct and Facebook Messenger: the same Meta form, its kind fixed by the app. */
export function MetaMessagingAuth({ spec, next, fail }: StepProps) {
  const kind: MetaChannelKind = spec.id === "instagram" ? "instagram" : "facebook";
  const [locating, setLocating] = useState(false);

  const moveOn = async (inboundAddress: string) => {
    setLocating(true);
    const created = await findCreated(kind, { inboundAddress });
    setLocating(false);
    if (!created) {
      fail("The account was saved, but Aura could not find it again. Open the app page to check it.");
      return;
    }
    next({ pending: created.id });
  };

  const form = useMetaChannelForm({
    active: true,
    fixedKind: kind,
    onCreated: ({ inboundAddress }) => void moveOn(inboundAddress),
  });

  return (
    <>
      <StepHeading title={kind === "instagram" ? "Your Instagram account" : "Your Facebook Page"}>
        From the Meta app dashboard, under the product you are connecting.
      </StepHeading>
      <div className="mt-4">{form.fields}</div>
      <StepActions>
        <Button type="button" loading={form.pending || locating} disabled={!form.canSubmit} onClick={form.submit}>
          Connect
        </Button>
      </StepActions>
    </>
  );
}

/**
 * The number (or account) just made, as the Messaging page reads it - one
 * chip from `readChannel`, the provider's own words - plus the half of the
 * setup that only exists once the row does: Wasi's forward secret, Meta's
 * callback URL and verify token.
 */
export function ChannelCheck({ params, next }: StepProps) {
  const [channel, setChannel] = useState<MessagingChannel | null>(null);
  const [missing, setMissing] = useState(false);
  const [secretOpen, setSecretOpen] = useState(false);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    const result = await listChannelsAction();
    const found = (result.channels ?? []).find((c) => c.id === params.pending) ?? null;
    setChannel(found);
    setMissing(!found);
  }, [params.pending]);

  useEffect(() => {
    void load();
  }, [load]);

  if (missing) {
    return (
      <>
        <StepHeading title="That channel is not here any more">
          It may have been switched off or connected from another tab. The app page lists every channel.
        </StepHeading>
        <StepActions>
          <Button type="button" onClick={() => next({ pending: null })}>
            Continue
          </Button>
        </StepActions>
      </>
    );
  }
  if (!channel) return <StepLoading label="Loading the channel" />;

  const reading = readChannel({
    provider: channel.provider,
    status: channel.status,
    hasApiKey: channel.has_api_key,
    hasForwardSecret: channel.has_forward_secret,
    lastProbeAt: channel.last_probe_at,
    lastProbeOutcome: channel.last_probe_outcome,
    lastProbeDetail: channel.last_probe_detail,
    lastInboundAt: channel.last_inbound_at,
  });
  const canProbe = providerSpec(channel.provider)?.probe !== "none";

  const check = async () => {
    setChecking(true);
    const result = await verifyChannelAction(channel.id);
    setChecking(false);
    if (result.channel) setChannel(result.channel);
  };

  return (
    <>
      <StepHeading title={channel.display_name ? `${channel.display_name} · ${channel.inbound_address}` : channel.inbound_address}>
        {reading.detail}
      </StepHeading>
      <div className="mt-3">
        <StatusChip tone={reading.tone}>{reading.label}</StatusChip>
      </div>

      {channel.provider === "wasi" ? (
        <WasiWebhookDetails
          path={channel.webhook_path}
          hasForwardSecret={channel.has_forward_secret}
          onEnterSecret={() => setSecretOpen(true)}
        />
      ) : channel.provider === "waba" || channel.provider === "meta" ? (
        <MetaWebhookDetails
          path={channel.webhook_path}
          verifyToken={(channel.config as { verifyToken?: string } | null)?.verifyToken ?? null}
        />
      ) : null}

      <StepActions>
        {canProbe ? (
          <Button type="button" variant="secondary" loading={checking} onClick={() => void check()}>
            Check now
          </Button>
        ) : null}
        <Button type="button" onClick={() => next({ pending: null })}>
          {reading.readiness === "connected" ? "Continue" : "Finish without checking"}
        </Button>
      </StepActions>

      <SecretDialog
        channelId={secretOpen ? channel.id : null}
        onClose={() => setSecretOpen(false)}
        onSaved={() => {
          setSecretOpen(false);
          void load();
        }}
      />
    </>
  );
}
