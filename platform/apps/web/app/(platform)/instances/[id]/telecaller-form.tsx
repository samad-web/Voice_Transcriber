"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, User } from "lucide-react";
import { BrutalButton } from "@aura/ui";
import { inputClass } from "@/lib/form";
import { setDeviceTelecallerAction } from "./actions";

/**
 * Who is holding this handset — collected right here, the moment a device
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
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () => {
    const trimmedName = nameValue.trim();
    if (!trimmedName) {
      setError("Name is required.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await setDeviceTelecallerAction({
        orgId,
        deviceId,
        name: trimmedName,
        externalId: idValue.trim() || null,
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  };

  if (editing) {
    return (
      <div className="space-y-1.5 min-w-40">
        <input
          autoFocus
          className={inputClass}
          value={nameValue}
          onChange={(e) => setNameValue(e.target.value)}
          placeholder="Telecaller name"
          aria-label="Telecaller name"
          maxLength={120}
        />
        <input
          className={inputClass}
          value={idValue}
          onChange={(e) => setIdValue(e.target.value)}
          placeholder="ID (optional)"
          aria-label="Telecaller ID"
          maxLength={64}
        />
        <div className="flex items-center gap-1.5">
          <BrutalButton className="px-2.5 py-1" disabled={pending} onClick={save}>
            {pending ? "SAVING…" : "SAVE"}
          </BrutalButton>
          <BrutalButton
            variant="secondary"
            className="px-2.5 py-1"
            disabled={pending}
            onClick={() => {
              setNameValue(name ?? "");
              setIdValue(externalId ?? "");
              setError(null);
              setEditing(false);
            }}
          >
            CANCEL
          </BrutalButton>
        </div>
        {error ? <p className="text-xs font-bold text-red-700">{error}</p> : null}
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
      <User className="h-3.5 w-3.5 shrink-0 mt-0.5 text-neutral-400" aria-hidden="true" />
      <span>
        <span className="flex items-center gap-1 text-sm font-medium text-black">
          {name || <span className="text-neutral-400 font-normal">Unassigned</span>}
          <Pencil className="h-3 w-3 text-neutral-300 group-hover:text-neutral-600" aria-hidden="true" />
        </span>
        {externalId ? (
          <span className="block font-mono text-[10px] text-neutral-400">{externalId}</span>
        ) : null}
      </span>
    </button>
  );
}
