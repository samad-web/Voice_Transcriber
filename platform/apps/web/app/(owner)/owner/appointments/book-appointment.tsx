"use client";

import { useEffect, useState, useTransition } from "react";
import { Card, ErrorBanner, MonoLabel, useToast } from "@aura/ui";
import type { ResourceView } from "../resources/resources-console";
import { createAppointmentAction, searchLeadsAction, type CustomerHit } from "./actions";
import type { AppointmentView } from "./appointments-console";

const FIELD =
  "rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text disabled:opacity-60";

/**
 * Turn a workspace-local date and time into the absolute instant the API wants.
 *
 * ── WHY THIS IS NOT `new Date(\`${date}T${time}\`)` ────────────────────────
 *
 * That parses in the BROWSER's zone. A Dubai clinic whose receptionist is on a
 * laptop set to IST would book every slot 90 minutes early, and an appointment
 * is the one record where being wrong about the clock means somebody standing
 * outside a locked door.
 *
 * So the offset is measured for the target zone on that date - which is also
 * why the date matters and a fixed offset would not do: half the zones this
 * product sells into change their offset twice a year, and a booking made in
 * October for November would land an hour out.
 */
function toInstant(date: string, time: string, zone: string): string | null {
  if (!date || !time) return null;
  // The wall-clock reading, treated as UTC for a moment. `asUtc` is not the
  // answer - it is the thing we measure the zone's offset against.
  const asUtc = new Date(`${date}T${time}:00Z`);
  if (Number.isNaN(asUtc.getTime())) return null;
  // What that same instant reads as in the target zone, parsed back out. The
  // difference between the two IS the offset, including whatever DST is in
  // force on that date.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(asUtc);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const shown = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    Number(get("hour")) === 24 ? 0 : Number(get("hour")),
    Number(get("minute")),
    Number(get("second")),
  );
  const offset = shown - asUtc.getTime();
  return new Date(asUtc.getTime() - offset).toISOString();
}

/**
 * The lengths a diary actually uses, plus whatever the pack asks for.
 *
 * Union-ed rather than fixed, for the reason the resource types are: a pack
 * could suggest a length this list does not carry, and a picker that silently
 * dropped it would open on a value it cannot show.
 */
function lengthOptions(packDefault: number): number[] {
  return [...new Set([15, 30, 45, 60, 90, 120, packDefault])].sort((a, b) => a - b);
}

/**
 * Book something (Build docs/40 §B2).
 *
 * ── THE CUSTOMER IS REQUIRED, AND NOT BECAUSE OF A COLUMN ──────────────────
 *
 * 0166 refuses an appointment with neither a lead nor a contact, and the reason
 * is worth repeating on the form: every address a reminder could ever resolve
 * comes from the lead or the contact. An appointment with nobody on it is a
 * diary entry no reminder can reach and nobody can follow up - so the picker is
 * the first field rather than an optional extra at the bottom.
 */
