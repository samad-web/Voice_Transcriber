"use client";

import { useEffect, useState, useTransition } from "react";
import QRCode from "qrcode";
import { Copy, QrCode, Smartphone } from "lucide-react";
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
import {
  mintPairingTokenAction,
  refreshDevicesAction,
  revokeDeviceAction,
  type DeviceHealth,
  type DeviceStaleness,
  type DevicesResponse,
  type OwnerDevice,
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
  const [token, setToken] = useState<PairingToken | null>(null);
  const [instanceId, setInstanceId] = useState(data.instances[0]?.id ?? "");
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const confirm = useConfirm();

  const pair = () => {
    startTransition(async () => {
      const result = await mintPairingTokenAction(
        data.instances.length > 1 ? instanceId : undefined,
      );
      if (result.error || !result.token) {
        await alert({
          title: "Couldn't start pairing",
          body: result.error ?? "Pairing failed",
          tone: "danger",
        });
        return;
      }
      setToken(result.token);
    });
  };

  const close = () => {
    setToken(null);
    // The handset may have enrolled while the dialog was open; re-read so it
    // appears in the list - and so the setup checklist re-evaluates.
    startTransition(async () => {
      await refreshDevicesAction();
    });
  };

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
                    {device.lastCallAt
                      ? ` · last ${new Date(device.lastCallAt).toLocaleDateString()}`
                      : " · no calls yet"}
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

      <PairingDialog token={token} onClose={close} />
    </div>
  );
}

// ── the code, shown once ────────────────────────────────────────────────────

function PairingDialog({
  token,
  onClose,
}: {
  token: PairingToken | null;
  onClose: () => void;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const toast = useToast();
  const alert = useAlert();

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
      // silently repoint a phone at a different host.
      enrollmentQrPayload({ instanceId: token.instanceId, adminKey: token.adminKey }),
      { margin: 1, width: 240 },
    )
      .then(setQr)
      .catch(() => setQr(null));
  }, [token]);

  const copy = () => {
    if (!token) return;
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
    <Dialog
      open={token !== null}
      onClose={onClose}
      title="Pair this handset"
      description="Open the Aura app's admin screen on the phone and scan this code."
      // Not dismissable by a stray backdrop click: the code is shown once, and
      // closing by accident means minting another one.
      dismissOnBackdrop={false}
      footer={<Button onClick={onClose}>Done</Button>}
    >
      {token ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-start gap-4">
            {qr ? (
              // A raw <img>, not next/image: the source is an in-memory data:
              // URI generated a few lines up, so there is nothing to fetch,
              // cache or resize.
              <img
                src={qr}
                alt="Pairing QR code for the Aura handset app"
                className="h-40 w-40 rounded-md border border-border"
              />
            ) : (
              <div className="flex h-40 w-40 items-center justify-center rounded-md border border-border">
                <QrCode aria-hidden className="h-8 w-8 text-text-muted" />
              </div>
            )}
            <div className="min-w-0 flex-1 text-sm text-text-muted">
              <p>
                Expires{" "}
                <span className="font-medium text-text">
                  {new Date(token.expiresAt).toLocaleTimeString()}
                </span>{" "}
                and works once. Recording stays off until the phone checks in.
              </p>
              <p className="mt-2">Can&apos;t scan? Type these on the handset instead.</p>
            </div>
          </div>

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
      ) : null}
    </Dialog>
  );
}
