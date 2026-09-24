"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { CONTROL_CHROME, type ControlSize } from "@aura/ui";
import {
  checkPhone,
  dialCode,
  examplePhone,
  formatNationalAsYouType,
  isTooLongForCountry,
  phoneCountries,
  searchPhoneCountries,
  splitPhone,
  toPhoneCountry,
  type CountryCode,
  type PhoneCheck,
} from "@aura/shared/dist/phone";
import { useOrgRegion } from "./org-region";

/**
 * THE CONSOLE'S ONE PHONE FIELD.
 *
 * A country picker and the national number, side by side. It starts on the
 * workspace's country (Time & location, via OrgRegionProvider) and accepts a
 * different one from the list - or from a "+" number typed or pasted into it,
 * which switches the country by itself.
 *
 * ── WHAT IT GUARANTEES ──────────────────────────────────────────────────────
 *
 * The number is checked with `checkPhone` (@aura/shared/dist/phone): the exact
 * lengths and prefixes of the selected country, not a digit count. Invalid,
 * it calls `setCustomValidity` on the input, so an enclosing <form> refuses to
 * submit and the browser says why - no caller can forget the check. Callers
 * that save from a button outside a form gate on `usePhoneCheck` instead.
 *
 * A keystroke that would make the number longer than any number in that
 * country is refused outright, so the limit is felt while typing.
 *
 * ── WHAT IT EMITS ───────────────────────────────────────────────────────────
 *
 * `onChange(value)`: E.164 ("+919876543210") when valid, "" when blank, and
 * otherwise the best attempt ("+9198765") - so the parent always holds what
 * the field shows, and the server's own check refuses the attempt if it ever
 * got that far. With `name`, the same value is posted in a hidden input for a
 * Server Action form.
 *
 * ── WHY IT IS NOT IN @aura/ui ───────────────────────────────────────────────
 *
 * It reads the workspace's country from the owner layout's provider, and it
 * carries ~150 KB of numbering metadata. The kit is also the marketing site's,
 * whose funnel has its own country list and must not pay for this one.
 */
export interface PhoneInputProps {
  /** E.164, or a legacy stored value, which is parsed and shown as it was. */
  value: string | null | undefined;
  onChange?: (value: string, check: PhoneCheck) => void;
  /** Posts the emitted value in a hidden input, for FormData forms. FormField passes it. */
  name?: string;
  /** The text input's id - FormField's <label for> points here. */
  id?: string;
  required?: boolean;
  disabled?: boolean;
  /** Forced invalid styling (FormField sets it from its own `error`). */
  invalid?: boolean;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  "aria-label"?: string;
  /** Start on this country instead of the workspace's. */
  defaultCountry?: string;
  autoFocus?: boolean;
  size?: ControlSize;
  /** Width utilities for the whole control. */
  className?: string;
}

const SIZES: Record<ControlSize, string> = { sm: "px-2 py-1 text-xs", md: "px-3 py-2 text-sm" };
const INVALID = "border-danger hover:border-danger";
const PANEL_WIDTH = 288;
/** max-h-80. */
const PANEL_HEIGHT = 320;
/** Digits, and the punctuation people type in numbers. Letters never reach the field. */
const ALLOWED = /[^\d\s()+\-.]/g;

/** The value a field shows for its country, and what that emits. */
function emitted(national: string, country: CountryCode, check: PhoneCheck): string {
  if (check.ok) return check.empty ? "" : check.e164;
  const digits = national.replace(/\D/g, "");
  // Legacy free text is emitted untouched, so the parent never holds a
  // rewritten version of something the person has not edited yet.
  return digits && !/[a-z]/i.test(national) ? `${dialCode(country)}${digits}` : national;
}

/**
 * The workspace-aware check, for a caller that saves from a button rather
 * than a <form>: `const phoneCheck = usePhoneCheck(); phoneCheck(form.phone).ok`.
 */
export function usePhoneCheck(): (value: string | null | undefined, opts?: { required?: boolean }) => PhoneCheck {
  const region = useOrgRegion();
  const country = toPhoneCountry(region.country);
  return useCallback((value, opts) => checkPhone(value, country, opts), [country]);
}

