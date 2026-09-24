import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** The vocabulary chips, in the varied lengths a glossary of names really has. */
const TERM_W = ["w-24", "w-32", "w-20", "w-28", "w-16", "w-36", "w-24", "w-20"] as const;

/** Help text under a control: `text-xs leading-relaxed`, about 20px a line, last line short. */
function HintLines({ lines }: { lines: number }) {
  return (
    <div>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="flex h-5 items-center">
          <Skeleton className={i === lines - 1 ? "h-3 w-2/3" : "h-3 w-full"} />
        </div>
      ))}
    </div>
  );
}

/** A label, a full-width dropdown, and the line of help under it. */
function SelectField({ label, hint }: { label: string; hint: number }) {
  return (
    <div className="space-y-1.5">
      <div className="flex h-4 items-center">
        <Skeleton className={`h-3 ${label}`} />
      </div>
      <Skeleton className="h-9.5 w-full rounded-sm" />
      <HintLines lines={hint} />
    </div>
  );
}

/**
 * Mirrors transcription/page.tsx: one elevated settings card holding the
 * language dropdown, the transcript-style dropdown and the "Names & terms"
 * block (help text, an add-a-term input beside its button, the chips already
 * added, the "N of M" count), closed by the Save settings footer. The optional
 * "transcription is off" notice above the card is not drawn.
 */
export default function TranscriptionLoading() {
  return (
    <>
      <PageHeader title="Transcripts" context="Settings" />

      <Card elevated className="max-w-2xl space-y-6">
        <div className="flex h-4 items-center">
          <Skeleton className="h-3 w-40" />
        </div>

        <SelectField label="w-28" hint={2} />
        <SelectField label="w-28" hint={2} />

        <div className="space-y-2">
          <div className="flex h-4 items-center">
            <Skeleton className="h-3 w-28" />
          </div>
          <HintLines lines={3} />
          <div className="flex gap-2">
            <Skeleton className="h-10 flex-1 rounded-sm" />
            <Skeleton className="h-10 w-20 rounded-full" />
          </div>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {TERM_W.map((w, i) => (
              <Skeleton key={i} className={`h-6.5 rounded-full ${w}`} />
            ))}
          </div>
          <Skeleton className="h-3 w-12" />
        </div>

        <div className="border-t border-border pt-4">
          <Skeleton className="h-10 w-32 rounded-full" />
        </div>
      </Card>
    </>
  );
}
