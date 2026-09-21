import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** Complete class strings, picked by index, so the cards are not copies of one another. */
const NAME_BAR = ["h-3.5 w-24", "h-3.5 w-32", "h-3.5 w-20", "h-3.5 w-28"] as const;
const BADGE_BAR = [
  "h-6 w-24 rounded-full",
  "h-6 w-20 rounded-full",
  "h-6 w-28 rounded-full",
  "h-6 w-24 rounded-full",
] as const;
const BLURB_BAR = ["h-3 w-2/3", "h-3 w-1/2", "h-3 w-3/4", "h-3 w-3/5"] as const;

/** The categories in catalogue order - Messaging, Lead sources, Payments, Telephony - with their card counts. */
const SECTIONS = [
  { label: "h-3 w-20", cards: 4 },
  { label: "h-3 w-24", cards: 4 },
  { label: "h-3 w-16", cards: 2 },
  { label: "h-3 w-20", cards: 2 },
] as const;

/**
 * One category of integrations, as integrations/page.tsx draws it: the
 * category's label over a two-column grid of link cards, each a name with its
 * status chip and a two-line blurb.
 */
function IntegrationSectionSkeleton({
  label,
  cards,
  start,
}: {
  label: string;
  cards: number;
  start: number;
}) {
  return (
    <section className="space-y-2">
      <Skeleton className={label} />
      <div className="grid gap-2 md:grid-cols-2">
        {Array.from({ length: cards }, (_, i) => (
          <div key={i} className="rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Skeleton className={NAME_BAR[(start + i) % NAME_BAR.length]} />
              <Skeleton className={BADGE_BAR[(start + i) % BADGE_BAR.length]} />
            </div>
            <div className="mt-2 space-y-2">
              <Skeleton className="h-3 w-full" />
              <Skeleton className={BLURB_BAR[(start + i) % BLURB_BAR.length]} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Mirrors integrations/page.tsx: a short explainer tucked up under the header,
 * then one section per category of integration (Messaging, Lead sources,
 * Payments, Telephony, Email & calendar), each a label over a two-column grid
 * of link cards - the integration's name, its connected / not connected chip
 * and a blurb. The fifth, smallest category is below the fold and left out.
 */
export default function IntegrationsLoading() {
  return (
    <>
      <PageHeader title="Integrations" context="Workspace" />

      <div className="-mt-2 max-w-prose space-y-2.5">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-1/5" />
      </div>

      {SECTIONS.map((section, i) => (
        <IntegrationSectionSkeleton key={i} label={section.label} cards={section.cards} start={i} />
      ))}
    </>
  );
}
