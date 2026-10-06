import { z } from "zod";

/**
 * The `resources` primitive (migration 0165, Build docs/39 §23-§24).
 *
 * One table for a flat, a vehicle, a chair, a seat in a batch and a departure
 * date, because all five are the same thing: something enumerated, finite and
 * holdable. §23's refusal of ten industry products is the whole reason this
 * file is small - there is no per-vertical branch anywhere in it, and a grep
 * for a pack id outside the suggestion table below should return nothing.
 *
 * ── WHAT IS A TWIN OF A DATABASE CHECK, AND WHAT IS NOT ────────────────────
 *
 * `ResourceStatus` is a twin of 0165's CHECK and `resources.test.ts` pins the
 * two equal, once as a transcribed literal and once read out of the migration
 * file - the two fail in opposite directions, and `notifications.kind` is the
 * precedent for why one of them alone is not enough.
 *
 * `resource_type` is NOT such a twin and must never become one. There is no
 * CHECK on its value in the database and there is no closed enum here. A CHECK
 * would be the enum of industries §23 exists to avoid, and the eighth tenant
 * would need a migration to sell a thing the list had not imagined.
 */

/** Twin of `resources.status`'s CHECK in migration 0165. Both move together. */
export const ResourceStatus = z.enum([
  /** Free, or partly booked with capacity still left. */
  "available",
  /** Reserved for one lead until `held_until`. The hold sweep releases it. */
  "held",
  /** `booked_count` has reached `capacity`. */
  "booked",
  /** Terminal for a one-off item: a flat that has been sold, not merely booked. */
  "sold",
  /** Temporarily out of service - a chair under repair, a bay being painted. */
  "unavailable",
  /** Gone from the inventory. Frees the code for re-use; never deleted. */
  "retired",
]);
export type ResourceStatus = z.infer<typeof ResourceStatus>;

/**
 * Statuses a person may set by hand.
 *
 * `held` and `booked` are absent deliberately: both are produced by a
 * TRANSITION that does more than set a column - a hold writes an expiry and a
 * holder, a booking increments `booked_count` under a row lock - and letting a
 * PATCH assert either would be the way `booked_count` drifts away from the
 * truth. The routes for those are `/hold` and `/book`.
 */
export const ResourceManualStatus = z.enum(["available", "sold", "unavailable", "retired"]);
export type ResourceManualStatus = z.infer<typeof ResourceManualStatus>;

/**
 * The shape of a `resource_type`, which IS constrained even though the set is
 * not.
 *
 * A snake_case key, because the console groups, filters and counts by it. The
 * human LABEL belongs to the tenant and to their stage pack - somebody
 * renaming "unit" to "flat" on screen must not have to re-key their stock.
 */
export const ResourceTypeKey = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, "a lower-case key like `unit` or `demo_class`");
export type ResourceTypeKey = z.infer<typeof ResourceTypeKey>;

/**
 * What the console OFFERS, per stage pack - never what the database enforces.
 *
 * ── §24'S TABLE NAMES NINE INDUSTRIES THAT DO NOT EXIST HERE ───────────────
 *
 * §24 tabulates healthcare / automobile / salon / fitness / home services /
 * education / property / travel / events. `packages/shared/src/stage-packs.ts`
 * ships SEVEN packs and §22 of the same document says so: clinic, property,
 * services, education, retail, finance, general. Those seven are what
 * onboarding actually asks and what `suggestPack()` actually returns, so they
 * are what this map is keyed on; §24's nine are folded into them (salon and
 * fitness are `clinic`'s neighbours in the pack vocabulary, automobile and
 * travel land in `retail`, home services in `services`).
 *
 * This is a SUGGESTION LIST. The API accepts any well-formed key, and the
 * tenant's real list is this union-ed with the types already in use for their
 * org - which is what "validated against the tenant's own list" means in a
 * design that refuses a CHECK.
 */
export const RESOURCE_TYPE_SUGGESTIONS: Readonly<Record<string, readonly string[]>> = {
  // A chair, a room, a scanner - and the salon/fitness neighbours, where one
  // row is a station or an 07:00 class with capacity 25.
  clinic: ["chair", "room", "scanner", "station", "class"],
  // project -> tower -> floor -> unit, all one self-referencing column.
  property: ["project", "tower", "floor", "unit", "plot"],
  // An install crew is capacity 1 per day; a bay is a place the van goes.
  services: ["crew", "bay", "slot"],
  // A batch of 40 is capacity 40. That is the whole of the modelling.
  education: ["batch", "course", "classroom", "seat"],
  // Automobile and travel fold in here: a VIN is one vehicle, a 14 Oct Bali
  // departure is capacity 18.
  retail: ["vehicle", "bay", "departure", "stock_item"],
  // A finance desk books people, not things; an advisor's diary is the unit.
  finance: ["advisor", "slot"],
  general: ["item", "slot", "date"],
};

