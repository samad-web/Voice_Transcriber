"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  ErrorBanner,
  FormField,
  Input,
  RowHint,
  StatusChip,
  useAlert,
  useConfirm,
  useToast,
} from "@aura/ui";
import {
  disconnectPersonalWhatsAppAction,
  personalWhatsAppStatusAction,
  pollPersonalWhatsAppAction,
  startPersonalWhatsAppAction,
  type PersonalWhatsAppPairing,
  type PersonalWhatsAppStatus,
} from "./actions";

/**
 * Linking an ordinary WhatsApp number, without leaving the console.
 *
 * ── WHY A PAIRING CODE AND NOT A QR BY DEFAULT ──────────────────────────────
 *
 * Both are offered; the code leads. The people doing this are at a desk with
 * their phone next to them, and a QR asks them to hold a phone camera up to a
 * monitor - which fails on a second monitor, on a laptop turned away, and for
 * anyone who has to fetch their glasses. Eight characters typed into
 * WhatsApp → Linked devices works in every one of those cases.
 *
 * ── WHY IT POLLS ────────────────────────────────────────────────────────────
 *
 * Pairing finishes on the PHONE, and nothing in this browser hears about it.
 * The alternative to polling is a socket held open per attempt for a flow that
 * lasts well under a minute. The API also records Evolution's `CONNECTION`
 * webhook, so there is a durable trail of when a number linked or dropped -
 * this is just what lets the screen in front of somebody move on.
 *
 * The poll stops on success, on dialog close, and after a hard ceiling. A
 * pairing screen that polls forever because somebody wandered off is a request
 * every three seconds against the relay until the tab is closed.
 */

/** Long enough for somebody to find the phone and type; short enough to stop. */
const POLL_MS = 3000;
const POLL_CEILING = 100; // ~5 minutes

