"use client";

import { useState, useTransition } from "react";
import { StatusChip, useAlert, useToast } from "@aura/ui";
import { setCallDispositionAction, type Disposition } from "./actions";

const TONE: Record<string, "solid" | "muted" | "outline" | "danger"> = {
  green: "solid",
  blue: "muted",
  amber: "muted",
  red: "danger",
  purple: "muted",
  grey: "outline",
};

/**
 * What a person says this call was.
 *
 * ── WHY IT SITS BESIDE THE AI'S READ RATHER THAN REPLACING IT ───────────────
 *
 * The chips above this show what the model made of the call. Those stay. This
 * row is what somebody agreed to, in the tenant's own vocabulary, and the two
 * being visible together is the point: a manager scanning a call can see at a
 * glance where the machine and the floor disagree, which is the signal that
 * tells you whether to trust the machine's read on the other nine hundred
 * calls nobody has opened.
 *
 * ── AND WHY RE-RATING THE LEAD IS ANNOUNCED ─────────────────────────────────
 *
 * Some dispositions carry a lead quality, and pressing one moves the lead's
 * temperature - permanently, against the pipeline (0083's `temperature_source
 * = 'user'`). That is a change to a record on somebody else's board, so the
 * toast says it happened. A chip that silently re-rated a lead would be a side
 * effect nobody consented to, and the first anyone would know is a board that
 * had gone cold.
 */
export function DispositionPicker({
  callId,
  dispositions,
  current,
  onChange,
}: {
  callId: string;
  dispositions: Disposition[];
  current: string | null;
  onChange?: (key: string | null) => void;
}) {
  const [selected, setSelected] = useState(current);
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const toast = useToast();

  const active = dispositions.filter((d) => d.is_active);
  if (active.length === 0) return null;

  const choose = (disposition: Disposition) => {
    // Pressing the current one clears it, which is the only way back from a
    // mis-click and needs no second control.
    const next = selected === disposition.key ? null : disposition.key;
    const previous = selected;
    setSelected(next);
    onChange?.(next);

    startTransition(async () => {
      const result = await setCallDispositionAction(callId, next);
      if (result.error) {
        setSelected(previous);
        onChange?.(previous);
        await alert({ title: "Couldn't save that", body: result.error, tone: "danger" });
        return;
      }
      toast(
        result.leadRerated
          ? `Marked ${disposition.label.toLowerCase()} - the lead is now ${disposition.lead_quality}`
          : next === null
            ? "Cleared"
            : `Marked ${disposition.label.toLowerCase()}`,
      );
    });
  };

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium tracking-wide text-text-muted uppercase">How it went</p>
      <div className="flex flex-wrap gap-1.5">
        {active.map((d) => {
          const isSelected = selected === d.key;
          return (
            <button
              key={d.key}
              type="button"
              disabled={pending}
              aria-pressed={isSelected}
              onClick={() => choose(d)}
              className={`rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-60 ${
                isSelected
                  ? "border-text bg-text text-bg"
                  : "border-border text-text-muted hover:border-border-strong hover:text-text"
              }`}
            >
              {d.label}
              {/* Said on the button, not discovered afterwards: this one is
                  going to change the lead's rating. */}
              {d.lead_quality && !isSelected ? (
                <span className="ml-1 opacity-60">· {d.lead_quality}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      {selected ? (
        <p className="text-xs text-text-muted">
          <StatusChip tone={TONE[active.find((d) => d.key === selected)?.color ?? "grey"]}>
            Recorded
          </StatusChip>{" "}
          Press it again to clear.
        </p>
      ) : null}
    </div>
  );
}
