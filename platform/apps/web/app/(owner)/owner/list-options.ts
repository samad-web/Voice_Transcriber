import { LeadSourceChannel } from "@aura/shared";
import { SOURCE_CHANNELS } from "@/lib/source-channel";
import type { RecordTag } from "./types";

/**
 * Option lists for the list views' filter selects (list-filters.tsx).
 *
 * PURE - imported by server pages AND client components (leads-table.tsx), so
 * nothing here may touch the session. The fetches that fill these live in
 * list-data.ts, which is server-only.
 */

export interface FilterOption {
  value: string;
  label: string;
}

export interface MemberOption {
  userId: string;
  name: string | null;
  email: string;
}

/**
 * Whose records: anyone, mine, nobody's, or one named person. `me` is resolved
 * by the API from the session, so a saved "Mine" view follows whoever opens it.
 */
export function ownerOptions(
  members: readonly MemberOption[],
  labels: { any: string; none: string } = { any: "Anyone", none: "No owner" },
): FilterOption[] {
  return [
    { value: "", label: labels.any },
    { value: "me", label: "Mine" },
    { value: "none", label: labels.none },
    ...members.map((m) => ({ value: m.userId, label: m.name ?? m.email })),
  ];
}

export function tagOptions(tags: readonly RecordTag[]): FilterOption[] {
  return [{ value: "", label: "Any tag" }, ...tags.map((t) => ({ value: t.id, label: t.name }))];
}

/** First-touch channel, in the words lib/source-channel.ts uses on the record's tag. */
export const CHANNEL_OPTIONS: readonly FilterOption[] = [
  { value: "", label: "Any channel" },
  ...LeadSourceChannel.options.map((value) => ({ value, label: SOURCE_CHANNELS[value].label })),
  // Records from before migration 0078 recorded a channel.
  { value: "none", label: "Not recorded" },
];

/** Keep a URL value selectable even when the option list no longer has it (a deleted tag, a departed member). */
export function withCurrent(options: FilterOption[], current: string | undefined, label = "(no longer available)"): FilterOption[] {
  if (!current || options.some((o) => o.value === current)) return options;
  return [...options, { value: current, label }];
}