export function PersonalWhatsAppPanel({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<PersonalWhatsAppStatus | null>(null);
  const [open, setOpen] = useState(false);
  const alert = useAlert();
  const confirm = useConfirm();
  const toast = useToast();

  const load = useCallback(async () => {
    setStatus(await personalWhatsAppStatusAction());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Nothing is known yet. Deliberately renders nothing rather than a disabled
  // button that might be about to become enabled - a control that flickers
  // between states on load reads as broken.
  if (!status) return null;

  if (!status.available) {
    return (
      <RowHint kind="blocked">
        This deployment has no WhatsApp relay configured, so a personal number cannot be linked
        here. Your provider sets EVOLUTION_BASE_URL and EVOLUTION_ADMIN_API_KEY.
      </RowHint>
    );
  }

  if (status.connected) {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone="solid">Linked</StatusChip>
          <span className="font-mono text-xs text-text-muted">{status.number}</span>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void (async () => {
            const ok = await confirm({
              title: "Unlink this WhatsApp number?",
              body: "Messages will stop arriving in the inbox and you will not be able to reply from Aura. The conversations already here are kept. You can link it again at any time.",
              tone: "danger",
              confirmLabel: "Unlink",
              // Destructive but recoverable, which is exactly the case the
              // confirm dialog's own docblock names for opting out: nothing is
              // deleted, the correspondence stays, and re-linking is two
              // clicks. Making somebody type CONFIRM here is the friction that
              // teaches people to type it without reading.
              requireTyped: false,
            });
            if (!ok) return;
            const res = await disconnectPersonalWhatsAppAction();
            if (res.error) {
              await alert({ title: "Couldn't unlink it", body: res.error, tone: "danger" });
              return;
            }
            toast("WhatsApp unlinked");
            await load();
            onChanged();
          })()}
        >
          Unlink
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-2">
        {/* The number is not linked, and if we know WHY that is worth saying -
            "no longer linked" is a different situation from "never linked",
            and only one of them means somebody unlinked it on the phone. */}
        {status.number ? (
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip tone="outline">Not linked</StatusChip>
            <span className="font-mono text-xs text-text-muted">{status.number}</span>
          </div>
        ) : null}
        {status.detail ? <p className="text-xs text-text-muted">{status.detail}</p> : null}
        <Button variant="secondary" onClick={() => setOpen(true)}>
          {status.number ? "Link it again" : "Link a personal number"}
        </Button>
      </div>

      <PairDialog
        open={open}
        onClose={() => setOpen(false)}
        onLinked={() => {
          setOpen(false);
          void load();
          onChanged();
        }}
      />
    </>
  );
}

function PairDialog({
  open,
  onClose,
  onLinked,
}: {
  open: boolean;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [phone, setPhone] = useState("");
  const [method, setMethod] = useState<"code" | "qr">("code");
  const [pairing, setPairing] = useState<PersonalWhatsAppPairing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useToast();

  const stopPolling = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  // The kit's <Dialog> never unmounts its children, so without this a second
  // attempt opens showing the last attempt's code - which somebody would type
  // in, and it would not work. Same trap the two dialogs next door document.
  useEffect(() => {
    if (!open) {
      stopPolling();
      return;
    }
    setPhone("");
    setMethod("code");
    setPairing(null);
    setError(null);
    setBusy(false);
  }, [open, stopPolling]);

  // Stop polling if this unmounts mid-flight - otherwise the callback fires
  // against a dead component and, worse, keeps hitting the relay.
  useEffect(() => stopPolling, [stopPolling]);

  const beginPolling = useCallback(() => {
    let attempts = 0;
    const tick = async () => {
      attempts += 1;
      const res = await pollPersonalWhatsAppAction();
      if (res.connected) {
        stopPolling();
        toast("WhatsApp linked");
        onLinked();
        return;
      }
      if (attempts >= POLL_CEILING) {
        stopPolling();
        setError("This pairing attempt timed out. Close this and try again.");
        return;
      }
      timer.current = setTimeout(() => void tick(), POLL_MS);
    };
    timer.current = setTimeout(() => void tick(), POLL_MS);
  }, [onLinked, stopPolling, toast]);

  const start = async () => {
    setBusy(true);
    setError(null);
    const res = await startPersonalWhatsAppAction({ phone, method });
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setPairing(res.pairing ?? null);
    beginPolling();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Link your WhatsApp number"
      footer={
        <Button variant="secondary" onClick={onClose}>
          {pairing ? "Done" : "Cancel"}
        </Button>
      }
    >
      <div className="space-y-3">
        {error ? <ErrorBanner>{error}</ErrorBanner> : null}

        {pairing ? (
          <PairingInstructions pairing={pairing} method={method} />
        ) : (
          <>
            <FormField
              label="WhatsApp number"
              name="phone"
              required
              hint="The number on the phone you are about to link, with the country code."
            >
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="919789961631"
              />
            </FormField>

            <FormField label="How would you like to link it" name="method">
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={method === "code" ? "primary" : "secondary"}
                  size="sm"
                  onClick={() => setMethod("code")}
                >
                  Pairing code
                </Button>
                <Button
                  type="button"
                  variant={method === "qr" ? "primary" : "secondary"}
                  size="sm"
                  onClick={() => setMethod("qr")}
                >
                  QR code
                </Button>
              </div>
            </FormField>

            {/*
              Stated before they commit, not after. This is an unofficial route
              to WhatsApp - it is how WhatsApp Web works, driven from a server -
              and Meta can rate-limit or ban an account for traffic that looks
              like bulk messaging. Somebody linking their own phone is entitled
              to know that before they do it, not in a help article afterwards.
            */}
            <RowHint kind="blocked">
              This links your account the same way WhatsApp Web does, which Meta does not
              officially support. Use it to reply to people who messaged you first. Sending
              unsolicited messages in bulk from a personal number risks it being banned, and there
              is no appeal if that happens.
            </RowHint>

            <Button onClick={() => void start()} loading={busy} disabled={!phone.trim()}>
              Continue
            </Button>
          </>
        )}
      </div>
    </Dialog>
  );
}

function PairingInstructions({
  pairing,
  method,
}: {
  pairing: PersonalWhatsAppPairing;
  method: "code" | "qr";
}) {
  return (
    <div className="space-y-3">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-text-muted">
        <li>Open WhatsApp on your phone.</li>
        <li>
          Go to <span className="text-text">Settings → Linked devices</span>.
        </li>
        <li>
          Tap <span className="text-text">Link a device</span>
          {method === "code" ? ", then “Link with phone number instead”." : " and scan this code."}
        </li>
      </ol>

      {method === "code" && pairing.pairingCode ? (
        <div className="rounded-md border border-border bg-bg-subtle p-4 text-center">
          {/* Tracking-wide and large: this is read off a screen and typed into
              a phone, character by character, usually by somebody holding the
              phone in the other hand. */}
          <p className="font-mono text-2xl tracking-[0.3em] text-text">{pairing.pairingCode}</p>
          <p className="mt-2 text-xs text-text-muted">Enter this in WhatsApp on your phone.</p>
        </div>
      ) : null}

      {method === "qr" && pairing.qrImage ? (
        <div className="flex justify-center rounded-md border border-border bg-white p-4">
          {/* Always on white, whatever the console theme. A QR inverted by a
              dark background does not scan.

              A plain <img>, not next/image: the source is a `data:` URI minted
              per pairing attempt, so there is nothing for the image optimiser
              to fetch, cache or resize. */}
          <img src={pairing.qrImage} alt="WhatsApp pairing QR code" className="h-56 w-56" />
        </div>
      ) : null}

      {method === "qr" && !pairing.qrImage && pairing.qrCode ? (
        <div className="rounded-md border border-border bg-bg-subtle p-3">
          <p className="font-mono text-xs break-all text-text-muted">{pairing.qrCode}</p>
        </div>
      ) : null}

      <RowHint kind="action">
        Waiting for your phone. This page will update by itself once the link is confirmed — it
        usually takes a few seconds.
      </RowHint>
    </div>
  );
}
