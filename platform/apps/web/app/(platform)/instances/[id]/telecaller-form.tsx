"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, User } from "lucide-react";
import { Button, Checkbox, Input, useAlert } from "@aura/ui";
import { setDeviceTelecallerAction } from "./actions";

/**
 * Who is holding this handset - collected right here, the moment a device
 * shows up as connected, instead of only after the fact from the org's own
 * owner dashboard (which can only rename, not attach an employee/agent code).
 * Saving again on an already-assigned device edits that telecaller in place;
 * it never creates a second one for the same handset.
 */
export function TelecallerForm({
  orgId,
  deviceId,
  name,
  externalId,
}: {
  orgId: string;
  deviceId: string;
  name: string | null;
  externalId: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [nameValue, setNameValue] = useState(name ?? "");
  const [idValue, setIdValue] = useState(externalId ?? "");
  const [reassign, setReassign] = useState(false);
  const [pending, startTransition] = useTransition();
  const alert = useAlert();

  const save = () => {
    const trimmedName = nameValue.trim();
    if (!trimmedName) {
      void alert({
        title: "The telecaller needs a name",
        body: "Type the name of whoever is holding this handset.",
        tone: "danger",
      });
      return;
    }
    startTransition(async () => {
      const res = await setDeviceTelecallerAction({
        orgId,
        deviceId,
        name: trimmedName,
        externalId: idValue.trim() || null,
        reassign,
      });
      if (res.error) {
        await alert({
          title: "Couldn't save the telecaller",
          body: res.error,
          tone: "danger",
        });
        return;
      }
      setEditing(false);
      router.refresh();
    });
  };

  if (editing) {
    return (
      <div className="space-y-1.5 min-w-40">
        <Input
          autoFocus
          value={nameValue}
          onChange={(e) => setNameValue(e.target.value)}
          placeholder="Telecaller name"
          aria-label="Telecaller name"
          maxLength={120}
        />
        <Input
          value={idValue}
          onChange={(e) => setIdValue(e.target.value)}
          placeholder="ID (optional)"
          aria-label="Telecaller ID"
          maxLength={64}
        />
        {/* Only meaningful when editing an existing assignment - assigning an
            unassigned device for the first time is already "reassign"-shaped. */}
        {name ? (
          <Checkbox
            label="This is a different person"
            description={`Keeps ${name}’s call history under their own name instead of relabelling it.`}
            checked={reassign}
            onChange={(e) => setReassign(e.target.checked)}
          />
        ) : null}
        <div className="flex items-center gap-1.5">
          <Button type="button" size="sm" disabled={pending} onClick={save}>
            {pending ? "Saving…" : "Save"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() => {
              setNameValue(name ?? "");
              setIdValue(externalId ?? "");
              setReassign(false);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="group flex items-start gap-1.5 text-left"
      title={name ? "Edit telecaller" : "Assign telecaller"}
    >
      <User className="h-3.5 w-3.5 shrink-0 mt-0.5 text-text-muted" aria-hidden="true" />
      <span>
        <span className="flex items-center gap-1 text-sm font-medium text-text">
          {name || <span className="text-text-muted font-normal">Unassigned</span>}
          <Pencil
            className="h-3 w-3 text-text-subtle group-hover:text-text-muted"
            aria-hidden="true"
          />
        </span>
        {externalId ? (
          <span className="block font-mono text-[10px] text-text-muted">{externalId}</span>
        ) : null}
      </span>
    </button>
  );
}
