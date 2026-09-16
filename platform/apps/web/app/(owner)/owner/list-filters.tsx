"use client";

import { useRouter } from "next/navigation";
import type { FormEvent, ReactNode } from "react";
import { Search } from "lucide-react";
import { MonoLabel, Select } from "@aura/ui";
import type { FilterOption } from "./list-options";

/**
 * The filter and sort row every list view shares.
 *
 * Plain named <input>s and native <select>s inside one form, turned into a
 * query string on submit - the URL stays the whole state (lib/list-views.ts),
 * so a filtered list is a link and a saved view is a name for it.
 *
 * What the form adds over a bare GET form:
 *   - empty fields are dropped, so "Any owner" does not write `?owner=`;
 *   - a select applies the moment it changes, while the search box waits for
 *     Enter, so typing does not reload the list per keystroke;
 *   - `keep` carries state that lives outside the form (the Deals pipeline and
 *     view, the stage chips) through a filter change;
 *   - the page offset is always dropped - page 7 of a new filter is an empty
 *     table that looks broken.
 *
 * Remounted by the caller (`key` = the current query) so the controls show the
 * URL after a back-button navigation instead of what was last typed.
 */
export function ListFilterForm({
  path,
  keep = {},
  children,
  label = "Filter the list",
}: {
  path: string;
  keep?: Record<string, string | null | undefined>;
  children: ReactNode;
  label?: string;
}) {
  const router = useRouter();

  const apply = (form: HTMLFormElement) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(keep)) {
      if (value) params.set(key, value);
    }
    for (const [key, value] of new FormData(form).entries()) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed) params.set(key, trimmed);
      else params.delete(key);
    }
    params.delete("offset");
    params.delete("page");
    const qs = params.toString();
    router.push(`${path}${qs ? `?${qs}` : ""}`);
  };

  return (
    <form
      role="search"
      aria-label={label}
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        apply(e.currentTarget);
      }}
      onChange={(e) => {
        if (e.target instanceof HTMLSelectElement) apply(e.currentTarget);
      }}
      className="flex flex-wrap items-end gap-x-3 gap-y-2"
    >
      {children}
    </form>
  );
}

/** The free-text box. Applies on Enter (or the search button). */
export function FilterSearch({
  name = "q",
  defaultValue,
  placeholder,
  label,
}: {
  name?: string;
  defaultValue?: string;
  placeholder: string;
  label: string;
}) {
  return (
    <div className="min-w-[12rem] flex-1 sm:max-w-sm">
      <MonoLabel>Search</MonoLabel>
      <div className="relative mt-1.5">
        <input
          type="search"
          name={name}
          defaultValue={defaultValue ?? ""}
          placeholder={placeholder}
          aria-label={label}
          // The kit Select's box (control-styles.ts: py-2 text-sm, 1px border), so the row lines up.
          className="w-full rounded-sm border border-border-strong bg-surface py-2 pr-9 pl-3 text-sm text-text placeholder:text-text-muted"
        />
        <button
          type="submit"
          aria-label="Search"
          className="absolute top-1/2 right-1 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-sm text-text-muted transition-colors duration-150 ease-out hover:text-text"
        >
          <Search aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/** One labelled native select. The first option should be the "any" choice with value "". */
export function FilterSelect({
  name,
  label,
  defaultValue,
  options,
}: {
  name: string;
  label: string;
  defaultValue?: string | null;
  options: readonly FilterOption[];
}) {
  const id = `filter-${name}`;
  return (
    <div className="min-w-[9rem]">
      {/* MonoLabel's type, as a real <label> - MonoLabel renders a <p>, which a label cannot contain. */}
      <label htmlFor={id} className="block text-xs text-text-muted">
        {label}
      </label>
      <div className="mt-1.5">
        {/* No height/padding override: a smaller py-* would silently lose to the
            kit's base py-2 (cx is a plain join). The search box matches this instead. */}
        <Select id={id} name={name} defaultValue={defaultValue ?? ""}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}
