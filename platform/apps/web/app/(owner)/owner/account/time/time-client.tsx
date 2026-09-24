"use client";

import { useEffect, useId, useMemo, useState, useTransition } from "react";
import { useDraftState } from "@/lib/use-server-state";
import { Check, Laptop } from "lucide-react";
import { Button, Card, ErrorBanner, Input, MonoLabel, useToast } from "@aura/ui";
import {
  canonicalTimeZone,
  formatTime,
  formatWeekdayDate,
  searchTimeZones,
  timeZoneCity,
  timeZoneShortLabel,
  utcOffsetMinutes,
  type TimeZoneOption,
} from "@aura/shared";
import { saveTimeZoneAction } from "../actions";

/** Browsing order for the grouped list - this product's markets first. */
const REGION_ORDER = ["Asia", "Europe", "Africa", "America", "Australia", "Pacific", "Indian", "Atlantic", "Antarctica", "Arctic", "UTC"];

const regionRank = (region: string) => {
  const i = REGION_ORDER.indexOf(region);
  return i === -1 ? REGION_ORDER.length : i;
};

/** "1 h 30 m behind" / "4 h ahead of" / "the same time as" - how far a zone is from another. */
export function describeGap(minutes: number): string {
  if (minutes === 0) return "the same time as";
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const mins = abs % 60;
  const span = [hours ? `${hours} h` : "", mins ? `${mins} m` : ""].filter(Boolean).join(" ");
  return `${span} ${minutes > 0 ? "ahead of" : "behind"}`;
}

/**
 * The workspace clock and the picker that changes it (Build docs/30 §4.5).
 *
 * ── WHY A COMBOBOX ──────────────────────────────────────────────────────────
 *
 * The old field was a <select> of ~420 raw IANA ids with no search and no
 * offsets. Nobody thinks "Asia/Dubai"; they think "Dubai", "UAE", "+4" or
 * "GST", and this matches all of those (`searchTimeZones`). Every option shows
 * the zone's local time right now and its offset, because "what time is it
 * there" is how a person checks they picked the right one.
 *
 * It is the ARIA 1.2 combobox pattern: focus stays in the input, the active
 * option is announced through aria-activedescendant, arrows/Home/End move,
 * Enter picks, Escape closes (then clears).
 *
 * ── WHY PICKING DOES NOT SAVE ───────────────────────────────────────────────
 *
 * The zone decides where every "today" begins, so a change re-counts overdue
 * follow-ups, re-cuts every daily chart and moves every report window. A
 * preview says exactly that, with the new local time and how far it is from
 * the current clock, BEFORE the save - cheaper than explaining an overnight
 * jump in "overdue" afterwards.
 */
