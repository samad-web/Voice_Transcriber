import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** The line box a text size occupies: `text-xs` 16px, `text-sm` 20px, `text-sm` relaxed 22.75px. */
type LineBox = "h-4" | "h-5" | "h-[22.75px]";

/**
 * Lines of text as the browser lays them out: one bar per line, each centred in
 * the line box the words would fill, so a paragraph is as tall as the real one.
 * `bars` are complete class strings; the last is short, the way a paragraph ends.
 */
function TextLines({
  line,
  bars,
  className = "",
}: {
  line: LineBox;
  bars: readonly string[];
  className?: string;
}) {
  return (
    <div className={className}>
      {bars.map((bar, i) => (
        <div key={i} className={`flex items-center ${line}`}>
          <Skeleton className={bar} />
        </div>
      ))}
    </div>
  );
}

const SIGN_IN_COPY = ["h-3.5 w-full", "h-3.5 w-11/12"] as const;
const MCP_BLURB = ["h-3.5 w-full", "h-3.5 w-full", "h-3.5 w-11/12"] as const;

/** One `FormField`: a `text-sm` label line, a 6px gap, then a 38px input. */
function FieldSkeleton({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-5 items-center">
        <Skeleton className={label} />
      </div>
      <Skeleton className="h-9.5 w-full rounded-sm" />
    </div>
  );
}

/**
 * The "Meta via MCP" card as mcp-connect.tsx draws a connected server: a plug
 * icon, the label and a status chip; a three-line blurb; the server-URL and
 * access-token fields; Save & reconnect, Test connection and Disconnect; and a
 * rule over the Server / Last sync pair.
 */
function McpCardSkeleton() {
  return (
    <Card elevated className="max-w-2xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Skeleton className="size-4 shrink-0" />
          <Skeleton className="h-3 w-24" />
        </div>
        <Skeleton className="h-[22px] w-24 rounded-full" />
      </div>

      <TextLines line="h-[22.75px]" bars={MCP_BLURB} />

      <FieldSkeleton label="h-3.5 w-28" />
      <FieldSkeleton label="h-3.5 w-80 max-w-full" />

      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-10 w-36 rounded-full" />
        <Skeleton className="h-10 w-32 rounded-full" />
        <Skeleton className="h-10 w-26 rounded-full" />
      </div>

      <div className="grid grid-cols-2 gap-3 border-t border-border pt-3">
        <div>
          <div className="flex h-4 items-center">
            <Skeleton className="h-2.5 w-12" />
          </div>
          <div className="mt-0.5 flex h-4 items-center">
            <Skeleton className="h-3 w-28" />
          </div>
        </div>
        <div>
          <div className="flex h-4 items-center">
            <Skeleton className="h-2.5 w-16" />
          </div>
          <div className="mt-0.5 flex h-4 items-center">
            <Skeleton className="h-3 w-36" />
          </div>
        </div>
      </div>
    </Card>
  );
}

/**
 * Mirrors meta-ads/page.tsx: one paragraph of copy under the header, the two
 * door buttons into the Integrations store (connect, and the connected Pages),
 * and the "Meta via MCP" card - status chip, blurb, URL and token fields,
 * three buttons, a details strip.
 */
export default function MetaAdsLoading() {
  return (
    <>
      <PageHeader title="Meta Lead Ads" context="Settings" />
      <TextLines line="h-5" bars={SIGN_IN_COPY} className="max-w-2xl" />
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-10 w-48 rounded-full" />
        <Skeleton className="h-10 w-36 rounded-full" />
      </div>
      <McpCardSkeleton />
    </>
  );
}
