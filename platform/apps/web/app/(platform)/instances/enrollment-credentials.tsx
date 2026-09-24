"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Copy, QrCode } from "lucide-react";
import { BrutalButton, Card, ConsolePanel, MonoLabel, StatusChip, useAlert, useToast } from "@aura/ui";
import { enrollmentQrPayload } from "@aura/shared";

export interface Credentials {
  instanceId?: string;
  instanceName?: string;
  adminKey?: string;
  expiresAt?: string;
  maxUses?: number;
}

/**
 * Copy-once enrollment credentials + the QR the Android admin screen scans.
 * The QR payload shape is a contract with the handset - do not change `v: 1`
 * field names without updating AdminActivationActivity.
 */
export function EnrollmentCredentials({
  result,
  serverUrl,
  title = "Activation Credentials - shown once",
}: {
  result: Credentials;
  serverUrl?: string;
  title?: string;
}) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const alert = useAlert();
  const toast = useToast();

  useEffect(() => {
    if (!result.instanceId || !result.adminKey) return;
    // Built by @aura/shared, not inline: the owner console mints pairing
    // tokens too (migration 0096), and two consoles with their own copy of
    // this shape is how one of them silently stops scanning.
    const payload = enrollmentQrPayload({
      instanceId: result.instanceId,
      adminKey: result.adminKey,
      serverUrl,
    });
    // `void` + a rejection handler: a floating promise here would be an
    // unhandled rejection AND would leave the previous credential's QR on
    // screen, because nothing clears state that was never rewritten. Someone
    // scanning a stale QR enrolls the handset against the wrong instance, so
    // failing back to the placeholder is the only safe outcome.
    void QRCode.toDataURL(payload, { margin: 1, width: 240 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [result.instanceId, result.adminKey, serverUrl]);

  // Sync, not `async` - see client-config/keys-manager.tsx: an async onClick hands React a
  // promise it discards, so a rejected clipboard write would only ever appear as
  // an unhandled rejection. The admin key is shown once, so a failed copy has to
  // say so rather than pass for a successful one.
  const copyKey = () => {
    const key = result.adminKey;
    if (!key) return;
    void navigator.clipboard
      .writeText(key)
      .then(() => toast("Copied"))
      .catch(() =>
        alert({
          title: "Couldn't copy the admin key",
          body: "Select it above and copy it by hand - it is not shown again.",
          tone: "danger",
        }),
      );
  };

  return (
    <Card elevated className="space-y-4">
      <div className="flex justify-between items-start gap-2">
        <div>
          <MonoLabel>{title}</MonoLabel>
          {result.instanceName ? (
            <h4 className="text-lg font-display font-black text-black uppercase tracking-tight mt-1">
              {result.instanceName}
            </h4>
          ) : null}
        </div>
        <StatusChip tone="danger">Copy now</StatusChip>
      </div>

      <div className="space-y-1.5">
        <MonoLabel>Instance ID</MonoLabel>
        <div className="bg-surface border-2 border-border-strong p-2.5 font-mono text-xs break-all">
          {result.instanceId}
        </div>
      </div>

      <div className="space-y-1.5">
        <MonoLabel>One-Time Admin Key</MonoLabel>
        <ConsolePanel lines={[result.adminKey ?? ""]} tone="log" />
        <BrutalButton variant="secondary" className="w-full" onClick={copyKey}>
          <Copy className="h-4 w-4" />
          COPY ADMIN KEY
        </BrutalButton>
      </div>

      <div className="flex items-start gap-4 pt-2 border-t-2 border-border">
        {qrDataUrl ? (
          // A raw <img>, not next/image, on purpose: the source is an in-memory
          // data: URI generated a few lines up, so there is nothing for the
          // image optimizer to fetch, cache or resize.
          <img
            src={qrDataUrl}
            alt="Enrollment QR for the Android admin screen"
            className="border-2 border-black w-32 h-32"
          />
        ) : (
          <div className="border-2 border-black w-32 h-32 flex items-center justify-center">
            <QrCode className="h-8 w-8 text-text-subtle" />
          </div>
        )}
        <div className="text-[11px] text-text-muted font-sans font-medium leading-relaxed">
          <span className="font-display font-bold uppercase text-black block mb-1 text-xs">
            On the handset
          </span>
          Open the app&apos;s hidden admin screen and scan this QR (or type both values). Expires{" "}
          {result.expiresAt ? new Date(result.expiresAt).toLocaleString() : "soon"} · max{" "}
          {result.maxUses} enrollment{(result.maxUses ?? 1) > 1 ? "s" : ""}. Recording stays
          disabled until enrollment succeeds.
        </div>
      </div>
    </Card>
  );
}