/**
 * The suggestions for a pack, or the general pack's when the id is unknown.
 *
 * Unknown rather than throwing: a tenant whose `stage_pack` was set before a
 * pack was renamed must still get a picker, and an empty one reads as a broken
 * screen.
 */
export function resourceTypeSuggestions(packId: string | null | undefined): readonly string[] {
  if (!packId) return RESOURCE_TYPE_SUGGESTIONS.general;
  return RESOURCE_TYPE_SUGGESTIONS[packId] ?? RESOURCE_TYPE_SUGGESTIONS.general;
}

/**
 * The tenant's own list: what they already use, plus what their pack offers.
 *
 * In-use types come FIRST and in their own order, because a tenant who has
 * typed `villa` wants to see `villa` at the top of the picker rather than
 * hunting for it under five suggestions they never took.
 */
export function tenantResourceTypes(
  inUse: readonly string[],
  packId: string | null | undefined,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const type of [...inUse, ...resourceTypeSuggestions(packId)]) {
    const key = type.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * How long a hold lasts, per type.
 *
 * §24: "2-7 days for a property unit, closer to 2 hours for a salon station."
 * The window is a property of what is being held rather than of the tenant,
 * because it is really a property of how long the decision takes - nobody
 * deliberates for three days over a haircut, and nobody buys a flat in two
 * hours.
 *
 * A caller may override within `MAX_HOLD_HOURS`. The cap exists because a hold
 * is inventory taken off the market with nobody paying for it: an unbounded
 * one is a sales rep quietly reserving the whole tower.
 */
export const DEFAULT_HOLD_HOURS: Readonly<Record<string, number>> = {
  unit: 48,
  plot: 48,
  project: 48,
  tower: 48,
  floor: 48,
  vehicle: 24,
  departure: 24,
  batch: 24,
  seat: 24,
  course: 24,
  classroom: 24,
  stock_item: 24,
  advisor: 4,
  crew: 4,
  bay: 4,
  room: 4,
  scanner: 4,
  station: 2,
  chair: 2,
  class: 2,
  slot: 2,
  item: 24,
  date: 24,
};

/** Anything not in the table above. A day is long enough to call somebody back. */
export const FALLBACK_HOLD_HOURS = 24;

/** Seven days, which is the top of §24's own range for a property unit. */
export const MAX_HOLD_HOURS = 24 * 7;

export function holdWindowHours(resourceType: string): number {
  return DEFAULT_HOLD_HOURS[resourceType.trim().toLowerCase()] ?? FALLBACK_HOLD_HOURS;
}

/**
 * When a hold placed at `from` on this type expires.
 *
 * Takes the instant explicitly - no hidden `new Date()` - for the reason
 * quiet-hours.ts gives: the boundary is the whole behaviour, and a boundary you
 * cannot test without fake timers is a boundary nobody tests.
 */
export function holdExpiresAt(resourceType: string, from: Date, hours?: number): Date {
  const requested = hours ?? holdWindowHours(resourceType);
  const clamped = Math.min(Math.max(requested, 1), MAX_HOLD_HOURS);
  return new Date(from.getTime() + clamped * 60 * 60 * 1000);
}

/**
 * How many are left.
 *
 * Clamped at zero rather than returning a negative: `resources_not_oversold`
 * makes a negative impossible in the database, so a negative here could only
 * come from a caller passing the two arguments in the wrong order, and
 * rendering "-3 available" is worse than rendering "0".
 */
export function remainingCapacity(capacity: number, bookedCount: number): number {
  return Math.max(0, capacity - bookedCount);
}

/**
 * Can one more be booked right now?
 *
 * `held` counts as bookable: a hold exists so that the person holding it can
 * convert it, and the booking route clears the hold as it goes. The route
 * checks WHOSE hold it is; this predicate only answers whether the row is in a
 * state that admits a booking at all.
 */
export function isBookable(row: {
  status: string;
  capacity: number;
  bookedCount: number;
}): boolean {
  if (row.status !== "available" && row.status !== "held") return false;
  return remainingCapacity(row.capacity, row.bookedCount) > 0;
}

/**
 * Has this hold run out, as of `now`?
 *
 * The sweep asks the database this question rather than calling in - it exists
 * so a hold expires while nobody is looking. This is the console's copy, for
 * greying out a row that the next sweep will release.
 */
export function isHoldExpired(
  row: { status: string; heldUntil: Date | string | null },
  now: Date,
): boolean {
  if (row.status !== "held" || !row.heldUntil) return false;
  const until = row.heldUntil instanceof Date ? row.heldUntil : new Date(row.heldUntil);
  return until.getTime() <= now.getTime();
}
