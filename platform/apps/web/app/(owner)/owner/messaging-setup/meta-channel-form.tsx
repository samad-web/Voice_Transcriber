"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { FormField, Input, Select, useAlert } from "@aura/ui";
import { createMetaChannelAction } from "./actions";

export type MetaChannelKind = "waba" | "instagram" | "facebook";

const KINDS: { value: MetaChannelKind; label: string; blurb: string }[] = [
  {
    value: "waba",
    label: "WhatsApp Business API",
    blurb: "Your verified business number, through Meta's Cloud API.",
  },
  {
    value: "instagram",
    label: "Instagram Direct",
    blurb: "DMs to your Instagram business account.",
  },
  {
    value: "facebook",
    label: "Facebook Messenger",
    blurb: "Messages to your Facebook Page.",
  },
];

/** What the sender id is CALLED, per surface. Meta names all three differently. */
const SENDER_LABEL: Record<MetaChannelKind, string> = {
  waba: "Phone number ID",
  instagram: "Instagram account ID",
  facebook: "Page ID",
};

/**
 * A token Meta echoes back once to prove the webhook is ours. From the
 * browser's CSPRNG: `Math.random` is not a source for anything that guards
 * an endpoint (doc 28 §16, 6c).
 */
function mintVerifyToken(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The form behind connecting one of Meta's three messaging surfaces
 * (migration 0098), as a hook: the fields, and a submit.
 *
 * It used to be a dialog on the Messaging page. Connecting moved into the
 * Integrations store's connect flow (doc 28 §11, §15), which draws the fields
 * inline with its own buttons under them - hence a hook, so the frame is the
 * caller's and the form is still one form.
 *
 * ── WHY ONE FORM WITH A PICKER, NOT THREE ───────────────────────────────────
 *
 * They ask for the same four things - an access token, an id that identifies
 * the sender, a display name and a verify token - and differ only in what Meta
 * calls the id. Three forms would be three copies kept in step by hand. The
 * store fixes the kind (it knows which app you opened); the dialog offers it.
 *
 * ── THE VERIFY TOKEN IS GENERATED, NOT TYPED ────────────────────────────────
 *
 * It is a value the tenant pastes into Meta once and never needs again. Asking
 * a person to invent a secret produces "test123" often enough to matter, and
 * there is no reason they should have to.
 */
export function useMetaChannelForm({
  active,
  fixedKind,
  onCreated,
}: {
  /** False → true mints a fresh token and clears the fields. */
  active: boolean;
  /** Pin the surface (the store knows which app it is connecting). */
  fixedKind?: MetaChannelKind;
  onCreated: (created: { kind: MetaChannelKind; inboundAddress: string }) => void;
}) {
  const [kind, setKind] = useState<MetaChannelKind>(fixedKind ?? "waba");
  const [inboundAddress, setInboundAddress] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [senderId, setSenderId] = useState("");
  const [businessAccountId, setBusinessAccountId] = useState("");
  const [pending, start] = useTransition();
  const alert = useAlert();

  // Minted once per activation. `useMemo` keyed on `active` rather than
  // generated in render, so it does not change under the person while they
  // are copying it into Meta.
  const verifyToken = useMemo(() => (active ? mintVerifyToken() : ""), [active]);

  // Every activation starts clean: a cancelled attempt must not leave a Meta
  // access token sitting in a field for the next person at this screen.
  useEffect(() => {
    if (!active) return;
    setKind(fixedKind ?? "waba");
    setInboundAddress("");
    setDisplayName("");
    setAccessToken("");
    setSenderId("");
    setBusinessAccountId("");
  }, [active, fixedKind]);

  const submit = () => {
    start(async () => {
      const res = await createMetaChannelAction({
        kind,
        inboundAddress,
        displayName,
        accessToken,
        senderId,
        businessAccountId: kind === "waba" ? businessAccountId : undefined,
        verifyToken,
      });
      if (res.error) {
        await alert({ title: "Couldn't connect it", body: res.error, tone: "danger" });
        return;
      }
      onCreated({ kind, inboundAddress: inboundAddress.trim() });
    });
  };

  const selected = KINDS.find((k) => k.value === kind)!;

  const fields = (
    <div className="space-y-3">
      {fixedKind ? null : (
        <FormField label="What are you connecting" name="kind" hint={selected.blurb}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as MetaChannelKind)}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </FormField>
      )}

      <FormField
        label={kind === "waba" ? "WhatsApp number" : "Account or page handle"}
        name="inboundAddress"
        required
        hint={
          kind === "waba"
            ? "The number customers message, in full international form."
            : "Just so you can tell your channels apart in the list."
        }
      >
        <Input
          value={inboundAddress}
          onChange={(e) => setInboundAddress(e.target.value)}
          placeholder={kind === "waba" ? "919789961631" : "@yourbusiness"}
        />
      </FormField>

      <FormField label="Display name" name="displayName">
        <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </FormField>

      <FormField
        label={SENDER_LABEL[kind]}
        name="senderId"
        required
        hint="From the Meta app dashboard, under the product you are connecting."
      >
        <Input value={senderId} onChange={(e) => setSenderId(e.target.value)} />
      </FormField>

      {kind === "waba" ? (
        <FormField
          label="WhatsApp Business Account ID"
          name="businessAccountId"
          hint="Optional. Needed only to read your approved templates."
        >
          <Input value={businessAccountId} onChange={(e) => setBusinessAccountId(e.target.value)} />
        </FormField>
      ) : null}

      <FormField
        label="Access token"
        name="accessToken"
        required
        hint="A permanent system-user token. Aura stores it encrypted and never shows it again."
      >
        <Input type="password" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} />
      </FormField>

      <div className="rounded-md border border-border bg-bg-subtle p-3">
        <p className="text-xs font-medium tracking-wide text-text-muted uppercase">Verify token</p>
        <p className="mt-1 font-mono text-xs break-all text-text">{verifyToken}</p>
        <p className="mt-1.5 text-xs leading-relaxed text-text-muted">
          Paste this into Meta&rsquo;s webhook setup alongside the callback URL, which Aura shows you as
          soon as the channel is created. Meta calls the URL once with this token to check the endpoint is
          yours.
        </p>
      </div>
    </div>
  );

  return {
    fields,
    submit,
    pending,
    canSubmit: !pending && Boolean(accessToken) && Boolean(senderId) && Boolean(inboundAddress.trim()),
  };
}
