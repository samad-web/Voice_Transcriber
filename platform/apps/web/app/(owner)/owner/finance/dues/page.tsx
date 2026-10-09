import type { Metadata } from "next";
import Link from "next/link";
import {
  AGING_BUCKETS,
  AGING_BUCKET_LABELS,
  type AgingBucket,
  formatMoney,
  toMinor,
} from "@aura/shared";
import {
  Card,
  EmptyState,
  StatusChip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@aura/ui";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { ownerTry, requireFeature } from "@/lib/owner-context";

export const metadata: Metadata = { title: "Dues to chase" };

interface DueItem {
  id: string;
  dealId: string;
  dealName: string;
  customerName: string | null;
  ownerUserId: string | null;
  position: number;
  dueDate: string;
  promisedOn: string | null;
  currency: string;
  amount: number;
  paid: number;
  outstanding: number;
  status: string;
  bucket: AgingBucket;
  daysLate: number;
}

interface DuesData {
  today: string;
  items: DueItem[];
  total: number;
  aging: Record<string, { amount: number; items: number }>;
}

/**
 * §11's dues list and §11's aging view, which are one screen.
 *
 * ── THE STATUS ON EVERY ROW IS COMPUTED, NOT STORED ────────────────────────
 *
 * `payment_schedules.status` cannot hold `overdue` - 0172's CHECK refuses it -
 * and the API derives it per row from the ORG's own today. That is the one
 * design decision on this page worth knowing: `invoices.status` allowed
 * `overdue` for a year with nothing setting it, so `due_date` was decorative
 * and reports filtered on a word only a human could type (doc 37 R4). A status
 * that depends on today's date is only ever as correct as the last sweep, and
 * this one cannot drift because it is never written down.
 *
 * ── AND THE TOTALS ARE OVER EVERYTHING, NOT OVER THE PAGE ──────────────────
 *
 * The aging summary comes from the API's own whole-set aggregate rather than
 * from the rows on screen. An owner reading "₹2L in 90+" off page 1 of 7 would
 * be reading the wrong number, and the fix is not a bigger page.
 */
export default async function DuesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireFeature("/owner/finance/dues");

  const sp = await searchParams;
  const raw = Array.isArray(sp.bucket) ? sp.bucket[0] : sp.bucket;
  const bucket = (AGING_BUCKETS as readonly string[]).includes(raw ?? "")
    ? (raw as AgingBucket)
    : undefined;

  const dues = await ownerTry<DuesData>(
    `/v1/finance/dues?limit=200${bucket ? `&bucket=${bucket}` : ""}`,
  );

  if (!dues.ok) {
    return (
      <>
        <PageHeader title="Dues to chase" context="Sales" />
        <LoadFailure what="the dues list" failure={dues} />
      </>
    );
  }

  const data = dues.data;
  const money = (major: number, currency: string) =>
    formatMoney(toMinor(major, currency), { currency });

  return (
    <>
      <PageHeader
        title="Dues to chase"
        context="Sales"
        description="Every instalment still owed, oldest first."
        actions={
          <Link href="/owner/finance" className="text-xs text-text-muted underline hover:text-text">
            Finance overview
          </Link>
        }
      />

      {/* The aging filter, as links rather than a client-side control: the
          page is a server component and a filter that navigates keeps the
          URL shareable - which is how somebody sends a colleague "the 90+
          column" rather than describing it. */}
      <nav aria-label="Filter by age" className="flex flex-wrap gap-2 text-xs">
        <Link
          href="/owner/finance/dues"
          aria-current={bucket === undefined ? "page" : undefined}
          className={`rounded-md border px-2.5 py-1.5 ${
            bucket === undefined
              ? "border-accent text-text"
              : "border-border text-text-muted hover:text-text"
          }`}
        >
          All ({data.total})
        </Link>
        {AGING_BUCKETS.map((b) => (
          <Link
            key={b}
            href={`/owner/finance/dues?bucket=${b}`}
            aria-current={bucket === b ? "page" : undefined}
            className={`rounded-md border px-2.5 py-1.5 ${
              bucket === b ? "border-accent text-text" : "border-border text-text-muted hover:text-text"
            }`}
          >
            {AGING_BUCKET_LABELS[b]} · {money(data.aging[b]?.amount ?? 0, "INR")}
          </Link>
        ))}
      </nav>

      {data.items.length === 0 ? (
        <EmptyState
          title={bucket ? "Nothing in this bucket" : "Nothing is owed"}
          description={
            bucket
              ? "Try another age, or clear the filter."
              : "Every instalment on every deal has been paid. A deal with no payment schedule will not appear here - apply a template to one from its deal page."
          }
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <Table caption="Instalments still owed, oldest due date first">
            <TableHead>
              <TableRow>
                <TableHeaderCell>Customer</TableHeaderCell>
                <TableHeaderCell>Instalment</TableHeaderCell>
                <TableHeaderCell>Due</TableHeaderCell>
                <TableHeaderCell className="text-right">Owed</TableHeaderCell>
                <TableHeaderCell>State</TableHeaderCell>
                <TableHeaderCell>Promised</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <span className="block text-text">{item.customerName ?? item.dealName}</span>
                    {/* Only when it adds something. A deal is very often named
                        after the person, and printing both rendered as
                        "Ashok SharmaAshok Sharma". */}
                    {item.customerName && item.customerName !== item.dealName ? (
                      <span className="block text-xs text-text-muted">{item.dealName}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-text-muted">#{item.position}</TableCell>
                  <TableCell className="tabular-nums">
                    {item.dueDate}
                    {item.daysLate > 0 ? (
                      <span className="block text-xs text-text-muted">
                        {item.daysLate} day{item.daysLate === 1 ? "" : "s"} late
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(item.outstanding, item.currency)}
                    {item.paid > 0 ? (
                      <span className="block text-xs text-text-muted">
                        {money(item.paid, item.currency)} of {money(item.amount, item.currency)} paid
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {/* ── StatusChip, NOT StateChip ──────────────────────
                        `StateChip` is for the console's four CALL states, and
                        it appends the tone's meaning for screen readers when a
                        caller renames the label - so an overdue instalment
                        announced as "Overdue (missed call)". Caught by reading
                        the rendered page.

                        A payment status is not a call state. `StatusChip` is
                        the component for "everything that is NOT a state", and
                        its `danger` tone draws from the same orange as an
                        error chip rather than the red that means missed. */}
                    <StatusChip
                      tone={
                        item.status === "overdue"
                          ? "danger"
                          : item.status === "partial"
                            ? "muted"
                            : "outline"
                      }
                    >
                      {item.status === "overdue"
                        ? "Overdue"
                        : item.status === "partial"
                          ? "Part paid"
                          : "Open"}
                    </StatusChip>
                  </TableCell>
                  <TableCell className="tabular-nums text-text-muted">
                    {item.promisedOn ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <p className="text-xs text-text-muted">
        As of {data.today} in your workspace&apos;s own timezone. A promised date is recorded by
        whoever spoke to the customer; the Advisor chases the ones that pass.
      </p>
    </>
  );
}
