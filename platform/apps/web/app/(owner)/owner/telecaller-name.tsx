"use client";

import { useState, useTransition } from "react";
import { Check, Pencil, X } from "lucide-react";
import { setTelecallerNameAction } from "./actions";

/**
 * Inline rename for the person holding a handset.
 *
 * Devices are labelled by hardware at enrolment ("Nokia G21 #2"), which is not
 * a name anyone wants to see on a leaderboard. Editing here rather than on a
 * settings page keeps it where the owner notices it is missing.
 */
export function TelecallerName({
  deviceId,
  name,
  deviceLabel,
}: {
  deviceId: string;
  name: string | null;
  deviceLabel: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () => {
    setError(null);
    startTransition(async () => {
      const result = await setTelecallerNameAction(deviceId, value.trim());
      if (result.error) setError(result.error);
      else setEditing(false);
    });
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") setEditing(false);
          }}
          maxLength={120}
          placeholder="Telecaller name"
          aria-label="Telecaller name"
          className="w-40 px-2 py-1 text-sm font-sans border-2 border-black rounded-none focus:outline-none focus:ring-2 focus:ring-black"
        />
        <button
          type="button"
          onClick={save}
          disabled={pending}
          aria-label="Save name"
          className="p-1 border-2 border-black bg-black text-white disabled:opacity-40"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => {
            setValue(name ?? "");
            setEditing(false);
          }}
          aria-label="Cancel"
          className="p-1 border-2 border-black bg-white text-black"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        {error ? <span className="text-[10px] font-mono text-red-600">{error}</span> : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="group text-left"
      title="Rename telecaller"
    >
      <span className="font-display font-bold text-black flex items-center gap-1.5">
        {name || deviceLabel || "Unnamed handset"}
        <Pencil className="h-3 w-3 text-neutral-300 group-hover:text-black" />
      </span>
      {name && deviceLabel ? (
        <span className="text-[10px] font-mono text-neutral-400">{deviceLabel}</span>
      ) : null}
    </button>
  );
}
