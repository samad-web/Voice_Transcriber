"use client";

import { useTransition } from "react";
import { LogOut, Trash2, X } from "lucide-react";
import { BrutalButton, useAlert, useConfirm, useToast } from "@aura/ui";
import { deleteDeviceAction, logoutDeviceAction, wipeDeviceAction } from "./actions";

export function DeviceActions({
  orgId,
  deviceId,
  label,
  status,
}: {
  orgId: string;
  deviceId: string;
  /** For the confirm dialog's copy - "Wipe device" alone reads as a template. */
  label: string;
  status: "active" | "logged_out" | "wiped" | "lost";
}) {
  const [pending, startTransition] = useTransition();
  const confirm = useConfirm();
  const alert = useAlert();
  const toast = useToast();
  const disabled = status === "wiped";

  const logout = () =>
    startTransition(async () => {
      const res = await logoutDeviceAction(orgId, deviceId);
      if (res.error) {
        await alert({ title: `Couldn't log ${label} out`, body: res.error, tone: "danger" });
        return;
      }
      toast(`${label} → ${res.status}`);
    });

  const wipe = async () => {
    const ok = await confirm({
      title: "Remote wipe this device?",
      body: "This is irreversible. Every recording, credential and enrolment on the handset is purged, and the device must be enrolled again from scratch.",
      confirmLabel: "Wipe device",
      tone: "danger",
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await wipeDeviceAction(orgId, deviceId);
      if (res.error) {
        await alert({ title: `Couldn't wipe ${label}`, body: res.error, tone: "danger" });
        return;
      }
      toast(`${label} → ${res.status}`);
    });
  };

  /**
   * Take the handset out of the fleet. The API decides which of two things
   * this actually is - the dialog copy says so up front rather than asking a
   * yes/no question whose consequence depends on data the operator cannot see
   * from this row (how many calls this device has recorded).
   *
   * On success the row simply disappears once `deleteDeviceAction`'s
   * `revalidatePath` re-fetches the (now-shorter) device list - no local
   * "deleted" message worth showing for a row that is no longer there to show
   * it under. Only a failure needs saying, and it says it in a dialog.
   */
  const remove = async () => {
    const ok = await confirm({
      title: `Remove ${label} from the fleet?`,
      body: "A handset with no recorded calls is deleted outright. One that has recorded calls is de-enrolled instead - it disappears from every fleet list and can no longer authenticate, but its call history stays intact and keeps showing up everywhere it already does.",
      confirmLabel: "Remove device",
      tone: "danger",
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await deleteDeviceAction(orgId, deviceId);
      if (res.error) {
        await alert({
          title: `Couldn't remove ${label} from the fleet`,
          body: res.error,
          tone: "danger",
        });
      }
    });
  };

  return (
    <div className="flex items-center justify-end gap-2">
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
        onClick={() => void wipe()}
      >
        <Trash2 className="h-3.5 w-3.5" />
        Wipe
      </BrutalButton>
      <BrutalButton
        variant="destructive"
        className="px-2.5 py-1.5"
        disabled={pending}
        onClick={() => void remove()}
      >
        <X className="h-3.5 w-3.5" />
        Remove
      </BrutalButton>
    </div>
  );
}