export function TimeZoneSettings({
  current,
  options,
  renderedAt,
}: {
  current: string;
  options: TimeZoneOption[];
  /** The server's clock when it rendered; the first client render reuses it so hydration matches. */
  renderedAt: number;
}) {
  const toast = useToast();
  const inputId = useId();
  const listId = useId();
  const hintId = useId();
  const [now, setNow] = useState(renderedAt);
  const [saved, setSaved] = useDraftState(current);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [deviceZone, setDeviceZone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // The clocks tick only after hydration; the device's own zone is read only
  // after hydration too - the server cannot know it, and guessing would mismatch.
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    setDeviceZone(canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone));
  }, []);
  // A save revalidates the layout; the new `current` then arrives from the server.
  useEffect(() => setSaved(current), [current]);

  const browsing = query.trim() === "";
  const rows = useMemo(() => {
    const found = searchTimeZones(options, query);
    return browsing
      ? [...found].sort(
          (a, b) =>
            regionRank(a.region) - regionRank(b.region) ||
            a.offsetMinutes - b.offsetMinutes ||
            a.city.localeCompare(b.city),
        )
      : found;
  }, [options, query, browsing]);

  // Keep the active option in range and in view.
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, open, listId]);

  const choose = (id: string) => {
    setSelected(id);
    setQuery(timeZoneCity(id));
    setOpen(false);
    setError(null);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const last = rows.length - 1;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) setOpen(true);
        else setActive((i) => Math.min(i + 1, last));
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!open) setOpen(true);
        else setActive((i) => Math.max(i - 1, 0));
        break;
      case "Home":
        if (open) {
          event.preventDefault();
          setActive(0);
        }
        break;
      case "End":
        if (open) {
          event.preventDefault();
          setActive(Math.max(last, 0));
        }
        break;
      case "Enter":
        if (open && rows[active]) {
          event.preventDefault();
          choose(rows[active].id);
        }
        break;
      case "Escape":
        if (open) setOpen(false);
        else setQuery("");
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  };

  const target = selected && selected !== saved ? selected : null;
  const gap = target ? utcOffsetMinutes(target, now) - utcOffsetMinutes(saved, now) : 0;
  const savedCity = timeZoneCity(saved);

  const save = () => {
    if (!target) return;
    setError(null);
    startTransition(async () => {
      const result = await saveTimeZoneAction(target);
      if (result.error) {
        setError(result.fieldErrors?.timezone ?? result.error);
        return;
      }
      setSaved(result.timezone ?? target);
      setSelected(null);
      setQuery("");
      toast(`Time zone set to ${timeZoneCity(result.timezone ?? target)}`);
    });
  };

  // Options are grouped by region only while browsing; a search result is a
  // ranked list, and grouping it would bury the best match under a heading.
  let lastRegion: string | null = null;

  return (
    <>
      <Card className="space-y-5">
        <div className="space-y-1">
          <MonoLabel>Workspace clock</MonoLabel>
          <p className="text-3xl font-semibold text-text">{formatTime(now, saved)}</p>
          <p className="text-sm text-text-muted">
            {formatWeekdayDate(now, saved)} · {savedCity} · {timeZoneShortLabel(saved, now)}
          </p>
        </div>
        <div className="grid gap-5 border-t border-border pt-4 sm:grid-cols-2">
          <div className="space-y-2">
            <p className="text-sm font-medium text-text">What it sets, for everyone in this workspace</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-text-muted">
              <li>Every date and time shown in the console</li>
              <li>When &ldquo;today&rdquo; starts - due today, overdue follow-ups, response clocks</li>
              <li>The days and hours on the dashboard, in reports and on the call log</li>
            </ul>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-text">What it never changes</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-text-muted">
              <li>When anything happened - every call keeps its exact moment</li>
              <li>Due dates - a task due Thursday stays due Thursday</li>
              <li>The handset app, which records the moment, not a clock</li>
            </ul>
          </div>
        </div>
      </Card>

      <Card className="space-y-4">
        <div className="space-y-1">
          <label htmlFor={inputId} className="text-sm font-medium text-text">
            Change time zone
          </label>
          <p id={hintId} className="text-xs text-text-muted">
            Search a city, country, abbreviation or offset - Dubai, India, IST, +5:30.
          </p>
        </div>

        {deviceZone && deviceZone !== saved && deviceZone !== selected ? (
          <button
            type="button"
            onClick={() => choose(deviceZone)}
            className="flex w-full items-center gap-2 rounded-md border border-border px-3 py-2 text-left text-sm text-text-muted transition-colors duration-150 ease-out hover:bg-surface-hover hover:text-text"
          >
            <Laptop aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span>
              This device is on <span className="font-medium text-text">{timeZoneCity(deviceZone)}</span> time (
              {timeZoneShortLabel(deviceZone, now)}). Use it for the workspace?
            </span>
          </button>
        ) : null}

        <div className="relative">
          <Input
            id={inputId}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-describedby={hintId}
            aria-activedescendant={open && rows[active] ? `${listId}-opt-${active}` : undefined}
            autoComplete="off"
            spellCheck={false}
            value={query}
            placeholder={`${savedCity} - start typing to search`}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={onKeyDown}
          />
          {open ? (
            <ul
              id={listId}
              role="listbox"
              aria-label="Time zones"
              className="absolute z-20 mt-1 max-h-80 w-full overflow-auto rounded-md border border-border bg-surface py-1 shadow-lg"
            >
              {rows.length === 0 ? (
                <li role="presentation" className="px-3 py-3 text-sm text-text-muted">
                  No time zone matches &ldquo;{query}&rdquo;. Try a city, a country, or an offset like +5:30.
                </li>
              ) : (
                rows.map((option, i) => {
                  const header = browsing && option.region !== lastRegion ? option.region : null;
                  lastRegion = option.region;
                  return (
                    <li key={option.id} role="presentation">
                      {header ? (
                        <span
                          role="presentation"
                          className="block px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-text-subtle uppercase"
                        >
                          {header}
                        </span>
                      ) : null}
                      <div
                        id={`${listId}-opt-${i}`}
                        role="option"
                        aria-selected={option.id === (selected ?? saved)}
                        // mousedown, not click: keeps focus in the input so the
                        // blur does not close the list before the pick lands.
                        onMouseDown={(e) => {
                          e.preventDefault();
                          choose(option.id);
                        }}
                        onMouseEnter={() => setActive(i)}
                        className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm ${
                          i === active ? "bg-surface-hover" : ""
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-text">{option.city}</span>
                          <span className="block truncate text-xs text-text-muted">{option.id.replace(/_/g, " ")}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2 text-xs text-text-muted tabular-nums">
                          <span className="text-text">{formatTime(now, option.id)}</span>
                          <span>{option.offsetLabel}</span>
                          {option.id === saved ? (
                            <Check aria-label="Current" className="h-4 w-4 text-text" />
                          ) : (
                            <span aria-hidden="true" className="w-4" />
                          )}
                        </span>
                      </div>
                    </li>
                  );
                })
              )}
            </ul>
          ) : null}
        </div>

        {target ? (
          <div className="space-y-3 rounded-md border border-border bg-bg-subtle p-4" aria-live="polite">
            <p className="text-sm text-text">
              Now in <span className="font-semibold">{timeZoneCity(target)}</span>:{" "}
              {formatWeekdayDate(now, target)}, {formatTime(now, target)} ({timeZoneShortLabel(target, now)}) -{" "}
              {describeGap(gap)} the current clock ({savedCity}).
            </p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-text-muted">
              <li>
                &ldquo;Today&rdquo; will begin at midnight {timeZoneCity(target)} time. Overdue follow-ups, response
                clocks and &ldquo;due today&rdquo; re-count on that boundary.
              </li>
              <li>Daily and hourly charts, report windows and the dashboard&rsquo;s date range re-cut their days.</li>
              <li>Nothing stored changes, and you can switch back at any time.</li>
            </ul>
            {error ? <ErrorBanner>{error}</ErrorBanner> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={save} disabled={pending}>
                {pending ? "Saving…" : `Use ${timeZoneCity(target)} time`}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  setSelected(null);
                  setQuery("");
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
    </>
  );
}
