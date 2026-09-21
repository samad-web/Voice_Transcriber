import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { IntroSkeleton, TabsSkeleton } from "@/components/skeletons";

/** Complete class strings, picked by index, so Tailwind can see every one. */
const FILTER_W = ["w-20", "w-28", "w-36", "w-32"] as const;
const LEAD_NAME = ["w-40", "w-32", "w-44", "w-36"] as const;
const LEAD_CONTACT = ["w-72", "w-64", "w-80", "w-60"] as const;
const LEAD_STAMP = ["w-52", "w-48", "w-56", "w-44"] as const;
const LEAD_ANSWERS = ["w-44", "w-40", "w-48", "w-36"] as const;

/**
 * One enquiry: a name with its funnel-verdict chip, email and phone, when they
 * came in, the "show the answers" link - and Reject / Delete / Convert to client
 * on the right. The page's leads are cards, not table rows.
 */
function LeadCardSkeleton({ i }: { i: number }) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex h-6 items-center gap-2">
            <Skeleton className={`h-4 ${LEAD_NAME[i % LEAD_NAME.length]}`} />
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
          <div className="mt-1 flex h-5 items-center">
            <Skeleton className={`h-3.5 ${LEAD_CONTACT[i % LEAD_CONTACT.length]} max-w-full`} />
          </div>
          <div className="mt-1 flex h-4 items-center">
            <Skeleton className={`h-3 ${LEAD_STAMP[i % LEAD_STAMP.length]} max-w-full`} />
          </div>
          <div className="mt-3 flex h-4 items-center">
            <Skeleton className={`h-3 ${LEAD_ANSWERS[i % LEAD_ANSWERS.length]} max-w-full`} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Skeleton className="h-10 w-20 rounded-md" />
          <Skeleton className="h-10 w-14 rounded-md" />
          <Skeleton className="h-10 w-36 rounded-full" />
        </div>
      </div>
    </Card>
  );
}

/**
 * Mirrors leads/page.tsx: intro copy, then the three-tab strip (Leads,
 * Messages, Qualification) over the Leads tab - four count-filter buttons, the
 * bulk-delete strip, the "Check WhatsApp" button, and a stack of lead cards.
 * The Messages and Qualification panels are hidden until picked, so they are
 * not drawn. The two wrappers are the page's own (LeadsTabs, LeadsTable) and
 * carry its 16px / 12px gaps.
 */
export default function LeadsLoading() {
  return (
    <>
      <PageHeader title="Funnel Leads" context="Platform" />
      <IntroSkeleton lines={2} />

      <div className="flex flex-col gap-4">
        <TabsSkeleton tabs={3} />

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-1.5">
            {FILTER_W.map((w, i) => (
              <Skeleton key={i} className={`h-9 rounded-md ${w}`} />
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-bg-subtle px-4 py-3">
            <Skeleton className="h-3 w-full max-w-xl" />
            <Skeleton className="h-9 w-24 shrink-0 rounded-md" />
          </div>

          <Skeleton className="h-9 w-52 rounded-md" />

          {[0, 1, 2, 3].map((i) => (
            <LeadCardSkeleton key={i} i={i} />
          ))}
        </div>
      </div>
    </>
  );
}
