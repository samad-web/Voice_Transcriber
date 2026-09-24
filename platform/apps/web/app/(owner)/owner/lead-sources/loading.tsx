import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** The line box a text size occupies: `text-xs` 16px, `text-sm` 20px, `leading-relaxed` 22.75px. */
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

/** Line counts and last-line lengths are measured from Inter's own advance widths, not guessed. */
const INTRO = ["h-3.5 w-full", "h-3.5 w-full", "h-3.5 w-full", "h-3.5 w-1/5"] as const;
const SHEETS_BLURB = ["h-3.5 w-full", "h-3.5 w-2/5"] as const;
const URL_NOTE = ["h-3 w-4/5"] as const;
const SNIPPET_NOTE = ["h-3 w-full", "h-3 w-1/3"] as const;
const LINKEDIN_BLURB = ["h-3.5 w-full", "h-3.5 w-3/4"] as const;
const INBOX_INTRO = ["h-3.5 w-full", "h-3.5 w-full", "h-3.5 w-2/3"] as const;
const INBOX_ADVICE = ["h-3.5 w-full", "h-3.5 w-3/4"] as const;

/** The shaded hairline box the paste-in snippet and the how-to text each sit in. */
const SHADED_BOX = "rounded-md border border-border bg-surface-hover p-3";

/** The pasted snippet, line by line: indentation and length vary the way markup and script do. */
const CODE_LINES = [
  "w-48",
  "ml-4 w-96",
  "ml-4 w-100",
  "ml-4 w-76",
  "ml-4 w-120",
  "ml-4 w-116",
  "ml-4 w-128",
  "ml-4 w-64",
  "w-12",
  "w-14",
  "w-3/5",
  "ml-4 w-40",
] as const;

/**
 * The Google Sheet card that sits above the channel list: its "Google Sheet"
 * label, a two-line blurb, then the spreadsheet-link input beside "Look inside".
 */
function SheetsPanelSkeleton() {
  return (
    <Card className="space-y-4">
      <div className="flex h-4 items-center">
        <Skeleton className="h-3 w-24" />
      </div>
      <div className="space-y-3">
        <TextLines line="h-[22.75px]" bars={SHEETS_BLURB} className="max-w-xl" />
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-10 min-w-0 flex-1 rounded-sm" />
          <Skeleton className="h-10 w-28 shrink-0 rounded-full" />
        </div>
      </div>
    </Card>
  );
}

/**
 * One lead source as `SourceCard` draws it: its name with a status chip over a
 * "channel - N leads from N arrivals" line, "Recent arrivals" and "Pause" at the
 * right, the endpoint URL in a code box with its Copy / Rotate buttons and the
 * credential warning, then either the paste-into-your-site snippet (`form`) or a
 * shaded how-to-connect box (`inbox`), and the token line last.
 */
function SourceCardSkeleton({ variant }: { variant: "form" | "inbox" }) {
  const form = variant === "form";
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex h-6 items-center gap-2">
            <Skeleton className={form ? "h-4 w-36" : "h-4 w-44"} />
            <Skeleton className="h-6 w-16 rounded-full" />
          </div>
          <div className="mt-1 flex h-5 items-center">
            <Skeleton className={form ? "h-3.5 w-72 max-w-full" : "h-3.5 w-64 max-w-full"} />
          </div>
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-10 w-36 rounded-full" />
          <Skeleton className="h-10 w-18 rounded-full" />
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <div>
          <div className="flex h-4 items-center">
            <Skeleton className="h-3 w-16" />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Skeleton className="h-[34px] min-w-0 flex-1 rounded-md" />
            <Skeleton className="h-10 w-24 shrink-0 rounded-full" />
            <Skeleton className="h-10 w-28 shrink-0 rounded-full" />
          </div>
          <TextLines line="h-4" bars={URL_NOTE} className="mt-1" />
        </div>

        {form ? (
          <div>
            <div className="flex h-4 items-center">
              <Skeleton className="h-3 w-44" />
            </div>
            <div className={`mt-1 h-64 overflow-hidden ${SHADED_BOX}`}>
              {CODE_LINES.map((bar, i) => (
                <div key={i} className="flex h-[19.5px] items-center">
                  <Skeleton className={`h-2.5 max-w-full ${bar}`} />
                </div>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <Skeleton className="h-10 w-32 rounded-full" />
            </div>
            <TextLines line="h-4" bars={SNIPPET_NOTE} className="mt-1" />
          </div>
        ) : (
          <div className={SHADED_BOX}>
            <div className="flex h-5 items-center">
              <Skeleton className="h-3.5 w-64" />
            </div>
            <TextLines line="h-5" bars={INBOX_INTRO} className="mt-1" />
            <TextLines line="h-5" bars={INBOX_ADVICE} className="mt-2" />
          </div>
        )}
      </div>

      <div className="mt-4 flex h-4 items-center">
        <Skeleton className="h-3 w-56" />
      </div>
    </Card>
  );
}

/**
 * The LinkedIn Lead Gen Forms card that closes the page: a title over a
 * two-line explanation, with "Connect LinkedIn" at the right.
 */
function LinkedInPanelSkeleton() {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex h-6 items-center">
            <Skeleton className="h-4 w-52" />
          </div>
          <TextLines line="h-5" bars={LINKEDIN_BLURB} className="mt-1 max-w-xl" />
        </div>
        <Skeleton className="h-10 w-40 shrink-0 rounded-full" />
      </div>
    </Card>
  );
}

/**
 * Mirrors lead-sources/page.tsx: a four-line intro under the header, the Google
 * Sheet card, then the client's own `space-y-6` column - a "N sources" count
 * beside "Add a source", one card per configured source (a web form with its
 * paste-in snippet, an enquiry inbox with its how-to box) and the LinkedIn card.
 */
export default function LeadSourcesLoading() {
  return (
    <>
      <PageHeader title="Lead sources" context="Settings" />
      <TextLines line="h-5" bars={INTRO} className="-mt-2 max-w-2xl" />
      <SheetsPanelSkeleton />
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex h-4 items-center">
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="h-10 w-32 rounded-full" />
        </div>
        <SourceCardSkeleton variant="form" />
        <SourceCardSkeleton variant="inbox" />
        <LinkedInPanelSkeleton />
      </div>
    </>
  );
}
