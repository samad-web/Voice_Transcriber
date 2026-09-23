import { resolveTimeZone } from "@aura/shared";
import { getOwner } from "./owner-context";

/**
 * The workspace's time zone, for Server Components (Build docs/30). Reads the
 * membership `getOwner()` already resolved for this request - React-cached, so
 * it costs nothing extra - and falls back to the deployment default rather
 * than the server's own zone.
 *
 * SERVER ONLY. It reaches `owner-context`, which reads request headers; a
 * Client Component that imported this would 500 its page (the trap recorded in
 * the Phase 5 notes). Client Components call `useOrgTimeZone()` instead.
 */
export async function getOrgTimeZone(): Promise<string> {
  const owner = await getOwner();
  return resolveTimeZone(owner?.membership.reportingTimezone);
}