export function BookAppointment({
  types,
  resources,
  timeZone,
  defaultSlotMinutes,
  onBooked,
}: {
  types: string[];
  resources: ResourceView[];
  timeZone: string;
  /**
   * The workspace's industry pack's usual length (migration 0170).
   *
   * This is the visible half of making the stage packs real: picking "clinic"
   * now means a booking form that opens on 30 minutes, and "property" one that
   * opens on two hours. Before 0170 nothing in the schema said which business a
   * tenant was, so every form everywhere opened on the same number.
   */
  defaultSlotMinutes: number;
  onBooked: (appointment: AppointmentView) => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<CustomerHit[]>([]);
  const [lead, setLead] = useState<CustomerHit | null>(null);

  const [appointmentType, setAppointmentType] = useState(types[0] ?? "consultation");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("10:00");
  const [minutes, setMinutes] = useState(defaultSlotMinutes);
  const [resourceId, setResourceId] = useState("");
  const [location, setLocation] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  // Debounced, and the request is NOT aborted on unmount by hand: a stale
  // answer is discarded by the `cancelled` flag instead, which is the pattern
  // that survives React re-running the effect in development.
  useEffect(() => {
    if (query.trim().length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchLeadsAction(query).then((result) => {
        if (!cancelled) setHits(result.hits);
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  if (!open) {
    return (
      <div>
        <button
          type="button"
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-text hover:opacity-90"
          onClick={() => setOpen(true)}
        >
          Book an appointment
        </button>
      </div>
    );
  }

  const submit = () => {
    setError(null);
    const startsAt = toInstant(date, time, timeZone);
    if (!startsAt) {
      setError("Pick a date and a time.");
      return;
    }
    const endsAt = new Date(new Date(startsAt).getTime() + minutes * 60_000).toISOString();
    startTransition(async () => {
      const result = await createAppointmentAction({
        appointmentType,
        startsAt,
        endsAt,
        leadId: lead?.id ?? null,
        resourceId: resourceId || null,
        location: location.trim() || null,
        // `confirmed` is the customer having said yes on the call, which is the
        // ordinary case for a rep booking a site visit. Default `scheduled` -
        // the quieter of the two, since nobody has said yes yet.
        status: confirmed ? "confirmed" : "scheduled",
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.appointment) onBooked(result.appointment as AppointmentView);
      toast("Booked — tell the customer yourself, nothing was sent");
      setOpen(false);
      setLead(null);
      setQuery("");
      setLocation("");
    });
  };

  return (
    <Card className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-text">Book an appointment</h3>
        <p className="mt-1 max-w-2xl text-sm text-text-muted">
          Times are in {timeZone}, the workspace clock. Nothing is sent to the customer.
        </p>
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {/* Who it is with, first. Required by 0166 and by the fact that a
          reminder has no address without it. */}
      <div className="space-y-1.5">
        <MonoLabel>Who is it with</MonoLabel>
        {lead ? (
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text">{lead.title}</span>
            <button
              type="button"
              className="text-sm text-accent hover:underline"
              onClick={() => {
                setLead(null);
                setQuery("");
              }}
            >
              Change
            </button>
          </div>
        ) : (
          <>
            <input
              className={`${FIELD} w-full max-w-md`}
              value={query}
              disabled={pending}
              placeholder="Search leads by name"
              onChange={(e) => setQuery(e.target.value)}
            />
            {hits.length > 0 ? (
              <ul className="max-w-md divide-y divide-border rounded-md border border-border">
                {hits.map((hit) => (
                  <li key={hit.id}>
                    <button
                      type="button"
                      className="w-full px-2 py-1.5 text-left text-sm text-text hover:bg-surface-muted"
                      onClick={() => setLead(hit)}
                    >
                      {hit.title}
                    </button>
                  </li>
                ))}
              </ul>
            ) : query.trim().length >= 2 ? (
              <span className="block text-xs text-text-muted">
                No leads match that. Appointments have to be against somebody on the Leads page.
              </span>
            ) : null}
          </>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="space-y-1.5">
          <MonoLabel>What for</MonoLabel>
          <input
            className={`${FIELD} w-full`}
            list="appointment-types"
            value={appointmentType}
            disabled={pending}
            onChange={(e) => setAppointmentType(e.target.value.toLowerCase())}
          />
          {/* A datalist, not a select: 0166 takes any well-formed key and
              refuses a CHECK, so the suggestions must not be a ceiling. */}
          <datalist id="appointment-types">
            {types.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>

        <label className="space-y-1.5">
          <MonoLabel>Date</MonoLabel>
          <input
            type="date"
            className={`${FIELD} w-full`}
            value={date}
            disabled={pending}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>

        <label className="space-y-1.5">
          <MonoLabel>Time</MonoLabel>
          <input
            type="time"
            className={`${FIELD} w-full`}
            value={time}
            disabled={pending}
            onChange={(e) => setTime(e.target.value)}
          />
        </label>

        <label className="space-y-1.5">
          <MonoLabel>How long</MonoLabel>
          <select
            className={`${FIELD} w-full`}
            value={minutes}
            disabled={pending}
            onChange={(e) => setMinutes(Number(e.target.value))}
          >
            {lengthOptions(defaultSlotMinutes).map((m) => (
              <option key={m} value={m}>
                {m} minutes
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1.5">
          <MonoLabel>Room, chair or person</MonoLabel>
          <select
            className={`${FIELD} w-full`}
            value={resourceId}
            disabled={pending}
            onChange={(e) => setResourceId(e.target.value)}
          >
            <option value="">Not against anything</option>
            {resources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.code} · {r.name}
              </option>
            ))}
          </select>
          <span className="block text-xs text-text-muted">
            {resources.length === 0
              ? "Add something under Bookable resources to reserve a room or a chair."
              : "Booking it here stops it being double-booked for this slot."}
          </span>
        </label>

        <label className="space-y-1.5">
          <MonoLabel>Where</MonoLabel>
          <input
            className={`${FIELD} w-full`}
            value={location}
            disabled={pending}
            placeholder="Optional"
            onChange={(e) => setLocation(e.target.value)}
          />
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm text-text">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={pending}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        They have already said yes to this time
      </label>

      <div className="flex gap-2 border-t border-border pt-3">
        <button
          type="button"
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-text hover:opacity-90 disabled:opacity-60"
          disabled={pending || !lead || !date}
          onClick={submit}
        >
          Book it
        </button>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-muted disabled:opacity-60"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </button>
      </div>
    </Card>
  );
}
