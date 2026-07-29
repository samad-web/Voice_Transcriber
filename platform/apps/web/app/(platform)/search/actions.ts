"use server";

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
 * org — and reported "no transcripts matched" for every other customer, which
 * is indistinguishable from the term genuinely not appearing.
 */
export async function searchTranscriptsAction(
  q: string,
  orgId?: string,
): Promise<{ results?: SearchResult[]; error?: string }> {
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
    return { error: "API unreachable — is `pnpm --filter @aura/api dev` running?" };
  }
}
