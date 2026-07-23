"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { FileText, Search } from "lucide-react";
import { BrutalButton, Card, MonoLabel, StatusChip } from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import { searchTranscriptsAction, type SearchResult } from "./actions";
import { inputClass } from "@/lib/form";

/**
 * Renders a ts_headline snippet safely: `<b>…</b>` highlight spans become bold
 * marks and any other stray tags are stripped. No dangerouslySetInnerHTML.
 */
function Highlight({ snippet }: { snippet: string }) {
  const parts = snippet.split(/(<b>[\s\S]*?<\/b>)/g);
  return (
    <>
      {parts.map((part, i) => {
        const match = part.match(/^<b>([\s\S]*?)<\/b>$/);
        if (match) {
          return (
            <mark key={i} className="bg-black text-white px-0.5 rounded-none">
              {match[1]}
            </mark>
          );
        }
        return <span key={i}>{part.replace(/<[^>]*>/g, "")}</span>;
      })}
    </>
  );
}

export function SearchExplorer() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [pending, startTransition] = useTransition();

  const run = () =>
    startTransition(async () => {
      setError(null);
      const res = await searchTranscriptsAction(q);
      setSearched(true);
      if (res.error) {
        setError(res.error);
        setResults(null);
      } else {
        setResults(res.results ?? []);
      }
    });

  return (
    <div className="space-y-6">
      <Card shadow className="space-y-4">
        <div className="flex items-center gap-2">
          <Search className="h-4 w-4" />
          <h4 className="text-lg font-display font-black text-black uppercase tracking-tight">
            Full-Text Transcript Search
          </h4>
        </div>
        <p className="text-xs text-neutral-400 font-sans font-medium">
          Search every diarized transcript across the workspace. Matches are ranked and
          highlighted from the call record.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            run();
          }}
          className="flex flex-col sm:flex-row gap-3"
        >
          <input
            className={`${inputClass} flex-1`}
            placeholder="e.g. refund, cancellation, competitor pricing…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <BrutalButton shadow type="submit" disabled={pending || !q.trim()}>
            <Search className="h-4 w-4" />
            {pending ? "SEARCHING…" : "SEARCH"}
          </BrutalButton>
        </form>

        {error ? (
          <p className="text-xs text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-3">
            {error}
          </p>
        ) : null}
      </Card>

      {results !== null ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <MonoLabel>Results</MonoLabel>
            <StatusChip tone="muted">{results.length} match{results.length === 1 ? "" : "es"}</StatusChip>
          </div>

          {results.length === 0 ? (
            <Card className="flex flex-col items-center py-12 gap-3">
              <FileText className="h-8 w-8 text-neutral-300" />
              <p className="text-xs font-mono font-bold uppercase text-neutral-400">
                {searched ? "No transcripts matched that query" : "Run a search to see results"}
              </p>
            </Card>
          ) : (
            results.map((r) => (
              <Link key={r.callId} href="/calls" className="block">
                <Card className="hover:bg-neutral-50 transition-colors space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-xs font-bold text-black">
                      #{r.callId.slice(0, 8)}
                    </span>
                    <span className="text-[10px] text-neutral-400 font-mono">
                      <LocalTime iso={r.startedAt} />
                    </span>
                  </div>
                  <p className="text-xs font-sans leading-relaxed text-neutral-700">
                    <Highlight snippet={r.snippet} />
                  </p>
                  <span className="text-[9px] font-mono font-bold uppercase tracking-wider text-neutral-400">
                    rank {r.rank.toFixed(4)} · open in Call Log →
                  </span>
                </Card>
              </Link>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
