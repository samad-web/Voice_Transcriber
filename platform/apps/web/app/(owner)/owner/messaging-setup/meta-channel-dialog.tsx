"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { Button, Dialog, FormField, Input, Select, useAlert } from "@aura/ui";
import { createMetaChannelAction } from "./actions";

type Kind = "waba" | "instagram" | "facebook";

const KINDS: { value: Kind; label: string; blurb: string }[] = [
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
const SENDER_LABEL: Record<Kind, string> = {
  waba: "Phone number ID",
  instagram: "Instagram account ID",
  facebook: "Page ID",
};

/**
 * Connect one of Meta's three messaging surfaces (migration 0098).
 *
 * ── WHY ONE DIALOG WITH A PICKER, NOT THREE BUTTONS ─────────────────────────
 *
 * They ask for the same four things - an access token, an id that identifies
 * the sender, a display name and a verify token - and differ only in what Meta
 * calls the id. Three dialogs would be three copies of one form, kept in step
 * by hand, and the first divergence would be somebody fixing a hint in one of
 * them.
 *
 * ── THE VERIFY TOKEN IS GENERATED, NOT TYPED ────────────────────────────────
 *
 * It is a value the tenant pastes into Meta once and never needs again. Asking
 * a person to invent a secret produces "test123" often enough to matter, and
 * there is no reason they should have to.
 */
export function MetaChannelDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [kind, setKind] = useState<Kind>("waba");
  const [inboundAddress, setInboundAddress] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [senderId, setSenderId] = useState("");
  const [businessAccountId, setBusinessAccountId] = useState("");
  const [pending, start] = useTransition();
  const alert = useAlert();

  // Minted once per opening of the dialog. `useMemo` keyed on `open` rather
  // than generated in render, so it does not change under the person while
  // they are copying it into Meta.
  const verifyToken = useMemo(
    () => (open ? Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) : ""),
    [open],
  );

  // The kit's <Dialog> never unmounts its children, so a cancelled attempt
  // would otherwise leave an access token sitting in the field - which is
  // worse here than for the Wasi form next door, because it is a Meta token.
  useEffect(() => {
    if (!open) return;
    setKind("waba");
    setInboundAddress("");
    setDisplayName("");
    setAccessToken("");
    setSenderId("");
    setBusinessAccountId("");
  }, [open]);

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
      onCreated();
    });
  };

  const selected = KINDS.find((k) => k.value === kind)!;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Connect Facebook, Instagram or WhatsApp Business"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !accessToken || !senderId}>
            {pending ? "Connecting…" : "Connect"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField label="What are you connecting" name="kind" hint={selected.blurb}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </FormField>

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
            <Input
              value={businessAccountId}
              onChange={(e) => setBusinessAccountId(e.target.value)}
            />
          </FormField>
        ) : null}

        <FormField
          label="Access token"
          name="accessToken"
          required
          hint="A permanent system-user token. Aura stores it encrypted and never shows it again."
        >
          <Input
            type="password"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
          />
        </FormField>

        <div className="rounded-md border border-border bg-bg-subtle p-3">
          <p className="text-xs font-medium tracking-wide text-text-muted uppercase">
            Verify token
          </p>
          <p className="mt-1 font-mono text-xs break-all text-text">{verifyToken}</p>
          <p className="mt-1.5 text-xs leading-relaxed text-text-muted">
            Paste this into Meta&rsquo;s webhook setup alongside the callback URL, which appears on
            the channel once it is created. Meta calls the URL once with this token to check the
            endpoint is yours.
          </p>
        </div>
      </div>
    </Dialog>
  );
}
