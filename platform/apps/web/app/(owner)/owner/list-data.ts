import "server-only";
import { ownerGet } from "@/lib/owner-context";
import type { MemberOption } from "./list-options";
import type { RecordTag } from "./types";

/**
 * The data behind the list views' filter selects, for SERVER pages.
 *
 * Kept apart from list-options.ts on purpose: that file is imported by client
 * components (leads-table.tsx), and `ownerGet` reads the session through
 * next/headers - one import of it from a client module fails the whole page's
 * build, which typecheck does not see (caught in the Phase 5 browser run).
 */

/**
 * The org's members, one row per person. `[]` on failure - an owner filter
 * without names still offers Mine and Unassigned.
 */
export async function loadMembers(): Promise<MemberOption[]> {
  const data = await ownerGet<{ members: MemberOption[] }>("/v1/members");
  const seen = new Set<string>();
  const members: MemberOption[] = [];
  for (const m of data?.members ?? []) {
    if (seen.has(m.userId)) continue;
    seen.add(m.userId);
    members.push(m);
  }
  return members.sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));
}

/** `/v1/tags` - the org's live tag vocabulary. `[]` on failure. */
export async function loadTags(): Promise<RecordTag[]> {
  const data = await ownerGet<{ tags: RecordTag[] }>("/v1/tags");
  return data?.tags ?? [];
}
