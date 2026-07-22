"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Check, Copy, QrCode } from "lucide-react";
import { BrutalButton, Card, MonoLabel, StatusChip } from "@aura/ui";

export interface Credentials {
  instanceId?: string;
  instanceName?: string;
  adminKey?: string;
  expiresAt?: string;
  maxUses?: number;
}

/**
 * Copy-once enrollment credentials + the QR the Android admin screen scans.
 * The QR payload shape is a contract with the handset — do not change `v: 1`
 * field names without updating AdminActivationActivity.
 */
export function EnrollmentCredentials({
  result,
  serverUrl,
  title = "Activation Credentials — shown once",
}: {
  result: Credentials;
  serverUrl?: string;
  title?: string;
}) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!result.instanceId || !result.adminKey) return;
    const payload = JSON.stringify({
      v: 1,
      instanceId: result.instanceId,
      adminKey: result.adminKey,
      ...(serverUrl?.trim() ? { serverUrl: serverUrl.trim() } : {}),
    });
    QRCode.toDataURL(payload, { margin: 1, width: 240 }).then(setQrDataUrl);
    setCopied(false);
  }, [result.instanceId, result.adminKey, serverUrl]);

  const copyKey = async () => {
    if (!result.adminKey) return;
    await navigator.clipboard.writeText(result.adminKey);
    setCopied(true);
  };

  return (
    <Card shadow className="space-y-4">
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
        <div className="bg-neutral-50 border-2 border-black p-2.5 font-mono text-xs break-all">
          {result.instanceId}
        </div>
      </div>

      <div className="space-y-1.5">
        <MonoLabel>One-Time Admin Key</MonoLabel>
        <div className="bg-black text-green-400 border-2 border-black p-2.5 font-mono text-xs break-all">
          {result.adminKey}
        </div>
        <BrutalButton variant="secondary" className="w-full" onClick={copyKey}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? "COPIED" : "COPY ADMIN KEY"}
        </BrutalButton>
      </div>

      <div className="flex items-start gap-4 pt-2 border-t-2 border-neutral-200">
        {qrDataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={qrDataUrl}
            alt="Enrollment QR for the Android admin screen"
            className="border-2 border-black w-32 h-32"
          />
        ) : (
          <div className="border-2 border-black w-32 h-32 flex items-center justify-center">
            <QrCode className="h-8 w-8 text-neutral-300" />
          </div>
        )}
        <div className="text-[11px] text-neutral-600 font-sans font-medium leading-relaxed">
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
