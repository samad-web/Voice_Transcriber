"use client";

import { useEffect, useState } from "react";
import { Button, Dialog, ErrorBanner, Select, Skeleton, useAlert } from "@aura/ui";
import { LoadingRegion } from "@/components/skeletons";
import {
  bulkReassignAction,
  fetchAssigneeOptionsAction,
  type AssigneeOption,
  type BulkActionResult,
  type BulkObject,
} from "./actions";

/** The value the select uses for "nobody" - never a real uuid. */
const NOBODY = "__nobody__";

const NOBODY_LABEL: Record<BulkObject, string> = {
  contacts: "No owner",
  deals: "No owner",
  tasks: "Unassigned",
  leads: "Unassigned (back to the routing backlog)",
};

/**
 * Pick one person (or telecaller) for every selected row.
 *
 * The options load when the dialog opens, not with the page: most visits to a
 * list never reassign anything, and on this deployment a round trip is a
 * noticeable fraction of a second.
 *
 * A native <select>, like the kit's Select: type-ahead and the phone's own
 * picker for free, which matters more here than styling the options.
 */
export function ReassignDialog({
  open,
  object,
  kind,
  ids,
  noun,
  onClose,
  onDone,
}: {
  open: boolean;
  object: BulkObject;
  kind: "people" | "telecallers";
  ids: string[];
  noun: string;
  onClose: () => void;
  onDone: (result: BulkActionResult) => void;
}) {
  const alert = useAlert();
  const [options, setOptions] = useState<AssigneeOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  // Plain state, not useTransition: onDone clears the selection, and a
  // navigation-affecting update fired from inside an async transition is what
  // stalled the router (bulk-action-bar.tsx).
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open || options) return;
    let cancelled = false;
    void fetchAssigneeOptionsAction(kind).then((result) => {
      if (cancelled) return;
      if (result.error) setLoadError(result.error);
      else setOptions(result.options ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [open, options, kind]);

  useEffect(() => {
    if (!open) setTarget("");
  }, [open]);

  const count = ids.length;
  const plural = `${count} ${noun}${count === 1 ? "" : "s"}`;
  const chosen = options?.find((o) => o.id === target);

  const submit = async () => {
    if (!target || pending) return;
    setPending(true);
    const result = await bulkReassignAction(object, ids, target === NOBODY ? null : target);
    setPending(false);
    if (result.error) {
      await alert({ title: `Couldn't reassign the ${noun}s`, body: result.error, tone: "danger" });
      return;
    }
    onDone(result);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Reassign ${plural}`}
      description={
        object === "leads"
          ? "The telecaller you pick is told once, if they have a console login."
          : object === "tasks"
            ? "The person you pick is told once, not once per task."
            : "Anyone outside what you can edit is left as it is and counted as skipped."
      }
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} loading={pending} disabled={!target}>
            {target === NOBODY ? `Clear ${plural}` : chosen ? `Give ${plural} to ${chosen.label}` : "Reassign"}
          </Button>
        </>
      }
    >
      {loadError ? (
        <ErrorBanner>{loadError}</ErrorBanner>
      ) : options === null ? (
        <LoadingRegion label="Loading people" className="space-y-1.5">
          <div className="flex h-5 items-center">
            <Skeleton className="h-3.5 w-16" />
          </div>
          <Skeleton className="h-9.5 w-full rounded-sm" />
        </LoadingRegion>
      ) : (
        <>
          <label htmlFor="bulk-reassign-target" className="text-sm font-medium text-text">
            {kind === "telecallers" ? "Telecaller" : object === "tasks" ? "Assignee" : "Owner"}
          </label>
          <div className="mt-1.5">
            <Select id="bulk-reassign-target" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="" disabled>
                Choose…
              </option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.detail ? `${o.label} - ${o.detail}` : o.label}
                </option>
              ))}
              <option value={NOBODY}>{NOBODY_LABEL[object]}</option>
            </Select>
          </div>
          {options.length === 0 ? (
            <p className="mt-2 text-xs text-text-muted">
              {kind === "telecallers" ? "No active telecallers in this workspace yet." : "No teammates to choose from yet."}
            </p>
          ) : null}
        </>
      )}
    </Dialog>
  );
}
