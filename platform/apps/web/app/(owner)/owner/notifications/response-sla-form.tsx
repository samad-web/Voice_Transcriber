"use client";

import { useState } from "react";
import { useDraftState } from "@/lib/use-server-state";
import { Button, FormField, Select, useAlert, useToast } from "@aura/ui";
import { saveResponseSlaAction } from "./actions";

/** Common targets; the org's current value is always offered even if it is none of these. */
const PRESETS = [5, 15, 30, 60, 120, 240, 480, 1440];

function label(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours} hour${hours === 1 ? "" : "s"}` : `${minutes} minutes`;
}

/**
 * The org's response time target (migration 0109) - how long a new lead may
 * wait for a first response before its telecaller and the owners and managers
 * are told. Owner/manager only; the page does not render this for anyone else
 * and the API refuses them regardless.
 */
export function ResponseSlaForm({ initial }: { initial: number }) {
  const [saved, setSaved] = useDraftState(initial);
  const [minutes, setMinutes] = useDraftState(initial);
  const [busy, setBusy] = useState(false);
  const alert = useAlert();
  const toast = useToast();
  const options = PRESETS.includes(saved) ? PRESETS : [...PRESETS, saved].sort((a, b) => a - b);

  const save = async () => {
    setBusy(true);
    const res = await saveResponseSlaAction(minutes);
    setBusy(false);
    if (res.error || res.minutes === undefined) {
      await alert({ title: "Couldn't change the response time", body: res.error, tone: "danger" });
      return;
    }
    setSaved(res.minutes);
    toast(`Response time set to ${label(res.minutes)}`);
  };

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
      <FormField
        label="Respond to new leads within"
        name="responseSlaMinutes"
        hint="Leads still unanswered after this raise a “Response time missed” notification, once per lead."
        className="sm:w-72"
      >
        <Select value={minutes} onChange={(event) => setMinutes(Number(event.target.value))}>
          {options.map((m) => (
            <option key={m} value={m}>
              {label(m)}
            </option>
          ))}
        </Select>
      </FormField>
      <Button
        type="button"
        variant="secondary"
        loading={busy}
        disabled={minutes === saved}
        onClick={() => void save()}
        className="sm:mb-6"
      >
        Save response time
      </Button>
    </div>
  );
}
