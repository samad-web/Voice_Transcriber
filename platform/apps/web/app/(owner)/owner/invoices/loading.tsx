import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { FilterTableSkeleton } from "@/components/skeletons";

/**
 * payment-settings.tsx in its resting shape: a label and a two-line blurb on
 * the left, the gateway chip and a Change/Connect button on the right. Owner-only
 * (a manager gets no card), and a tenant with no Razorpay keys yet gets it open,
 * with its form showing.
 */
function PaymentCardSkeleton() {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="w-full max-w-xl">
          <div className="flex h-4 items-center">
            <Skeleton className="h-3 w-28" />
          </div>
          <div className="mt-2 space-y-1.5">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-2/3" />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Skeleton className="h-6 w-32 rounded-full" />
          <Skeleton className="h-8 w-20 rounded-full" />
        </div>
      </div>
    </Card>
  );
}

/**
 * Mirrors invoices/page.tsx: the payment account card, 6 status pills (All,
 * Draft, Sent, Paid, Overdue, Void), then a 5-column table: Number, Status,
 * Total, Amount paid, Due date.
 */
export default function InvoicesLoading() {
  return (
    <>
      <PageHeader title="Invoices" context="Sales" />
      <PaymentCardSkeleton />
      <FilterTableSkeleton pills={6} columns={["primary", "chip", "num", "num", "date"]} />
    </>
  );
}
