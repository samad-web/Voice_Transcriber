"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Hourglass } from "lucide-react";
import { Button, useToast } from "@aura/ui";
import { MAX_STALE_AFTER_DAYS, MIN_STALE_AFTER_DAYS } from "@/lib/deal-staleness";
import { setStaleAfterDaysAction } from "./stale-actions";

/**
 * "Flag deals idle for N days" - the pipeline's stale threshold, beside the
 * board it changes.
 *
 * Read-only text for anyone who cannot change it (the action refuses them
 * regardless); an inline number and Save for an owner or manager. No modal:
 * it is one number, and the board behind it re-renders with the new flags the
 * moment it saves.
 */
export function StaleThreshold({
  pipelineId,
  days,
  canEdit,
}: {
  pipelineId: string;
  days: number;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(days));
  const [pending, startTransition] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();

  useEffect(() => setDraft(String(days)), [days]);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const label = (
    <>
      <Hourglass aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      Flag deals idle for
    </>
  );

  if (!canEdit || !editing) {
    return (
      <div className="flex items-center gap-1.5 text-sm text-text-muted">
        {label}
        <span className="font-medium text-text tabular-nums">
          {days} day{days === 1 ? "" : "s"}
        </span>
        {canEdit ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="ml-1 text-xs font-medium text-accent-text hover:underline"
          >
            Change
          </button>
        ) : null}
      </div>
    );
  }

  const save = () => {
    const value = Number(draft);
    startTransition(async () => {
      const result = await setStaleAfterDaysAction(pipelineId, value);
      if (result.error) {
        toast(result.error);
        return;
      }
      setEditing(false);
    });
  };

  return (
    <form
      className="flex flex-wrap items-center gap-1.5 text-sm text-text-muted"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <label htmlFor={`stale-days-${pipelineId}`} className="flex items-center gap-1.5">
        {label}
      </label>
      <input
        ref={input}
        id={`stale-days-${pipelineId}`}
        type="number"
        inputMode="numeric"
        min={MIN_STALE_AFTER_DAYS}
        max={MAX_STALE_AFTER_DAYS}
        step={1}
        required
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setDraft(String(days));
            setEditing(false);
          }
        }}
        className="h-8 w-16 rounded-sm border border-border-strong bg-surface px-2 text-sm text-text tabular-nums"
      />
      <span>days</span>
      <Button type="submit" size="sm" loading={pending}>
        Save
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => {
          setDraft(String(days));
          setEditing(false);
        }}
      >
        Cancel
      </Button>
    </form>
  );
}
