import { NextResponse } from "next/server";
import { SEARCH_MAX_CHARS, SEARCH_MIN_CHARS, type GlobalSearchResponse } from "@/lib/global-search";
import { searchSourceFor } from "@/lib/crm-search";
import { getOwner } from "@/lib/owner-context";

/**
 * The header's global search: contacts, deals and activity notes in one call.
 *
 * A Route Handler rather than a Server Action because this is typed into.
 * Server Actions from one client run one at a time, so a fast typist would
 * queue a request per keystroke behind the slowest; a plain GET can be aborted
 * by the component the moment a newer query supersedes it.
 *
 * SECURITY: the tenant, persona and user come from the session (`getOwner`),
 * never from the request - the only input is `q`. Every upstream call carries
 * the API's own permission grid and `owned` row scope, so this proxy
 * authenticates AND inherits authorization rather than replacing it.
 */
export async function GET(request: Request) {
  const query = (new URL(request.url).searchParams.get("q") ?? "").trim();

  if (query.length < SEARCH_MIN_CHARS || query.length > SEARCH_MAX_CHARS) {
    return NextResponse.json({ query, groups: [], unavailable: [] } satisfies GlobalSearchResponse);
  }

  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Not signed in as an instance owner" }, { status: 401 });
  }

  const result = await searchSourceFor(owner.membership).search(query, owner);
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}
