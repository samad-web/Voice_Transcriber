"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import {
  Button,
  Dialog,
  ErrorBanner,
  FormField,
  MonoLabel,
  RowHint,
  StatusChip,
  useAlert,
  useConfirm,
  useToast,
} from "@aura/ui";
import { PhoneInput, usePhoneCheck } from "@/components/phone-input";
import {
  disconnectPersonalWhatsAppAction,
  personalWhatsAppStatusAction,
  pollPersonalWhatsAppAction,
  startPersonalWhatsAppAction,
  type PersonalWhatsAppPairing,
  type PersonalWhatsAppStatus,
} from "./my-whatsapp-actions";

/**
 * My WhatsApp - linking the signed-in person's OWN number (migration 0125).
 *
 * ── WHY IT LIVES IN THE INBOX ───────────────────────────────────────────────
 *
 * A personal number is somebody's own phone, so they link it themselves, with
 * nobody's permission, from the page where its chats will appear. It used to
 * sit on WhatsApp Setup, one per organisation, which a telecaller cannot even
 * open - so the people whose phones these are could never link them.
 *
 * ── PRIVATE, AND SAYING SO ──────────────────────────────────────────────────
 *
 * Chats that arrive on this number are visible to this person alone: not a
 * manager, not the owner. The API enforces it on every read
 * (common/private-threads.ts); this card's job is to say it plainly BEFORE
 * somebody links, because it is the thing they will want to know first.
 *
 * ── WHY A PAIRING CODE AND NOT A QR BY DEFAULT ──────────────────────────────
 *
 * Both are offered; the code leads. The person is at a desk with their phone
 * beside them, and a QR asks them to hold a camera up to a monitor - which
 * fails on a second screen and for anyone who has to fetch their glasses.
 * Eight characters typed into WhatsApp → Linked devices works everywhere.
 *
 * ── WHY IT POLLS ────────────────────────────────────────────────────────────
 *
 * Pairing finishes on the PHONE, and nothing in this browser hears about it.
 * The poll stops on success, on dialog close, and after a hard ceiling.
 */

/** Long enough for somebody to find the phone and type; short enough to stop. */
const POLL_MS = 3000;
const POLL_CEILING = 100; // ~5 minutes

export function MyWhatsApp() {
  const router = useRouter();
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

  // Nothing is known yet. Renders nothing rather than a button that might be
  // about to change - a control that flickers between states on load reads as
  // broken.
  if (!status) return null;

  if (!status.available) {
    // Plain words, no variable names: the person reading this is a telecaller,
    // and "EVOLUTION_ADMIN_API_KEY" is a sentence they cannot act on.
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
        <MonoLabel>My WhatsApp</MonoLabel>
        <span>Linking your own WhatsApp number is not available on this workspace yet.</span>
      </div>
    );
  }

  const privacy = (
    <p className="flex items-start gap-1.5 text-xs text-text-muted">
      <Lock aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        Chats on your number are visible only to you - not to your manager or the business owner.
      </span>
    </p>
  );

  if (status.connected) {
    return (
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <MonoLabel>My WhatsApp</MonoLabel>
            <StatusChip tone="solid">Linked</StatusChip>
            <span className="font-mono text-xs text-text-muted">{status.number}</span>
          </div>
          {privacy}
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            void (async () => {
              const ok = await confirm({
                title: "Unlink your WhatsApp number?",
                body: "New messages will stop arriving here and you will not be able to reply from Aura. Your existing chats stay, still visible only to you. You can link it again at any time.",
                tone: "danger",
                confirmLabel: "Unlink",
                // Reversible and nothing is deleted - the case the confirm
                // dialog's own docblock names for skipping typed confirmation.
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
              router.refresh();
            })()
          }
        >
          Unlink
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <MonoLabel>My WhatsApp</MonoLabel>
            {/* "No longer linked" is a different situation from "never
                linked", and only one of them means somebody unlinked it on
                the phone - so the number is shown when we know it. */}
            {status.number ? (
              <>
                <StatusChip tone="outline">Not linked</StatusChip>
                <span className="font-mono text-xs text-text-muted">{status.number}</span>
              </>
            ) : null}
          </div>
          <p className="text-sm text-text-muted">
            Link your own WhatsApp number to read and reply to its chats right here.
          </p>
          {privacy}
          {status.detail ? <p className="text-xs text-text-muted">{status.detail}</p> : null}
        </div>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          {status.number ? "Link it again" : "Link my WhatsApp"}
        </Button>
      </div>

      <PairDialog
        open={open}
        onClose={() => setOpen(false)}
        onLinked={() => {
          setOpen(false);
          void load();
          router.refresh();
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
  const phoneCheck = usePhoneCheck();
  // Required, and valid for its country: this is the number WhatsApp itself
  // will be asked to link, so a wrong one fails on the phone, not here.
  const phoneOk = phoneCheck(phone, { required: true }).ok;
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
  // in, and it would not work.
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
  // against a dead component and keeps hitting the relay.
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
    if (!phoneOk) return;
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
              label="Your WhatsApp number"
              name="phone"
              required
              hint="The number on the phone you are about to link."
            >
              <PhoneInput value={phone} onChange={(value) => setPhone(value)} />
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

            <RowHint kind="action">
              Chats on this number will be visible only to you. Nobody else in your team - including
              managers and the business owner - can read them.
            </RowHint>

            {/*
              Stated before they commit, not after. This is an unofficial route
              to WhatsApp - it is how WhatsApp Web works, driven from a server -
              and Meta can rate-limit or ban an account for traffic that looks
              like bulk messaging.
            */}
            <RowHint kind="blocked">
              This links your account the same way WhatsApp Web does, which Meta does not
              officially support. Use it to reply to people who messaged you first. Sending
              unsolicited messages in bulk from a personal number risks it being banned, and there
              is no appeal if that happens.
            </RowHint>

            <Button onClick={() => void start()} loading={busy} disabled={!phoneOk}>
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
          {/* Tracking-wide and large: read off a screen and typed into a
              phone, character by character, usually one-handed. */}
          <p className="font-mono text-2xl tracking-[0.3em] text-text">{pairing.pairingCode}</p>
          <p className="mt-2 text-xs text-text-muted">Enter this in WhatsApp on your phone.</p>
        </div>
      ) : null}

      {method === "qr" && pairing.qrImage ? (
        <div className="flex justify-center rounded-md border border-border bg-white p-4">
          {/* Always on white, whatever the console theme: a QR inverted by a
              dark background does not scan. A plain <img>: the source is a
              data: URI minted per attempt, nothing to fetch or resize. */}
          <img src={pairing.qrImage} alt="WhatsApp pairing QR code" className="h-56 w-56" />
        </div>
      ) : null}

      {method === "qr" && !pairing.qrImage && pairing.qrCode ? (
        <div className="rounded-md border border-border bg-bg-subtle p-3">
          <p className="break-all font-mono text-xs text-text-muted">{pairing.qrCode}</p>
        </div>
      ) : null}

      {pairing.detail ? <p className="text-xs text-text-muted">{pairing.detail}</p> : null}

      <RowHint kind="action">
        Waiting for your phone. This updates by itself once the link is confirmed - it usually
        takes a few seconds.
      </RowHint>
    </div>
  );
}
