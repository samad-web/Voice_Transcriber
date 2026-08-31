"use server";

import { requireOperator } from "@/lib/operator-guard";
import { adminHeaders, API_URL, orgHeaders } from "@/lib/server-api";

export interface SearchResult {
  callId: string;
  startedAt: string;
  snippet: string;
  rank: number;
}

/**
 * Full-text search runs under one org context (RLS scopes the join to `calls`),
 * so without an explicit tenant it only ever searched the environment's dev
 * org - and reported "no transcripts matched" for every other customer, which
 * is indistinguishable from the term genuinely not appearing.
 *
 * Which is also why the caller may name any tenant - and why the operator check
 * has to happen *here*. A Server Action is its own POST endpoint; the
 * `(platform)` layout gate runs on a render and never on an invocation, so
 * without this line any signed-in account could search another customer's
 * transcripts by passing their org id (see lib/operator-guard.ts).
 */
export async function searchTranscriptsAction(
  q: string,
  orgId?: string,
): Promise<{ results?: SearchResult[]; error?: string }> {
  try {
    await requireOperator();
  } catch {
    // Generic on purpose: never confirm whether the named org exists, and never
    // distinguish "not signed in" from "signed in but not an operator".
    return { error: "Not authorized" };
  }
  const query = q.trim();
  if (!query) return { results: [] };
  try {
    const res = await fetch(`${API_URL}/v1/search?q=${encodeURIComponent(query)}`, {
      headers: orgId ? orgHeaders(orgId) : adminHeaders,
      cache: "no-store",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    const data = (await res.json()) as { results?: SearchResult[] };
    return { results: data.results ?? [] };
  } catch {
    return { error: "API unreachable - is `pnpm --filter @aura/api dev` running?" };
  }
}
