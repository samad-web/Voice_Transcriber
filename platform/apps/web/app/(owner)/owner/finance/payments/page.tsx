import type { Metadata } from "next";
import Link from "next/link";
import { PAYMENT_METHOD_LABELS, type PaymentMethod, formatMoney, toMinor } from "@aura/shared";
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

export const metadata: Metadata = { title: "Payments" };

interface PaymentRow {
  id: string;
  dealId: string | null;
  dealName: string | null;
  customerName: string | null;
  amount: number;
  currency: string;
  method: string;
  status: string;
  collected: boolean;
  source: string;
  receivedAt: string;
  fee: number;
  net: number | null;
  matchStatus: string;
  matchConfidence: number | null;
  matchRule: string | null;
  proofUrl: string | null;
  verifiedBy: string | null;
  reversalReason: string | null;
}

interface PaymentsData {
  payments: PaymentRow[];
  total: number;
}

/**
 * §6's canonical payment, listed — every payment from every source in one
 * place, which is the whole point of the table behind it.
 *
 * ── THE `collected` FLAG IS THE API'S, NOT THIS PAGE'S ─────────────────────
 *
 * A payment's status does not tell a reader whether the money counts: there
 * are eleven statuses and only four of them are money in. Re-deriving that
 * here would be a second copy of `COLLECTED_STATUSES`, so the API publishes
 * the verdict per row and this page renders it. Same rule as §11's metrics
 * layer, applied to a boolean.
 *
 * ── THE THREE TABS ARE THE THREE QUESTIONS ────────────────────────────────
 *
 * Everything, what is waiting for a second person (§6.2), and what nobody has
 * linked to a deal (§8). Those are the only filters this page offers, because
 * they are the only ones that correspond to somebody having work to do.
 */
export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireFeature("/owner/finance/payments");

  const sp = await searchParams;
  const view = Array.isArray(sp.view) ? sp.view[0] : sp.view;
  const query =
    view === "pending"
      ? "pendingOnly=1"
      : view === "unmatched"
        ? "matchStatus=unmatched"
        : "";

  const payments = await ownerTry<PaymentsData>(`/v1/finance/payments?limit=200&${query}`);

  if (!payments.ok) {
    return (
      <>
        <PageHeader title="Payments" context="Sales" />
        <LoadFailure what="the payment list" failure={payments} />
      </>
    );
  }

  const money = (major: number, currency: string) =>
    formatMoney(toMinor(major, currency), { currency });

  const tabs = [
    ["", "All"],
    ["pending", "Waiting for approval"],
    ["unmatched", "Not linked to a deal"],
  ] as const;

  return (
    <>
      <PageHeader
        title="Payments"
        context="Sales"
        description="Cash, cheque, UPI, card, bank transfer — however it arrived."
        actions={
          <Link href="/owner/finance" className="text-xs text-text-muted underline hover:text-text">
            Finance overview
          </Link>
        }
      />

      <nav aria-label="Filter payments" className="flex flex-wrap gap-2 text-xs">
        {tabs.map(([value, label]) => (
          <Link
            key={label}
            href={value ? `/owner/finance/payments?view=${value}` : "/owner/finance/payments"}
            aria-current={(view ?? "") === value ? "page" : undefined}
            className={`rounded-md border px-2.5 py-1.5 ${
              (view ?? "") === value
                ? "border-accent text-text"
                : "border-border text-text-muted hover:text-text"
            }`}
          >
            {label}
          </Link>
        ))}
      </nav>

      {payments.data.payments.length === 0 ? (
        <EmptyState
          title={view ? "Nothing here" : "No payments yet"}
          description={
            view
              ? "Nothing matches this filter."
              : "A payment arrives by connector, by bank import, or because somebody recorded one. Cash, cheque and demand draft need proof and — above your approval limit — a second person."
          }
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <Table caption="Every payment received, newest first">
            <TableHead>
              <TableRow>
                <TableHeaderCell>Received</TableHeaderCell>
                <TableHeaderCell>Customer</TableHeaderCell>
                <TableHeaderCell>How</TableHeaderCell>
                <TableHeaderCell className="text-right">Amount</TableHeaderCell>
                <TableHeaderCell>State</TableHeaderCell>
                <TableHeaderCell>Linked</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {payments.data.payments.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="tabular-nums text-text-muted">
                    {p.receivedAt.slice(0, 10)}
                  </TableCell>
                  <TableCell>
                    {p.customerName ?? p.dealName ?? (
                      <span className="text-text-muted">Not identified</span>
                    )}
                  </TableCell>
                  <TableCell className="text-text-muted">
                    {PAYMENT_METHOD_LABELS[p.method as PaymentMethod] ?? p.method}
                    <span className="block text-xs">{p.source.replace("_", " ")}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(p.amount, p.currency)}
                    {p.fee > 0 ? (
                      <span className="block text-xs text-text-muted">
                        {money(p.fee, p.currency)} fee
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {/* StatusChip, for the reason the dues page records: a
                        payment status is not one of the console's four CALL
                        states, and `StateChip` would announce it with the
                        tone's call meaning appended.

                        `danger` for a bounce, a failure and a reversal - those
                        are faults. `solid` once the money is in. `outline` for
                        a pending verification: nothing has gone wrong,
                        somebody just has not looked yet. */}
                    <StatusChip
                      tone={
                        p.status === "cheque_bounced" ||
                        p.status === "failed" ||
                        p.status === "reversed"
                          ? "danger"
                          : p.collected
                            ? "solid"
                            : "outline"
                      }
                    >
                      {p.status.replace(/_/g, " ")}
                    </StatusChip>
                    {p.reversalReason ? (
                      <span className="mt-1 block text-xs text-text-muted">{p.reversalReason}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-xs text-text-muted">
                    {/* Not a link: the matching queue is an API surface with
                        no console page yet, and a link to a route that does
                        not exist is a 404 somebody finds by clicking. The
                        words still say what state the payment is in. */}
                    {p.matchStatus === "matched"
                      ? (p.dealName ?? "Linked")
                      : p.matchStatus === "suggested"
                        ? "Suggested - needs confirming"
                        : "Not linked"}
                    {p.matchRule ? (
                      <span className="block">matched by {p.matchRule.replace(/_/g, " ")}</span>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <p className="text-xs text-text-muted">
        A payment is never edited or deleted. A mistake is reversed, which leaves both the original
        and the correction in the ledger.
      </p>
    </>
  );
}
