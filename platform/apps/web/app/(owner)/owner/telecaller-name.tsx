"use client";

import { useState, useTransition } from "react";
import { Check, Pencil, X } from "lucide-react";
import { Button, Checkbox, Input } from "@aura/ui";
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
  const [reassign, setReassign] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () => {
    setError(null);
    startTransition(async () => {
      const result = await setTelecallerNameAction(deviceId, value.trim(), reassign);
      if (result.error) setError(result.error);
      else setEditing(false);
    });
  };

  if (editing) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <Input
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
            // <Input> is w-full by design; this one sits inside a table cell.
            invalid={Boolean(error)}
            className="w-40"
          />
          <Button
            type="button"
            size="sm"
            onClick={save}
            loading={pending}
            aria-label="Save name"
            className="px-2"
          >
            {pending ? null : <Check className="h-3.5 w-3.5" aria-hidden="true" />}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setValue(name ?? "");
              setReassign(false);
              setEditing(false);
            }}
            aria-label="Cancel"
            className="px-2"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
        {/* Only meaningful when renaming an existing person - naming an
            unassigned handset for the first time is already "reassign"-shaped
            with nothing to distinguish it from. */}
        {name ? (
          <Checkbox
            checked={reassign}
            onChange={(e) => setReassign(e.target.checked)}
            label="This is a different person"
            description="Keeps the previous person's call history under their own name instead of relabelling it."
            className="text-xs"
          />
        ) : null}
        {/* role=alert: the failure arrives after a round trip, so it has to be
            announced rather than only appear. */}
        {error ? (
          <span role="alert" className="text-xs font-medium text-danger-text">
            {error}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="group rounded-sm text-left"
      title="Rename telecaller"
    >
      <span className="flex items-center gap-1.5 text-sm font-medium text-text">
        {name || deviceLabel || "Unnamed handset"}
        <Pencil
          aria-hidden="true"
          className="h-3 w-3 text-text-subtle transition-colors duration-150 ease-out group-hover:text-text"
        />
      </span>
      {name && deviceLabel ? (
        <span className="block text-xs text-text-muted">{deviceLabel}</span>
      ) : null}
    </button>
  );
}
