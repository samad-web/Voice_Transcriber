"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Contact, Handshake, Loader2, MessageSquareText, Search, X } from "lucide-react";
import { ErrorBanner, Popover } from "@aura/ui";
import {
  SEARCH_MIN_CHARS,
  highlightParts,
  searchUrl,
  type GlobalSearchResponse,
  type SearchHit,
  type SearchHitKind,
} from "@/lib/global-search";

const DEBOUNCE_MS = 200;

const KIND_ICON: Record<SearchHitKind, typeof Contact> = {
  contact: Contact,
  deal: Handshake,
  note: MessageSquareText,
};

const KIND_NOUN: Record<SearchHitKind, string> = {
  contact: "contacts",
  deal: "deals",
  note: "activity notes",
};

type Status = "idle" | "loading" | "done" | "error";

/**
 * The header's search box - contacts, deals and activity notes in one list.
 *
 * Knows nothing about any CRM: it asks `searchUrl` and renders the
 * `GlobalSearchResponse` it gets (lib/global-search.ts), so a tenant on a
 * different data source uses this component unchanged.
 *
 * Behaviour worth stating, because each is a way this kind of box goes wrong:
 *   - Every keystroke aborts the request before it. Results can only ever be
 *     for what is in the box now, never for what was there 300ms ago.
 *   - `/` or Ctrl/Cmd+K focuses it from anywhere, unless the person is already
 *     typing in some other field.
 *   - Arrow keys move through ALL results across the groups; Enter opens the
 *     highlighted one; Escape closes the list, and a second Escape clears it.
 *   - An upstream failure says "couldn't search deals" rather than showing an
 *     empty list that reads as "no deals match".
 *
 * ARIA: the input is a combobox owning a listbox, with the highlighted option
 * exposed through aria-activedescendant so focus never leaves the input.
 */
