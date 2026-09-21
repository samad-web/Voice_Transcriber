"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Input, Popover } from "@aura/ui";
import { resolveRecordAction, searchRecordsAction, type RecordOption } from "./crm-actions";

/** Long enough that typing a name doesn't fire a request per keystroke. */
const DEBOUNCE_MS = 250;

/**
 * Pick a contact, account or deal by name.
 *
 * The last thing in the custom-field editor still rendering as a raw uuid box.
 * A lookup field defined by an admin was technically usable - you could paste
 * an id - which is the kind of "working" that means nobody ever uses it.
 *
 * ── IT SHOWS A NAME, NOT AN ID ────────────────────────────────────────────
 *
 * A stored value is a uuid, and a form that displays one is telling the reader
 * nothing. So a mounted picker with a value resolves that id to a label first.
 * If the record is gone or outside the reader's scope it says "unknown record"
 * rather than failing - a lookup pointing at something deleted should not
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
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

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

  // Reset the highlight whenever the result set changes underneath it, or the
  // arrow keys would be steering an index into a list that has since changed.
  useEffect(() => {
    setActive(0);
  }, [options]);

  // Pressing "Change" on a resolved value swaps the whole compact view out for
  // this field, so the field has to take focus itself - the button that was
  // clicked no longer exists to hand it on.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const choose = (option: RecordOption) => {
    setSelected(option);
    onChange(option.id);
    setOpen(false);
  };

  /**
   * Arrow keys, Enter, Escape.
   *
   * This picker had no keyboard affordance and no ARIA at all - no `role`, no
   * `aria-expanded`, no `aria-activedescendant` - so a screen reader announced
   * a plain text box and gave no indication that a list had appeared beneath
   * it, let alone how to reach one. It is the same combobox that
   * components/global-search.tsx already implements correctly, so this follows
   * that file rather than inventing a second pattern.
   *
   * Escape is handled here as well as by Popover: this returns focus to the
   * field and stops the keystroke, which is what a combobox should do, and the
   * capture-phase listener in Popover closing the panel is the same outcome.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (open) setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (!options || options.length === 0) return;
      setActive((i) =>
        event.key === "ArrowDown"
          ? (i + 1) % options.length
          : (i - 1 + options.length) % options.length,
      );
      return;
    }
    if (event.key === "Enter" && open && options?.[active]) {
      event.preventDefault();
      choose(options[active]);
    }
  };

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

  const optionId = (index: number) => `${listId}-option-${index}`;

  return (
    <Popover
      open={open}
      onDismiss={() => setOpen(false)}
      align="stretch"
      className="max-h-56 overflow-y-auto"
      trigger={
        <Input
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options?.[active] ? optionId(active) : undefined}
          aria-label={`Search ${objectType}s`}
          autoComplete="off"
          value={query}
          disabled={disabled}
          placeholder={`Search ${objectType}s…`}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
        />
      }
    >
      <ul id={listId} role="listbox" aria-label={`Matching ${objectType}s`}>
        {options === null ? (
          // `role="presentation"`: a listbox may only contain options and
          // groups, and "Searching…" is neither - it is status, not a choice.
          <li role="presentation" className="px-3 py-2 text-xs text-text-muted">
            Searching…
          </li>
        ) : options.length === 0 ? (
          <li role="presentation" className="px-3 py-2 text-xs text-text-muted">
            {/* Distinguishes "nothing matches" from "you can't see any",
                which for a scoped role are very different situations. */}
            No {objectType}s you can see match that.
          </li>
        ) : (
          options.map((option, i) => (
            <li
              key={option.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              // onMouseDown, not onClick: mousedown fires before the input
              // blurs, so the selection lands instead of the panel closing out
              // from under the pointer. Same reason global-search uses it.
              onMouseDown={(e) => {
                e.preventDefault();
                choose(option);
              }}
              onMouseEnter={() => setActive(i)}
              className={`cursor-pointer px-3 py-2 ${i === active ? "bg-surface-hover" : ""}`}
            >
              <span className="block truncate text-xs font-medium text-text">{option.label}</span>
              {option.detail ? (
                <span className="block truncate text-xs text-text-muted">{option.detail}</span>
              ) : null}
            </li>
          ))
        )}
      </ul>
    </Popover>
  );
}
