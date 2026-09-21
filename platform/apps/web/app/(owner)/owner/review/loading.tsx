import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** Complete class strings, so Tailwind can see every one. */
const PILL_W = ["w-20", "w-36", "w-40", "w-28"] as const;

/** A mixed queue, longest-waiting first: which body each card wears and how long its title runs. */
const CARDS = [
  { kind: "whatsapp", title: "w-44" },
  { kind: "duplicate", title: "w-64" },
  { kind: "optout", title: "w-96" },
  { kind: "whatsapp", title: "w-36" },
] as const;

type Kind = (typeof CARDS)[number]["kind"];

/** The source label is set in wide-tracked capitals, so its bar runs longer than its words. */
const SOURCE_W: Record<Kind, string> = {
  whatsapp: "w-28",
  optout: "w-32",
  duplicate: "w-36",
};

/** The buttons under each kind's body, left to right, as complete width classes. */
const ACTION_W: Record<Exclude<Kind, "duplicate">, readonly string[]> = {
  whatsapp: ["w-20", "w-14", "w-16"],
  optout: ["w-32", "w-28"],
};

/** A bar in a real line box, so the row is as tall as the text it stands in for. */
function TextLine({ line, bar }: { line: "h-4" | "h-5" | "h-6"; bar: string }) {
  return (
    <div className={`flex items-center ${line}`}>
      <Skeleton className={bar} />
    </div>
  );
}

/** A small button (`h-10` on a phone, `h-8` beside a cursor); `width` is a complete class. */
function ButtonSkeleton({ width }: { width: string }) {
  return <Skeleton className={`h-10 ${width} rounded-full sm:h-8`} />;
}

/** The line under the title: what the card is about, in the tiny type the frame sets it in. */
function MetaSkeleton({ kind }: { kind: Kind }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
      {kind === "whatsapp" ? (
        <>
          <TextLine line="h-4" bar="h-3 w-5" />
          <Skeleton className="h-5.5 w-14 rounded-full" />
          <TextLine line="h-4" bar="h-3 w-28" />
          <TextLine line="h-4" bar="h-3 w-16" />
        </>
      ) : null}
      {kind === "optout" ? (
        <>
          <TextLine line="h-4" bar="h-3 w-28" />
          <TextLine line="h-4" bar="h-3 w-16" />
        </>
      ) : null}
      {kind === "duplicate" ? <TextLine line="h-4" bar="h-3 w-24" /> : null}
    </div>
  );
}

/** Buttons on the left, and the "Read the conversation" link pushed to the far end. */
function ActionsSkeleton({ kind }: { kind: Exclude<Kind, "duplicate"> }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {ACTION_W[kind].map((width, i) => (
        <ButtonSkeleton key={i} width={width} />
      ))}
      <div className="ml-auto">
        <TextLine line="h-4" bar="h-3 w-32" />
      </div>
    </div>
  );
}

/** The part of the card that differs by source. */
function BodySkeleton({ kind }: { kind: Kind }) {
  if (kind === "whatsapp") {
    return (
      <>
        <TextLine line="h-5" bar="h-3.5 w-[30rem] max-w-full" />
        <div className="mt-1">
          <TextLine line="h-4" bar="h-3 w-[36rem] max-w-full" />
        </div>
        <ActionsSkeleton kind="whatsapp" />
      </>
    );
  }
  if (kind === "optout") {
    return (
      <>
        <div className="border-l-2 border-border-strong pl-3">
          <TextLine line="h-5" bar="h-3.5 w-[26rem] max-w-full" />
        </div>
        <div className="mt-2">
          <TextLine line="h-4" bar="h-3 w-[42rem] max-w-full" />
        </div>
        <ActionsSkeleton kind="optout" />
      </>
    );
  }
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        {["w-32", "w-40"].map((name) => (
          <div key={name} className="rounded-md border border-border p-3">
            <TextLine line="h-6" bar={`h-3.5 ${name}`} />
            <TextLine line="h-4" bar="h-3 w-44 max-w-full" />
            <div className="mt-2">
              <ButtonSkeleton width="w-28" />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <ButtonSkeleton width="w-32" />
      </div>
    </>
  );
}

/**
 * Mirrors review/page.tsx, whose section draws its own `space-y-4` root: the source
 * pills (All, then WhatsApp leads, Possible opt-outs and Duplicates, each with its
 * count), a blurb line, then the cards - a mix of the three kinds, longest-waiting
 * first. Every card is review-card.tsx's frame (a capitalised source label and how
 * long it has waited, a title, a meta line) over its own body: a WhatsApp lead's
 * intent and rationale with Approve / Edit / Reject, an opt-out's quoted message with
 * Confirm / Not an opt-out, or a duplicate's two record boxes with Keep this one.
 */
export default function ReviewLoading() {
  return (
    <>
      <PageHeader title="Review queue" context="Pipeline" />
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {PILL_W.map((width) => (
            <Skeleton key={width} className={`h-8 ${width} rounded-full`} />
          ))}
        </div>
        <TextLine line="h-5" bar="h-3.5 w-[42rem] max-w-full" />
        <ul className="space-y-3">
          {CARDS.map(({ kind, title }, i) => (
            <li key={i}>
              <article className="rounded-lg border border-border bg-surface p-4">
                <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <TextLine line="h-4" bar={`h-2.5 ${SOURCE_W[kind]}`} />
                  <TextLine line="h-4" bar="h-2.5 w-20" />
                </header>
                <div className="mt-1">
                  <TextLine line="h-6" bar={`h-4 ${title} max-w-full`} />
                </div>
                <MetaSkeleton kind={kind} />
                <div className="mt-3">
                  <BodySkeleton kind={kind} />
                </div>
              </article>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
