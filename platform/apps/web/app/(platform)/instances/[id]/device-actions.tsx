"use client";

import { useState, useTransition } from "react";
import { LogOut, Trash2 } from "lucide-react";
import { BrutalButton } from "@aura/ui";
import { logoutDeviceAction, wipeDeviceAction } from "./actions";

export function DeviceActions({
  orgId,
  deviceId,
  status,
}: {
  orgId: string;
  deviceId: string;
  status: "active" | "logged_out" | "wiped" | "lost";
}) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const disabled = status === "wiped";

  const logout = () =>
    startTransition(async () => {
      setMsg(null);
      const res = await logoutDeviceAction(orgId, deviceId);
      setMsg(res.error ? { text: res.error, error: true } : { text: `→ ${res.status}`, error: false });
    });

  const wipe = () =>
    startTransition(async () => {
      if (!window.confirm("Remote wipe is irreversible — purge all data on this device?")) return;
      setMsg(null);
      const res = await wipeDeviceAction(orgId, deviceId);
      setMsg(res.error ? { text: res.error, error: true } : { text: `→ ${res.status}`, error: false });
    });

  return (
    <div className="flex items-center justify-end gap-2">
      {msg ? (
        // aria-live: an operator watching a device list otherwise has no way
        // to learn a remote wipe failed short of staring at this exact spot.
        // The failure also needs a *distinct* colour from success — both used
        // to render in the same muted grey, which is ambiguous at a glance.
        <span
          role="status"
          aria-live="polite"
          className={`text-[10px] font-mono font-bold uppercase ${
            msg.error ? "text-danger-text" : "text-text-muted"
          }`}
        >
          {msg.text}
        </span>
      ) : null}
      <BrutalButton
        variant="secondary"
        className="px-2.5 py-1.5"
        disabled={pending || disabled}
        onClick={logout}
      >
        <LogOut className="h-3.5 w-3.5" />
        Logout
      </BrutalButton>
      <BrutalButton
        variant="destructive"
        className="px-2.5 py-1.5"
        disabled={pending || disabled}
        onClick={wipe}
      >
        <Trash2 className="h-3.5 w-3.5" />
        Wipe
      </BrutalButton>
    </div>
  );
}
