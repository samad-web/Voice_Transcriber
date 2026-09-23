"use client";

import { useCallback, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import QRCode from "qrcode";
import { Check, Copy, Loader2, RefreshCw, Smartphone } from "lucide-react";
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  MonoLabel,
  Select,
  StatusChip,
  Tooltip,
  useAlert,
  useConfirm,
  useToast,
} from "@aura/ui";
import { enrollmentQrPayload } from "@aura/shared";
import { Time } from "@/components/org-time";
import { useRealtime, useRealtimeStatus } from "@/components/realtime-provider";
import {
  mintPairingTokenAction,
  pairingStatusAction,
  refreshDevicesAction,
  revokeDeviceAction,
  type DeviceHealth,
  type DeviceStaleness,
  type DevicesResponse,
  type OwnerDevice,
  type PairingStatus,
  type PairingToken,
} from "./actions";

/**
 * How long since the handset was heard from, in words.
 *
 * Carried over from the retired `/owner/handsets` page along with the tones
 * below, so retiring it lost nothing. "Never seen" is `outline` rather than a
 * state hue on purpose: a phone paired ten seconds ago has not checked in
 * either, and dressing that as a fault would make the first thing a new tenant
 * sees look broken.
 */
const HEALTH_LABEL: Record<DeviceStaleness, string> = {
  "<1h": "Active <1h",
  "1-24h": "Seen 1-24h ago",
  "1-7d": "Seen 1-7d ago",
  stale: "Stale 7d+",
  never: "Never seen",
};

const HEALTH_TONE = {
  "<1h": "solid",
  "1-24h": "muted",
  "1-7d": "muted",
  stale: "danger",
  never: "outline",
} as const satisfies Record<DeviceStaleness, string>;

/**
 * The client's own handsets (migration 0107).
 *
 * ── WHY THE PAIRING CODE IS BEHIND A DIALOG AND SHOWN ONCE ────────────────
 *
 * A live enrollment token lets whoever holds it put a device into this tenant.
 * It is minted on demand rather than sitting on the page, it lives ten minutes,
 * it works once, and it is never retrievable - so a screenshot of this page
 * taken tomorrow is worthless, and a code left on a shared screen expires
 * before the end of a tea break.
 *
 * ── canPair COMES FROM THE SERVER ─────────────────────────────────────────
 *
 * Not from the persona in the browser. The capability is per-person
 * (`memberships.can_pair_devices`), the API decides it from that row, and this
 * component only renders what it was told. A client that decided for itself
 * would be a second copy of the rule, and it would be the one that drifts.
 *
 * ── THE DIALOG OPENS BEFORE THE CODE EXISTS ───────────────────────────────
 *
 * The way WhatsApp's "Link a device" does: the frame appears at once with a
 * spinner where the QR will be, rather than the button sitting inert for the
 * round trip to Seoul. `attempt` is what keeps that honest - a code minted for
 * a dialog that has since been closed, or superseded by "Get a new code",
 * belongs to nobody and is dropped rather than shown.
 */
