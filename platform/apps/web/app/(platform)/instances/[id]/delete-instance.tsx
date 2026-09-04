"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2, TriangleAlert } from "lucide-react";
import { BrutalButton, Card, MonoLabel, useAlert, useConfirm } from "@aura/ui";
import { monoInputClass as inputClass } from "@/lib/form";
import { deleteInstanceAction, type DeleteInstanceResult } from "./actions";

/**
 * Two-step decommission. The first click attempts the safe delete; the API
 * refuses if call history would be destroyed, and only then does the purge
 * confirmation appear - so the destructive path is never the default and is
 * gated behind retyping the instance name.
 */
export function DeleteInstance({
  orgId,
  instanceId,
  instanceName,
}: {
  orgId: string;
  instanceId: string;
  instanceName: string;
}) {
  const router = useRouter();
  const [result, setResult] = useState<DeleteInstanceResult | null>(null);
  const [typed, setTyped] = useState("");
  const [pending, startTransition] = useTransition();
  const confirm = useConfirm();
  const alert = useAlert();

  const blocked = result?.blockedByCalls;
  const confirmed = typed.trim() === instanceName;

  const run = (purgeCalls: boolean) =>
    startTransition(async () => {
      const res = await deleteInstanceAction(orgId, instanceId, purgeCalls);
      setResult(res);
      if (res.deleted) {
        router.refresh();
        return;
      }
      // `blockedByCalls` is NOT a failure to report - it escalates this panel
      // into the type-the-name confirmation below, which is a state change the
      // person can see. Only a real error is an event worth a popup.
      if (res.error && !res.blockedByCalls) {
        await alert({
          title: "Couldn't delete the instance",
          body: res.error,
          tone: "danger",
        });
      }
    });

  const safeDelete = async () => {
    const ok = await confirm({
      title: `Delete instance "${instanceName}"?`,
      body: "Every enrolled device is removed and will stop recording. Calls already uploaded are kept.",
      confirmLabel: "Delete instance",
      tone: "danger",
    });
    if (ok) run(false);
  };

  if (result?.deleted) {
    return (
      <Card className="border-neutral-300">
        <MonoLabel>Instance deleted</MonoLabel>
        <p className="text-xs text-neutral-600 font-sans mt-2">
          Removed <span className="font-bold">{result.name}</span>
          {result.purged?.length ? ` - purged ${result.purged.join(", ")}.` : "."}
        </p>
      </Card>
    );
  }

  return (
    <Card elevated className="space-y-4 border-red-600">
      <div className="flex items-center gap-2">
        <TriangleAlert className="h-4 w-4 text-red-600" />
        <h4 className="text-lg font-display font-black text-black uppercase tracking-tight">
          Delete Instance
        </h4>
      </div>
      <p className="text-xs text-neutral-500 font-sans font-medium">
        Removes this enrollment target and every device enrolled against it. Enrolled handsets stop
        uploading immediately and must be re-enrolled with a new key.
      </p>

      {!blocked ? (
        <BrutalButton
          variant="destructive"
          shadow
          className="w-full"
          disabled={pending}
          onClick={() => void safeDelete()}
        >
          <Trash2 className="h-4 w-4" />
          {pending ? "DELETING…" : "DELETE INSTANCE"}
        </BrutalButton>
      ) : (
        <div className="space-y-3 border-2 border-red-600 bg-red-50 p-3">
          <p className="text-xs text-red-700 font-sans font-bold">
            This instance has {blocked.calls} call{blocked.calls === 1 ? "" : "s"} across{" "}
            {blocked.devices} device{blocked.devices === 1 ? "" : "s"}. Deleting it also erases those
            calls, their transcripts and their audio recordings. This cannot be undone.
          </p>
          <div className="space-y-1.5">
            <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
              Type <span className="font-black">{instanceName}</span> to confirm
            </label>
            <input
              className={inputClass}
              placeholder={instanceName}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
          <BrutalButton
            variant="destructive"
            shadow
            className="w-full"
            disabled={pending || !confirmed}
            onClick={() => run(true)}
          >
            <Trash2 className="h-4 w-4" />
            {pending ? "PURGING…" : `DELETE INSTANCE AND ${blocked.calls} CALLS`}
          </BrutalButton>
        </div>
      )}
    </Card>
  );
}
