"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@aura/ui";
import { resolveRecordAction, searchRecordsAction, type RecordOption } from "./crm-actions";

/** Long enough that typing a name doesn't fire a request per keystroke. */
const DEBOUNCE_MS = 250;

/**
 * Pick a contact, account or deal by name.
 *
 * The last thing in the custom-field editor still rendering as a raw uuid box.
 * A lookup field defined by an admin was technically usable — you could paste
 * an id — which is the kind of "working" that means nobody ever uses it.
 *
 * ── IT SHOWS A NAME, NOT AN ID ────────────────────────────────────────────
 *
 * A stored value is a uuid, and a form that displays one is telling the reader
 * nothing. So a mounted picker with a value resolves that id to a label first.
 * If the record is gone or outside the reader's scope it says "unknown record"
 * rather than failing — a lookup pointing at something deleted should not
 * break the form it sits in.
 *
 * Search runs through the ordinary list endpoints, so it inherits their
 * permission gate and their `owned` scope: this cannot become a way to
 * enumerate records the person could not otherwise see.
 */
export function RecordPicker({
  objectType,
  value,
  disabled,
  onChange,
}: {
  objectType: "contact" | "account" | "deal";
  value: string | null;
  disabled?: boolean;
  onChange: (id: string | null) => void;
}) {
  const [selected, setSelected] = useState<RecordOption | null>(null);
  const [resolving, setResolving] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<RecordOption[] | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Resolve the stored id to something a person recognises.
  useEffect(() => {
    let cancelled = false;
    if (!value) {
      setSelected(null);
      return;
    }
    setResolving(true);
    void resolveRecordAction(objectType, value).then((record) => {
      if (cancelled) return;
      setResolving(false);
      setSelected(record ?? { id: value, label: "Unknown record", detail: null });
    });
    return () => {
      cancelled = true;
    };
  }, [objectType, value]);

  // Debounced search. The timer is cleared on every keystroke, so a fast
  // typist makes one request rather than one per letter.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      void searchRecordsAction(objectType, query).then((result) => {
        setOptions(result.records ?? []);
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [objectType, query, open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (value && !open) {
    return (
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm text-text">
          {resolving ? "…" : (selected?.label ?? value)}
          {selected?.detail ? (
            <span className="ml-1.5 text-xs text-text-muted">{selected.detail}</span>
          ) : null}
        </span>
        {!disabled ? (
          <>
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setOptions(null);
                setOpen(true);
              }}
              className="text-xs text-text-muted hover:text-text"
            >
              Change
            </button>
            <button
              type="button"
              onClick={() => onChange(null)}
              className="text-xs text-text-muted hover:text-text"
            >
              Clear
            </button>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="relative" ref={box}>
      <Input
        value={query}
        disabled={disabled}
        placeholder={`Search ${objectType}s…`}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
      />

      {open ? (
        <ul className="absolute z-40 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-border bg-surface shadow-lg">
          {options === null ? (
            <li className="px-3 py-2 text-xs text-text-muted">Searching…</li>
          ) : options.length === 0 ? (
            <li className="px-3 py-2 text-xs text-text-muted">
              {/* Distinguishes "nothing matches" from "you can't see any",
                  which for a scoped role are very different situations. */}
              No {objectType}s you can see match that.
            </li>
          ) : (
            options.map((option) => (
              <li key={option.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(option);
                    onChange(option.id);
                    setOpen(false);
                  }}
                  className="block w-full px-3 py-2 text-left hover:bg-surface-hover"
                >
                  <span className="block truncate text-xs font-medium text-text">
                    {option.label}
                  </span>
                  {option.detail ? (
                    <span className="block truncate text-xs text-text-muted">{option.detail}</span>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
