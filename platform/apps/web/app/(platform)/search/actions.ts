"use server";

import { adminHeaders, API_URL } from "@/lib/server-api";

export interface SearchResult {
  callId: string;
  startedAt: string;
  snippet: string;
  rank: number;
}

export async function searchTranscriptsAction(
  q: string,
): Promise<{ results?: SearchResult[]; error?: string }> {
  const query = q.trim();
  if (!query) return { results: [] };
  try {
    const res = await fetch(`${API_URL}/v1/search?q=${encodeURIComponent(query)}`, {
      headers: adminHeaders,
      cache: "no-store",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    const data = (await res.json()) as { results?: SearchResult[] };
    return { results: data.results ?? [] };
  } catch {
    return { error: "API unreachable — is `pnpm --filter @aura/api dev` running?" };
  }
}
