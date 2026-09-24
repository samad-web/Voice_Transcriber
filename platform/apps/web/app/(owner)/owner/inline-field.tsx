"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useDraftState } from "@/lib/use-server-state";
import { Check, Loader2, Pencil } from "lucide-react";

/**
 * A field you edit where it sits - no modal, no Save button for the page.
 *
 * Click the value (or focus it and press Enter) to edit; Enter or leaving the
 * field saves; Escape puts it back. The new value shows immediately and is
 * rolled back, with the reason underneath, if the server refuses it - a value
 * that silently snaps back is worse than no inline editing at all.
 *
 * A save that did not change anything makes no request.
 */
export function InlineField({
  label,
  value,
  onSave,
  type = "text",
  required = false,
  placeholder = "Add",
  maxLength = 200,
  readOnly = false,
  readOnlyReason,
}: {
  label: string;
  value: string | null;
  /** Resolves with an error message to roll back, or nothing on success. */
  onSave: (next: string | null) => Promise<string | undefined>;
  type?: "text" | "email";
  required?: boolean;
  placeholder?: string;
  maxLength?: number;
  readOnly?: boolean;
  readOnlyReason?: string;
}) {
  const [current, setCurrent] = useState(value);
  const [draft, setDraft] = useDraftState(value ?? "");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();

  // Follow the server when it re-renders with a newer value, unless mid-edit.
  useEffect(() => {
    if (!editing && !saving) setCurrent(value);
  }, [value, editing, saving]);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const begin = () => {
    if (readOnly) return;
    setDraft(current ?? "");
    setError(null);
    setEditing(true);
  };

  const commit = async () => {
    const trimmed = draft.trim();
    const next = trimmed === "" ? null : trimmed;
    setEditing(false);
    if (next === current) return;
    if (required && next === null) {
      setError(`${label} can't be empty.`);
      return;
    }
    if (type === "email" && next !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next)) {
      setError("That doesn't look like an email address.");
      return;
    }
    const previous = current;
    setCurrent(next);
    setSaving(true);
    const failure = await onSave(next);
    setSaving(false);
    if (failure) {
      setCurrent(previous);
      setError(failure);
      return;
    }
    setError(null);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div>
      <dt className="text-text-muted">{label}</dt>
      <dd className="mt-0.5">
        {editing ? (
          <input
            ref={input}
            type={type}
            value={draft}
            maxLength={maxLength}
            aria-label={label}
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commit();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
                setError(null);
              }
            }}
            className="h-8 w-full rounded-sm border border-border-strong bg-surface px-2 text-sm text-text"
          />
        ) : (
          <button
            type="button"
            onClick={begin}
            disabled={readOnly}
            title={readOnly ? readOnlyReason : `Edit ${label.toLowerCase()}`}
            aria-label={readOnly ? undefined : `${label}: ${current ?? "empty"}. Edit`}
            className="group flex w-full min-w-0 items-center gap-1.5 rounded-sm px-1 py-0.5 -mx-1 text-left text-sm font-medium break-words text-text enabled:hover:bg-surface-hover disabled:cursor-default"
          >
            <span className={`min-w-0 flex-1 ${current ? "" : "font-normal text-text-subtle"}`}>
              {current ?? (readOnly ? "-" : placeholder)}
            </span>
            {saving ? (
              <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin text-text-muted" />
            ) : saved ? (
              <Check aria-label="Saved" className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            ) : readOnly ? null : (
              <Pencil
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 text-text-subtle opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
              />
            )}
          </button>
        )}
        {error ? (
          <p id={errorId} role="alert" className="mt-1 text-xs text-orange-text">
            {error}
          </p>
        ) : null}
      </dd>
    </div>
  );
}