export function GlobalSearch({
  placeholder = "Search contacts, deals, notes",
}: {
  placeholder?: string;
}) {
  const router = useRouter();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<GlobalSearchResponse | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const hits = useMemo(() => response?.groups.flatMap((g) => g.hits) ?? [], [response]);
  const trimmed = query.trim();

  // Fetch, debounced and abortable.
  useEffect(() => {
    if (trimmed.length < SEARCH_MIN_CHARS) {
      setResponse(null);
      setStatus("idle");
      return;
    }
    const controller = new AbortController();
    setStatus("loading");
    const run = async () => {
      try {
        const res = await fetch(searchUrl(trimmed), {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`search ${res.status}`);
        const body = (await res.json()) as GlobalSearchResponse;
        setResponse(body);
        setActive(0);
        setStatus("done");
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setResponse(null);
        setStatus("error");
      }
    };
    const timer = setTimeout(() => void run(), DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed]);

  // Global shortcut.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "");
      const combo = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (combo || (event.key === "/" && !typing)) {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Click-away and Escape now come from Popover. Escape is still handled in
  // `onKeyDown` below as well, because this field has a SECOND Escape
  // behaviour Popover knows nothing about: once the list is closed, a further
  // Escape clears the query.

  const go = (hit: SearchHit) => {
    setOpen(false);
    inputRef.current?.blur();
    router.push(hit.href);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (open) setOpen(false);
      else setQuery("");
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (hits.length === 0) return;
      setActive((i) =>
        event.key === "ArrowDown" ? (i + 1) % hits.length : (i - 1 + hits.length) % hits.length,
      );
      return;
    }
    if (event.key === "Enter" && open && hits[active]) {
      event.preventDefault();
      go(hits[active]);
    }
  };

  const showPanel = open && trimmed.length >= SEARCH_MIN_CHARS;
  const optionId = (index: number) => `${listId}-option-${index}`;
  let index = -1;

  return (
    <Popover
      // Keyed on `showPanel`, not `open`: the field is "open" from the moment
      // it takes focus, but the results only exist once the query is long
      // enough, and it is the results the popover is.
      open={showPanel}
      onDismiss={() => setOpen(false)}
      align="stretch"
      anchorClassName="w-full min-w-0"
      className="max-h-[min(28rem,70dvh)] overflow-y-auto"
      // The input keeps its own focus handling: `go()` deliberately blurs and
      // navigates, and pulling focus back to the search box as the next route
      // mounts would drag the viewport back to the header.
      restoreFocus={false}
      trigger={
        <>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-text-muted"
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-label="Search contacts, deals and activity notes"
            aria-expanded={showPanel}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={showPanel && hits[active] ? optionId(active) : undefined}
            value={query}
            placeholder={placeholder}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            autoComplete="off"
            spellCheck={false}
            className="h-9 w-full rounded-sm border border-border-strong bg-surface pr-16 pl-9 text-sm text-text transition-colors duration-150 ease-out placeholder:text-text-muted hover:border-text-subtle [&::-webkit-search-cancel-button]:hidden"
          />
          <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1">
            {status === "loading" ? (
              <Loader2 className="h-4 w-4 animate-spin text-text-muted" aria-label="Searching" />
            ) : null}
            {query ? (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  inputRef.current?.focus();
                }}
                aria-label="Clear search"
                className="inline-flex h-6 w-6 items-center justify-center rounded-full text-text-muted hover:bg-surface-hover hover:text-text"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : (
              <kbd className="hidden rounded border border-border px-1.5 text-[10px] text-text-muted sm:inline">
                /
              </kbd>
            )}
          </div>
        </>
      }
    >
      <ul id={listId} role="listbox" aria-label="Search results" className="py-1">
        {response?.groups.map((group) => {
          const Icon = KIND_ICON[group.kind];
          return (
            <li key={group.kind} role="presentation">
              {/* Hidden from assistive tech: the group below carries the same
                      name, and a listbox may only contain options and groups. */}
              <p
                aria-hidden="true"
                className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-text-subtle uppercase"
              >
                {group.label}
              </p>
              <ul role="group" aria-label={group.label}>
                {group.hits.map((hit) => {
                  index += 1;
                  const i = index;
                  const selected = i === active;
                  return (
                    <li
                      key={`${hit.kind}-${hit.id}`}
                      id={optionId(i)}
                      role="option"
                      aria-selected={selected}
                      onMouseEnter={() => setActive(i)}
                      // mousedown, not click: click fires after the input's
                      // blur, and nothing here should race that.
                      onMouseDown={(event) => {
                        event.preventDefault();
                        go(hit);
                      }}
                      className={`flex cursor-pointer items-start gap-2.5 px-3 py-2 ${
                        selected ? "bg-surface-hover" : ""
                      }`}
                    >
                      <Icon
                        className="mt-0.5 h-4 w-4 shrink-0 text-text-muted"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-text">
                          <Highlighted text={hit.title} query={trimmed} />
                        </span>
                        {hit.subtitle ? (
                          <span className="block truncate text-xs text-text-muted">
                            <Highlighted text={hit.subtitle} query={trimmed} />
                          </span>
                        ) : null}
                      </span>
                      {hit.meta ? (
                        <span className="shrink-0 text-xs text-text-muted tabular-nums">
                          {hit.meta}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>

      {status === "done" && hits.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-text-muted">
          No contacts, deals or notes match “{trimmed}”
        </p>
      ) : null}
      {/* Was the same muted grey as "no matches" one line above - so a search
          that FAILED and a search that found nothing were the same sentence in
          the same colour, and the reader concluded the record does not exist.
          ErrorBanner is `role="alert"` and carries the error tone. */}
      {status === "error" ? (
        <div className="p-2">
          <ErrorBanner>Search is unavailable right now. Your records are unaffected.</ErrorBanner>
        </div>
      ) : null}
      {status === "done" && response && response.unavailable.length > 0 ? (
        <div className="p-2 pt-0">
          <ErrorBanner>
            Couldn’t search {response.unavailable.map((k) => KIND_NOUN[k]).join(" or ")} - these
            results may be incomplete.
          </ErrorBanner>
        </div>
      ) : null}
    </Popover>
  );
}

function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((part, i) =>
        part.match ? (
          <mark key={i} className="bg-transparent font-semibold text-text">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}