export function DevicesClient({
  data,
  health,
}: {
  data: DevicesResponse;
  /** Empty when `/v1/devices/fleet-health` did not answer - the chips are then
   *  simply absent, which is why this is a plain array and not optional. */
  health: DeviceHealth[];
}) {
  const healthByDevice = new Map(health.map((h) => [h.deviceId, h]));
  const [dialogOpen, setDialogOpen] = useState(false);
  const [token, setToken] = useState<PairingToken | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);
  const [instanceId, setInstanceId] = useState(data.instances[0]?.id ?? "");
  const [pending, startTransition] = useTransition();
  const attempt = useRef(0);
  const alert = useAlert();
  const confirm = useConfirm();

  const multiInstance = data.instances.length > 1;

  const mint = useCallback(async () => {
    const mine = ++attempt.current;
    setToken(null);
    setMintError(null);
    let result: Awaited<ReturnType<typeof mintPairingTokenAction>>;
    try {
      result = await mintPairingTokenAction(multiInstance ? instanceId : undefined);
    } catch {
      // A server action rejects outright when the web tier itself is
      // unreachable. Said in the dialog, with a retry, like any other failure.
      result = { error: "Couldn't reach the server" };
    }
    if (mine !== attempt.current) return;
    if (result.error || !result.token) {
      setMintError(result.error ?? "Pairing failed");
      return;
    }
    setToken(result.token);
  }, [multiInstance, instanceId]);

  const pair = () => {
    setDialogOpen(true);
    void mint();
  };

  const close = () => {
    attempt.current += 1;
    setDialogOpen(false);
    setToken(null);
    setMintError(null);
    // The handset may have enrolled while the dialog was open; re-read so it
    // appears in the list - and so the setup checklist re-evaluates.
    startTransition(async () => {
      await refreshDevicesAction();
    });
  };

  // The list behind the dialog, updated the moment the phone lands - without
  // waiting for the dialog to be closed, and without relying on the realtime
  // stream being up to do it.
  const paired = useCallback(() => {
    startTransition(async () => {
      await refreshDevicesAction();
    });
  }, []);

  const revoke = (device: OwnerDevice) => {
    startTransition(async () => {
      const ok = await confirm({
        title: `Retire ${device.label || "this handset"}?`,
        // Says what survives. Somebody retiring a phone is usually worried
        // they are deleting the call history that came off it.
        body: "The phone stops recording and is signed out at its next check-in. Its calls, leads and telecaller attribution all stay exactly as they are.",
        confirmLabel: "Retire handset",
        tone: "danger",
      });
      if (!ok) return;
      const result = await revokeDeviceAction(device.id);
      if (result.error) {
        await alert({ title: "Couldn't retire the handset", body: result.error, tone: "danger" });
      }
    });
  };

  return (
    <div className="mt-6 space-y-6">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <MonoLabel>Pair a handset</MonoLabel>
            <p className="mt-2 max-w-xl text-sm text-text-muted">
              {data.canPair
                ? "Install the Aura app on the phone, open its admin screen, and scan the code. Calls made on that handset start recording as soon as it checks in."
                : "You do not have permission to pair a handset. An owner can grant it to you on the Team page."}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {data.canPair && data.instances.length > 1 && (
              <Select
                name="instance"
                value={instanceId}
                disabled={pending}
                onChange={(e) => setInstanceId(e.target.value)}
              >
                {data.instances.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </Select>
            )}
            <Button onClick={pair} disabled={pending || !data.canPair}>
              Pair a handset
            </Button>
          </div>
        </div>
      </Card>

      {data.devices.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Smartphone aria-hidden className="h-6 w-6" />}
            title="No handsets yet"
            description="Until a phone is paired, there are no calls to record, transcribe or turn into leads - so the rest of the console stays empty."
            action={
              data.canPair ? (
                <Button onClick={pair} disabled={pending}>
                  Pair your first handset
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <MonoLabel>Handsets</MonoLabel>
            {/* The one number worth putting above the fold, and only when it is
                non-zero: a quiet fleet should look quiet, not wear a green
                "0 need attention" badge competing with the rows below it. */}
            {(() => {
              const attention = data.devices.filter(
                (d) => healthByDevice.get(d.id)?.needsAttention,
              ).length;
              if (attention === 0) return null;
              return (
                <span className="text-xs text-text-muted tabular-nums">
                  {attention} of {data.devices.length} need attention
                </span>
              );
            })()}
          </div>
          <ul className="mt-4 divide-y divide-border">
            {data.devices.map((device) => (
              <li key={device.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-text">
                      {device.label || "Unnamed handset"}
                    </span>
                    <StatusChip tone={device.status === "active" ? "solid" : "outline"}>
                      {device.status === "active" ? "Active" : "Retired"}
                    </StatusChip>
                    {device.telecallerName ? (
                      <StatusChip tone="muted">{device.telecallerName}</StatusChip>
                    ) : null}
                    {(() => {
                      const h = healthByDevice.get(device.id);
                      // No health row means the endpoint did not answer, not
                      // that the phone is fine - so show nothing rather than
                      // inventing reassurance.
                      if (!h) return null;
                      return (
                        <Tooltip
                          content={
                            h.needsAttention
                              ? h.attentionReasons.join(", ")
                              : "No issues reported"
                          }
                        >
                          {/* Tooltip's trigger must itself be focusable (see
                              Tooltip's own doc comment) - a bare StatusChip
                              <span> would never show these reasons to somebody
                              navigating by keyboard. */}
                          <button type="button" className="cursor-default rounded-full">
                            <StatusChip
                              tone={h.needsAttention ? "danger" : HEALTH_TONE[h.staleness]}
                            >
                              {HEALTH_LABEL[h.staleness]}
                            </StatusChip>
                          </button>
                        </Tooltip>
                      );
                    })()}
                  </div>
                  <p className="mt-0.5 text-xs text-text-muted">
                    {device.instanceName}
                    {device.appVersion ? ` · app ${device.appVersion}` : ""}
                    {device.osVersion ? ` · Android ${device.osVersion}` : ""}
                    {" · "}
                    {device.callCount} call{device.callCount === 1 ? "" : "s"}
                    {device.lastCallAt ? (
                      <>
                        {" · last "}
                        <Time iso={device.lastCallAt} mode="date" />
                      </>
                    ) : (
                      " · no calls yet"
                    )}
                  </p>
                </div>
                {data.canRevoke && device.status === "active" && (
                  <Button size="sm" variant="ghost" onClick={() => revoke(device)} disabled={pending}>
                    Retire
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <PairingDialog
        open={dialogOpen}
        token={token}
        error={mintError}
        // Named only when there is a choice to have got wrong. A tenant with
        // one instance does not need telling where the phone is going.
        instanceName={
          multiInstance
            ? data.instances.find((i) => i.id === token?.instanceId)?.name
            : undefined
        }
        onRenew={() => void mint()}
        onPaired={paired}
        onClose={close}
      />
    </div>
  );
}

// ── the pairing dialog: a QR that knows when it has been used ──────────────

/**
 * How often the dialog asks "has the phone used it yet" when it has no other
 * way to know. With the stream live the `device` signal is the fast path and
 * this is only a safety net, so it can be slow; with the stream down (a proxy
 * that eats SSE, REALTIME_DISABLED, a reconnect in progress) it is the ONLY
 * path, and slow would make the screen visibly lag the phone in someone's hand.
 *
 * Bounded either way: the code dies at ten minutes and the dialog stops asking
 * the moment the server says so.
 */
const SAFETY_POLL_MS = 10_000;
const FALLBACK_POLL_MS = 2_500;

type Phase = "minting" | "error" | "waiting" | "expired" | "paired";

function PairingDialog({
  open,
  token,
  error,
  instanceName,
  onRenew,
  onPaired,
  onClose,
}: {
  open: boolean;
  token: PairingToken | null;
  /** Minting failed. Shown in the QR's place with a retry. */
  error: string | null;
  instanceName?: string;
  /** Mint a fresh code - an expired one, a failed one, or "pair another". */
  onRenew: () => void;
  onPaired: () => void;
  onClose: () => void;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const [status, setStatus] = useState<PairingStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { status: stream } = useRealtimeStatus();

  // Which pairing the answers belong to. A ref, because an answer can arrive
  // after "Get a new code" replaced the token it was asked about - and an old
  // code's "expired" landing on a fresh QR would grey out a code that works.
  const watching = useRef<string | null>(null);
  const inFlight = useRef(false);
  const askAgain = useRef(false);
  const announced = useRef<string | null>(null);

  useEffect(() => {
    watching.current = token?.pairingId ?? null;
    setStatus(null);
    setNow(Date.now());
  }, [token]);

  useEffect(() => {
    if (!token) {
      setQr(null);
      return;
    }
    // `void` plus a rejection handler: a floating promise here would be an
    // unhandled rejection AND would leave the PREVIOUS code's QR on screen,
    // because nothing clears state that was never rewritten. Scanning a stale
    // QR pairs the phone against a dead token, which fails confusingly.
    void QRCode.toDataURL(
      // No `serverUrl`: the handset already knows where its server is, and
      // operator-issued keys omit it too. Sending one here would let a QR
      // silently repoint a phone at a different host - and it is also what
      // lets the handset activate on the scan alone, without a confirm step
      // (AdminActivationActivity.applyScannedPayload).
      enrollmentQrPayload({ instanceId: token.instanceId, adminKey: token.adminKey }),
      { margin: 1, width: 240 },
    )
      .then(setQr)
      .catch(() => setQr(null));
  }, [token]);

  /**
   * Ask the server where this pairing stands.
   *
   * One request at a time. A signal that lands while a poll is in flight is
   * not dropped - it is remembered and asked again straight after, because
   * the in-flight request may have left before the phone registered, and
   * swallowing the signal would leave the screen waiting for the next slow
   * tick with the phone already connected.
   */
  const check = useCallback(async () => {
    const id = watching.current;
    if (!id) return;
    if (inFlight.current) {
      askAgain.current = true;
      return;
    }
    inFlight.current = true;
    try {
      const res = await pairingStatusAction(id);
      // A failed tick keeps the QR up and the next tick tries again; it is
      // not a reason to tell somebody their pairing broke.
      if (res.status && watching.current === id) setStatus(res.status);
    } catch {
      // Same: one lost round trip, not a failed pairing.
    } finally {
      inFlight.current = false;
      if (askAgain.current) {
        askAgain.current = false;
        void check();
      }
    }
  }, []);

  // Watch until the SERVER settles it. A countdown reaching zero on this
  // machine's clock is not the end: the clocks can disagree, and a phone that
  // registered in the last second is paired whatever the timer says.
  const settled = status?.state === "paired" || status?.state === "expired";
  const watchingNow = open && token !== null && !settled;

  // The fast path. `register` announces a `device` change the instant the
  // phone lands (devices.controller.ts); the signal carries no content, so it
  // is a cue to ask, not the answer.
  useRealtime(["device"], () => {
    if (watchingNow) void check();
  });

  const pollEvery = stream === "live" ? SAFETY_POLL_MS : FALLBACK_POLL_MS;
  useEffect(() => {
    if (!watchingNow) return;
    const timer = setInterval(() => void check(), pollEvery);
    return () => clearInterval(timer);
  }, [watchingNow, pollEvery, check]);

  // The countdown, and the look back the moment somebody returns to the tab
  // - usually from the phone in their other hand.
  useEffect(() => {
    if (!watchingNow) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [watchingNow, check]);

  const remainingMs = token ? Math.max(0, Date.parse(token.expiresAt) - now) : 0;
  const runOut = watchingNow && remainingMs === 0;
  // Out of time here: ask the server rather than waiting out a slow tick.
  useEffect(() => {
    if (runOut) void check();
  }, [runOut, check]);

  useEffect(() => {
    if (status?.state !== "paired" || !token) return;
    if (announced.current === token.pairingId) return;
    announced.current = token.pairingId;
    onPaired();
  }, [status, token, onPaired]);

  const phase: Phase = error
    ? "error"
    : !token
      ? "minting"
      : status?.state === "paired"
        ? "paired"
        : status?.state === "expired" || remainingMs === 0
          ? "expired"
          : "waiting";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={phase === "paired" ? "Handset paired" : "Pair a handset"}
      // Not dismissable by a stray backdrop click: the code is shown once, and
      // closing by accident means minting another one.
      dismissOnBackdrop={false}
      footer={
        phase === "paired" ? (
          <>
            <Button variant="secondary" onClick={onRenew}>
              Pair another
            </Button>
            <Button onClick={onClose}>Done</Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      {phase === "paired" && status?.state === "paired" ? (
        <PairedView device={status.device} />
      ) : (
        <div className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
            <ol className="space-y-3 text-sm text-text-muted">
              <Step n={1}>Open the Aura app on the phone.</Step>
              <Step n={2}>
                Long-press the title at the top to open its{" "}
                <span className="font-medium text-text">admin screen</span>.
              </Step>
              <Step n={3}>
                Tap <span className="font-medium text-text">Scan Activation QR</span> and point
                the phone at this code. If it asks, tap{" "}
                <span className="font-medium text-text">Activate Device</span>.
              </Step>
            </ol>

            <div className="flex flex-col items-center gap-2">
              <QrPanel phase={phase} qr={qr} error={error} onRenew={onRenew} />
              <PhaseLine phase={phase} remainingMs={remainingMs} />
            </div>
          </div>

          {instanceName && phase !== "error" ? (
            <p className="text-xs text-text-muted">
              This phone will join <span className="font-medium text-text">{instanceName}</span>.
            </p>
          ) : null}

          {token && phase === "waiting" ? <ManualEntry token={token} /> : null}
        </div>
      )}
    </Dialog>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border text-xs font-medium text-text"
      >
        {n}
      </span>
      <span className="pt-0.5">{children}</span>
    </li>
  );
}

/**
 * The square the QR lives in, in all five of its states - so the layout never
 * jumps as the code appears, expires, or is replaced.
 *
 * Always on white, whatever the console theme: a QR inverted by a dark
 * background does not scan (the same rule inbox/my-whatsapp.tsx states).
 */
function QrPanel({
  phase,
  qr,
  error,
  onRenew,
}: {
  phase: Phase;
  qr: string | null;
  error: string | null;
  onRenew: () => void;
}) {
  return (
    <div className="relative flex h-52 w-52 items-center justify-center overflow-hidden rounded-md border border-border bg-white p-2">
      {qr && (phase === "waiting" || phase === "expired") ? (
        // A raw <img>, not next/image: the source is an in-memory data: URI
        // generated a few lines up, so there is nothing to fetch, cache or
        // resize.
        <img
          src={qr}
          alt="Pairing QR code for the Aura handset app"
          className={`h-full w-full transition duration-300 ${
            phase === "expired" ? "opacity-20 blur-[3px]" : ""
          }`}
        />
      ) : null}

      {phase === "minting" || (phase === "waiting" && !qr) ? (
        <Loader2 aria-label="Preparing a pairing code" className="h-8 w-8 animate-spin text-text-muted" />
      ) : null}

      {phase === "expired" ? (
        // WhatsApp's "click to reload": the dead code stays faintly visible
        // behind the button so it is obvious what is being replaced.
        <button
          type="button"
          onClick={onRenew}
          className="absolute inset-0 m-auto flex h-28 w-28 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-full bg-accent text-center text-xs font-medium text-accent-fg shadow-md transition-colors duration-150 hover:bg-accent-hover"
        >
          <RefreshCw aria-hidden className="h-5 w-5" />
          Get a new code
        </button>
      ) : null}

      {phase === "error" ? (
        <div className="flex flex-col items-center gap-3 px-3 text-center">
          {/* API messages are written to be embedded mid-sentence; standing
              alone here, the first letter wants to be a capital. */}
          <p className="text-xs text-text-muted">
            {error ? error.charAt(0).toUpperCase() + error.slice(1) : null}
          </p>
          <Button size="sm" variant="secondary" onClick={onRenew}>
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function PhaseLine({ phase, remainingMs }: { phase: Phase; remainingMs: number }) {
  const minutes = Math.floor(remainingMs / 60_000);
  const seconds = Math.floor((remainingMs % 60_000) / 1_000);
  return (
    <p className="flex min-h-5 items-center gap-2 text-xs text-text-muted">
      {phase === "waiting" ? (
        <span aria-hidden className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
        </span>
      ) : null}
      {/* The live region holds the PHASE only. The countdown sits outside it,
          or a screen reader would announce every second of it. */}
      <span aria-live="polite">
        {phase === "minting" && "Preparing a code…"}
        {phase === "waiting" && "Waiting for the phone"}
        {phase === "expired" && "This code has expired"}
      </span>
      {phase === "waiting" ? (
        <span className="tabular-nums">
          · {minutes}:{String(seconds).padStart(2, "0")}
        </span>
      ) : null}
    </p>
  );
}

/**
 * The success state that replaces the QR, the way WhatsApp swaps its code for
 * the chat list the moment the phone links.
 *
 * Neutral, not green, on purpose: green in this console means an ANSWERED
 * call (packages/ui/src/state.tsx) and console-palette.test.ts holds every
 * other surface to grey. The shape and the motion carry the success.
 */
function PairedView({
  device,
}: {
  device: { label: string | null; instanceName: string };
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    // Flipped in a plain effect, not a requestAnimationFrame: rAF is paused in
    // a background tab (and did not fire in a headless check), which left the
    // mark invisible. From an effect the worst case is that both styles land
    // in one frame - no animation, but the mark is there. The global
    // reduced-motion rule in theme.css flattens it either way.
    setShown(true);
  }, []);

  return (
    <div role="status" className="flex flex-col items-center py-4 text-center">
      <div
        className={`flex h-16 w-16 items-center justify-center rounded-full bg-text text-bg transition duration-300 ease-out ${
          shown ? "scale-100 opacity-100" : "scale-50 opacity-0"
        }`}
      >
        <Check aria-hidden className="h-8 w-8" strokeWidth={3} />
      </div>
      <p className="mt-4 text-lg font-semibold text-text">Connected</p>
      <p className="mt-1 max-w-sm text-sm text-text-muted">
        <span className="font-medium text-text">{device.label || "The handset"}</span> joined{" "}
        {device.instanceName}. It turns recording on as soon as it has fetched its settings - a
        few seconds from now.
      </p>
    </div>
  );
}

/** Typing it in instead. Tucked away: scanning is the path, this is the fallback. */
function ManualEntry({ token }: { token: PairingToken }) {
  const toast = useToast();
  const alert = useAlert();

  const copy = () => {
    // Sync, not async: an async onClick hands React a promise it discards, so a
    // rejected clipboard write would only ever surface as an unhandled
    // rejection. The code is shown once, so a failed copy has to say so.
    void navigator.clipboard
      .writeText(token.adminKey)
      .then(() => toast("Copied"))
      .catch(() =>
        alert({
          title: "Couldn't copy the code",
          body: "Select it and copy it by hand - it is not shown again.",
          tone: "danger",
        }),
      );
  };

  return (
    <details className="group rounded-md border border-border">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm text-text-muted hover:text-text">
        Can&apos;t scan? Type the code in instead
      </summary>
      <div className="space-y-3 border-t border-border px-3 py-3">
        <div className="space-y-1.5">
          <MonoLabel>Instance ID</MonoLabel>
          <div className="break-all rounded-md border border-border bg-surface-hover p-2.5 font-mono text-xs">
            {token.instanceId}
          </div>
        </div>
        <div className="space-y-1.5">
          <MonoLabel>Pairing code - shown once</MonoLabel>
          <div className="break-all rounded-md border border-border bg-surface-hover p-2.5 font-mono text-xs">
            {token.adminKey}
          </div>
          <Button size="sm" variant="secondary" onClick={copy}>
            <Copy aria-hidden className="mr-1 h-4 w-4" />
            Copy code
          </Button>
        </div>
      </div>
    </details>
  );
}
