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
  const [msg, setMsg] = useState<string | null>(null);
  const disabled = status === "wiped";

  const logout = () =>
    startTransition(async () => {
      setMsg(null);
      const res = await logoutDeviceAction(orgId, deviceId);
      setMsg(res.error ? res.error : `→ ${res.status}`);
    });

  const wipe = () =>
    startTransition(async () => {
      if (!window.confirm("Remote wipe is irreversible — purge all data on this device?")) return;
      setMsg(null);
      const res = await wipeDeviceAction(orgId, deviceId);
      setMsg(res.error ? res.error : `→ ${res.status}`);
    });

  return (
    <div className="flex items-center justify-end gap-2">
      {msg ? (
        <span className="text-[10px] font-mono font-bold uppercase text-neutral-500">{msg}</span>
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
