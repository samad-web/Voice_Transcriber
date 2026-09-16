"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2, TriangleAlert } from "lucide-react";
import { Button, Card, MonoLabel, RowHint, useAlert, useConfirm } from "@aura/ui";
import { deleteInstanceAction, type DeleteInstanceResult } from "./actions";

/**
 * Two-step decommission. The first click attempts the safe delete; the API
 * refuses if call history would be destroyed, and only then does the purge
 * escalation appear - so the destructive path is never the default.
 *
 * ── THE GATE MOVED INTO THE DIALOG ──────────────────────────────────────────
 *
 * This panel used to grow its own type-the-instance-name box, and it was the
 * only screen in either console that worked that way. Both steps now go
 * through `confirm({ tone: "danger" })`, which asks for the word DELETE and
 * keeps its button disabled until it is typed - the same gate, in the same
 * place, with the same wording as every other destructive action.
 *
 * Retyping the instance NAME was the weaker guard of the two, and not for the
 * reason it looks: the name is printed in the heading directly above the box,
 * so the whole confirmation could be satisfied by copying a string off the
 * screen without reading a word of what it was confirming. DELETE has to be
 * typed from memory, in caps, and it means the same thing on every dialog in
 * the product - so the habit it builds transfers. See CONFIRM_WORD.
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
  const [pending, startTransition] = useTransition();
  const confirm = useConfirm();
  const alert = useAlert();

  const blocked = result?.blockedByCalls;

  const run = (purgeCalls: boolean) =>
    startTransition(async () => {
      const res = await deleteInstanceAction(orgId, instanceId, purgeCalls);
      setResult(res);
      if (res.deleted) {
        router.refresh();
        return;
      }
      // `blockedByCalls` is NOT a failure to report - it escalates this panel
      // into the purge confirmation below, which is a state change the person
      // can see. Only a real error is an event worth a popup.
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

  const purge = async () => {
    if (!blocked) return;
    const ok = await confirm({
      title: `Delete "${instanceName}" and ${blocked.calls} call${blocked.calls === 1 ? "" : "s"}?`,
      body:
        `This instance has ${blocked.calls} call${blocked.calls === 1 ? "" : "s"} across ` +
        `${blocked.devices} device${blocked.devices === 1 ? "" : "s"}. Deleting it also erases ` +
        "those calls, their transcripts and their audio recordings. There is no backup and no undo.",
      confirmLabel: `Delete instance and ${blocked.calls} call${blocked.calls === 1 ? "" : "s"}`,
      tone: "danger",
    });
    if (ok) run(true);
  };

  if (result?.deleted) {
    return (
      <Card>
        <MonoLabel>Instance deleted</MonoLabel>
        <p className="mt-2 text-sm text-text-muted">
          Removed <span className="font-medium text-text">{result.name}</span>
          {result.purged?.length ? ` - purged ${result.purged.join(", ")}.` : "."}
        </p>
      </Card>
    );
  }

  return (
    // Neutral chrome, not a red-bordered card. Under the console's colour rule
    // (@aura/ui's state.tsx) a hue marks a STATE - and "this panel could do
    // something bad" is not a state, it is a control. The warning is carried
    // by the icon, the heading and the copy, and by the dialog that will not
    // let the action run until DELETE is typed. Colouring the whole panel
    // instead is how a console ends up with a permanent red rectangle that
    // everybody stops seeing by their second week.
    <Card className="space-y-4">
      <div className="flex items-center gap-2">
        <TriangleAlert className="h-4 w-4 text-text-muted" aria-hidden="true" />
        <h4 className="text-base font-semibold text-text">Delete instance</h4>
      </div>
      <p className="text-sm text-text-muted">
        Removes this enrollment target and every device enrolled against it. Enrolled handsets stop
        uploading immediately and must be re-enrolled with a new key.
      </p>

      {!blocked ? (
        <>
          <Button
            type="button"
            variant="danger"
            className="w-full"
            disabled={pending}
            loading={pending}
            onClick={() => void safeDelete()}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Delete instance
          </Button>
          <RowHint kind="blocked">
            You will be asked to type DELETE before this runs. If the instance still holds call
            history, the first attempt stops and tells you what would be erased.
          </RowHint>
        </>
      ) : (
        <>
          <div className="rounded-md border border-border bg-bg-subtle p-3">
            <p className="text-sm text-text">
              This instance has {blocked.calls} call{blocked.calls === 1 ? "" : "s"} across{" "}
              {blocked.devices} device{blocked.devices === 1 ? "" : "s"}.
            </p>
            <RowHint kind="blocked">
              The safe delete stopped rather than erasing them. Continuing deletes those calls,
              their transcripts and their audio recordings as well - this cannot be undone.
            </RowHint>
          </div>
          <Button
            type="button"
            variant="danger"
            className="w-full"
            disabled={pending}
            loading={pending}
            onClick={() => void purge()}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Delete instance and {blocked.calls} call{blocked.calls === 1 ? "" : "s"}
          </Button>
        </>
      )}
    </Card>
  );
}
