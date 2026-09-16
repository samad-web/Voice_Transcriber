"use client";

import { useTransition } from "react";
import { LogOut, Trash2, X } from "lucide-react";
import { Button, RowHint, useAlert, useConfirm, useToast } from "@aura/ui";
import { logoutDeviceAction, removeDeviceAction, wipeDeviceAction } from "./actions";

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
  /** For the confirmation's title - "device a3f2…" helps nobody. */
  label: string | null;
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
        await alert({
          title: "Couldn't log the device out",
          body: res.error,
          tone: "danger",
        });
        return;
      }
      toast(`Device logout ${res.status ?? "sent"}`);
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
        await alert({
          title: "Couldn't wipe the device",
          body: res.error,
          tone: "danger",
        });
        return;
      }
      toast(`Device wipe ${res.status ?? "sent"}`);
    });
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Remove ${name} from the fleet?`,
      body: "This handset has never uploaded a call and has no leads attributed to it, so nothing is lost - but the row goes for good, and a phone still holding this enrolment would have to be enrolled again to come back.",
      confirmLabel: "Remove device",
      tone: "danger",
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await removeDeviceAction(orgId, deviceId);
      if (res.error) {
        await alert({
          // The API refuses with a 409 naming the counts when the device
          // turned out not to be unpaired after all - which is the case this
          // alert exists for, since the page's own counts can be minutes old.
          title: "Couldn't remove the device",
          body: res.error,
          tone: "danger",
        });
        return;
      }
      toast("Device removed");
    });
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={pending || disabled}
          onClick={logout}
        >
          <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
          Logout
        </Button>
        <Button
          type="button"
          variant="danger"
          size="sm"
          disabled={pending || disabled}
          onClick={() => void wipe()}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          Wipe
        </Button>
        {unpaired ? (
          // Only rendered for a device with no history. A disabled "Remove" on
          // every other row would be five hundred dead buttons explaining
          // themselves one tooltip at a time; a row that has done work simply
          // does not offer to be tidied away.
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => void remove()}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            Remove
          </Button>
        ) : null}
      </div>

      {disabled ? (
        <RowHint kind="blocked" className="justify-end text-right">
          Already wiped. The handset purges itself the next time it reaches the network; there is
          nothing further to send it.
          {unpaired
            ? " It never uploaded a call, so Remove will clear the row entirely."
            : " The row stays, because its call history hangs off it."}
        </RowHint>
      ) : (
        <RowHint kind="action" className="justify-end text-right">
          Logout stops it recording and keeps what is on it. Wipe erases the handset.
          {unpaired
            ? " Remove deletes this row - it has no calls to lose."
            : ` This one has ${callCount} call${callCount === 1 ? "" : "s"} on record, so it cannot be removed from the fleet.`}
        </RowHint>
      )}
    </div>
  );
}