export function PhoneInput({
  value,
  onChange,
  name,
  id,
  required = false,
  disabled = false,
  invalid = false,
  "aria-describedby": describedBy,
  "aria-invalid": ariaInvalid,
  "aria-label": ariaLabel,
  defaultCountry,
  autoFocus,
  size = "md",
  className = "",
}: PhoneInputProps) {
  const region = useOrgRegion();
  const home = toPhoneCountry(defaultCountry ?? region.country);
  const autoId = useId();
  const inputId = id ?? `${autoId}-phone`;
  const errorId = `${inputId}-error`;
  const listId = `${autoId}-countries`;
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number } | null>(null);

  const initial = useMemo(() => splitPhone(value, home), []);
  const [country, setCountry] = useState<CountryCode>(initial.country);
  const [national, setNational] = useState(initial.national);
  const [touched, setTouched] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const check = useMemo(() => checkPhone(national, country, { required }), [national, country, required]);
  const lastEmitted = useRef<string>(emitted(initial.national, initial.country, check));

  // The parent replaced the value (a reset after save, another record
  // loaded): re-read it. Our own echoes are ignored, or every keystroke
  // would be re-parsed and the caret would jump.
  useEffect(() => {
    const next = value ?? "";
    if (next === lastEmitted.current) return;
    const split = splitPhone(next, home);
    setCountry(split.country);
    setNational(split.national);
    setTouched(false);
    lastEmitted.current = next;
  }, [value, home]);

  const error = check.ok ? null : check.message;
  // Native constraint validation: a <form> will not submit while this is set.
  useEffect(() => {
    inputRef.current?.setCustomValidity(error ?? "");
  }, [error]);

  const commit = (nextNational: string, nextCountry: CountryCode) => {
    setNational(nextNational);
    setCountry(nextCountry);
    const nextCheck = checkPhone(nextNational, nextCountry, { required });
    const out = emitted(nextNational, nextCountry, nextCheck);
    lastEmitted.current = out;
    onChange?.(out, nextCheck);
  };

  const onInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    const el = event.target;
    const raw = el.value.replace(ALLOWED, "");
    // An international number switches the country to the one it names.
    if (/^\s*(\+|00)/.test(raw) && raw.replace(/\D/g, "").length > 2) {
      const split = splitPhone(raw, country);
      if (split.national !== raw) {
        commit(split.national, split.country);
        return;
      }
    }
    const before = national.replace(/\D/g, "");
    const after = raw.replace(/\D/g, "");
    if (after.length > before.length && isTooLongForCountry(after, country)) return;
    // Format while typing at the end; leave a mid-string edit alone, so the
    // caret does not jump past the digit that was just corrected.
    const atEnd = el.selectionStart === el.value.length;
    commit(atEnd && !raw.startsWith("+") ? formatNationalAsYouType(raw, country) : raw, country);
  };

  const onBlur = () => {
    setTouched(true);
    if (check.ok && !check.empty && check.country === country) setNational(check.national);
  };

  const all = useMemo(() => phoneCountries(), []);
  const rows = useMemo(() => {
    const found = searchPhoneCountries(query, all);
    if (query.trim()) return found;
    // Browsing: the workspace's country first, then everything by name.
    const pinned = found.find((c) => c.iso === home);
    return pinned ? [pinned, ...found.filter((c) => c.iso !== home)] : found;
  }, [query, all, home]);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setQuery("");
    setPlace(null);
    if (refocus) triggerRef.current?.focus();
  }, []);

  /** Below the trigger, or above it when the viewport has no room below. Null once it is off screen. */
  const measure = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect || rect.bottom < 0 || rect.top > window.innerHeight) return null;
    const gap = 6;
    const below = window.innerHeight - rect.bottom;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 8));
    return below >= PANEL_HEIGHT + gap || below >= rect.top
      ? { left, top: rect.bottom + gap }
      : { left, bottom: window.innerHeight - rect.top + gap };
  }, []);

  const openList = () => {
    const next = measure();
    if (!next) return;
    setPlace(next);
    setOpen(true);
  };

  // Dismissal: a press outside, or Escape. A scroll or resize RE-PLACES the
  // panel rather than closing it - on a phone, focusing the search box opens
  // the keyboard, which is itself a resize and often a scroll - and closes it
  // only once the trigger has left the screen.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Capture phase + stop: inside a Dialog, Escape must close this list,
      // not the dialog under it - the kit Popover's rule.
      event.stopPropagation();
      event.preventDefault();
      close();
    };
    const onMove = (event: Event) => {
      if (event.type === "scroll" && panelRef.current?.contains(event.target as Node)) return;
      const next = measure();
      if (next) setPlace(next);
      else close(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, close, measure]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
  }, [open]);
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, open, listId]);

  const choose = (iso: CountryCode) => {
    close(false);
    // Keep the digits already typed; they are re-checked against the new country.
    commit(national.replace(/[^\d\s()\-.]/g, "").trim(), iso);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const onSearchKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const last = rows.length - 1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, last));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (rows[active]) choose(rows[active].iso);
    } else if (event.key === "Tab") {
      close(false);
    }
  };

  const showError = Boolean(error) && touched;
  const isInvalid = invalid || showError;
  const described = [describedBy, showError ? errorId : null].filter(Boolean).join(" ") || undefined;
  const control = CONTROL_CHROME.replace("rounded-sm", "");

  return (
    <div className={`flex flex-col gap-1 ${/(?:^|\s)w-\S/.test(className) ? "" : "w-full"} ${className}`}>
      <div className="flex w-full min-w-0">
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          // ISO and dial code, not the country name: names come from the ICU of
          // whichever runtime renders, and the server and browser can differ.
          aria-label={`Country code ${dialCode(country)} (${country}). Change country`}
          onClick={() => (open ? close() : openList())}
          className={`${control} ${SIZES[size]} ${isInvalid ? INVALID : ""} flex shrink-0 items-center gap-1.5 rounded-l-sm border-r-0 tabular-nums`}
        >
          <span className="font-mono text-[11px] text-text-muted">{country}</span>
          <span>{dialCode(country)}</span>
          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 text-text-muted" />
        </button>
        {open && place ? (
          <div
            ref={panelRef}
            // FIXED, not the kit Popover's absolute: this field sits in table
            // rows (overflow-x-auto inside overflow-hidden) and in dialogs, and
            // an absolute panel is clipped by both. A fixed element escapes
            // overflow clipping, and staying a DOM descendant keeps it inside a
            // modal <dialog>'s top layer, where a portal to <body> would sit
            // underneath the backdrop.
            style={{ position: "fixed", left: place.left, top: place.top, bottom: place.bottom, width: PANEL_WIDTH }}
            className="z-50 flex max-h-80 max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-md border border-border bg-surface shadow-lg"
          >
          <div className="border-b border-border p-2">
            <input
              ref={searchRef}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined}
              aria-label="Search countries"
              autoComplete="off"
              spellCheck={false}
              value={query}
              placeholder="Country, code or +91"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
              className={`${CONTROL_CHROME} w-full px-2 py-1.5 text-sm`}
            />
          </div>
          <ul id={listId} role="listbox" aria-label="Countries" className="flex-1 overflow-auto py-1">
            {rows.length === 0 ? (
              <li role="presentation" className="px-3 py-3 text-sm text-text-muted">
                No country matches &ldquo;{query}&rdquo;.
              </li>
            ) : (
              rows.map((c, i) => (
                <li
                  key={c.iso}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={c.iso === country}
                  // mousedown: pick before the search box's blur can close the list.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(c.iso);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm ${
                    i === active ? "bg-surface-hover" : ""
                  } ${!query.trim() && i === 0 && c.iso === home ? "border-b border-border" : ""}`}
                >
                  <span className="w-6 shrink-0 font-mono text-[11px] text-text-muted">{c.iso}</span>
                  <span className="min-w-0 flex-1 truncate text-text">
                    {c.name}
                    {!query.trim() && i === 0 && c.iso === home ? (
                      <span className="ml-1.5 text-xs text-text-muted">· workspace default</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-xs text-text-muted tabular-nums">{c.dial}</span>
                  {c.iso === country ? (
                    <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-text" />
                  ) : (
                    <span aria-hidden="true" className="w-3.5 shrink-0" />
                  )}
                </li>
              ))
            )}
          </ul>
          </div>
        ) : null}
        <input
          ref={inputRef}
          id={inputId}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          autoFocus={autoFocus}
          disabled={disabled}
          required={required}
          aria-label={ariaLabel}
          aria-invalid={isInvalid || ariaInvalid || undefined}
          aria-describedby={described}
          value={national}
          placeholder={examplePhone(country) ?? undefined}
          onChange={onInput}
          onBlur={onBlur}
          // The browser refused a submit because of setCustomValidity: show
          // the reason inline too, not only in its transient bubble.
          onInvalid={() => setTouched(true)}
          className={`${control} ${SIZES[size]} ${isInvalid ? INVALID : ""} min-w-0 flex-1 rounded-r-sm tabular-nums`}
        />
      </div>
      {name ? <input type="hidden" name={name} value={emitted(national, country, check)} /> : null}
      {showError ? (
        <p id={errorId} role="alert" className="text-xs font-medium text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}

