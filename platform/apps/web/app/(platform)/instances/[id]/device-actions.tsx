"use client";

import { useTransition } from "react";
import { LogOut, Trash2, X } from "lucide-react";
import { BrutalButton, useAlert, useConfirm, useToast } from "@aura/ui";
import { deleteDeviceAction, logoutDeviceAction, wipeDeviceAction } from "./actions";

/**
 * The three things an operator can do to a handset, in increasing order of
 * consequence, and the microcopy that says which is which.
 *
 * ── WHY THE ROW EXPLAINS ITSELF ─────────────────────────────────────────────
 *
 * "Logout", "Wipe" and "Remove" are three buttons that all sound like ways of
 * getting rid of a device, and choosing wrong is expensive in both directions
 * - a wipe when you meant a logout destroys the recordings on somebody's
 * phone, and a logout when you meant a wipe leaves them there. The difference
 * cannot be inferred from three verbs, so the row says it in a sentence.
 */
export function DeviceActions({
  orgId,
  deviceId,
  label,
  status,
  callCount,
  leadCount,
}: {
  orgId: string;
  deviceId: string;
  /** For the confirm dialog's copy - "Wipe device" alone reads as a template. */
  label: string;
  status: "active" | "logged_out" | "wiped" | "lost";
  /** Calls this handset has uploaded. 0 (with no leads) = unpaired. */
  callCount: number;
  leadCount: number;
}) {
  const [pending, startTransition] = useTransition();
  const confirm = useConfirm();
  const alert = useAlert();
  const toast = useToast();
  const disabled = status === "wiped";
  const name = label?.trim() || "this device";

  /*
   * An unpaired device: enrolled, and then nothing. Removing one destroys a
   * row and no history, which is why it is offered at all - but it is still a
   * delete, and it still goes through the same type-DELETE gate as wiping a
   * handset or dropping an instance. The brief for this console is that the
   * gate is not graded by how much is being destroyed: an operator should
   * never have to work out which deletes are the serious ones, because the
   * moment some of them are cheap, the reflex generalises to all of them.
   */
  const unpaired = callCount === 0 && leadCount === 0;

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
      title: `Remote wipe ${name}?`,
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
