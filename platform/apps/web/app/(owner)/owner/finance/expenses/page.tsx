import type { Metadata } from "next";
import Link from "next/link";
import {
  EXPENSE_CATEGORY_LABELS,
  type ExpenseCategory,
  formatMoney,
  percentage,
  toMinor,
} from "@aura/shared";
import {
  Card,
  EmptyState,
  MonoLabel,
  SectionHeading,
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

export const metadata: Metadata = { title: "Expenses" };

interface ExpenseRow {
  id: string;
  category: string;
  vendor: string | null;
  amount: number;
  tax: number;
  netCost: number;
  currency: string;
  incurredOn: string;
  isFixed: boolean;
  marketingSourceName: string | null;
  approvedAt: string | null;
  recurs: string | null;
  memo: string | null;
  reversesId: string | null;
}

interface ExpensesData {
  expenses: ExpenseRow[];
  total: number;
  periodTotal: number;
}

interface SummaryData {
  from: string;
  to: string;
  fixed: number;
  variable: number;
  total: number;
  categories: { category: string; amount: number; entries: number }[];
}

/**
 * §12.3's cost view: what the work costs, split fixed from variable, by
 * category.
 *
 * ── THE FIGURES ARE NET OF RECOVERABLE TAX ─────────────────────────────────
 *
 * Every amount shown as a cost is `amount - tax`. An invoice total includes
 * GST the business gets back, and counting it as cost overstates every margin
 * by the tax rate — which would make this page disagree with the margin on the
 * Finance overview, computed the same way.
 *
 * ── AND ONLY APPROVED COSTS COUNT ──────────────────────────────────────────
 *
 * The summary reads approved expenses only, for the same reason an unverified
 * cash receipt is not "collected": an entered bill is a claim, and letting
 * claims move the margin makes the approval limit decorative. Unapproved rows
 * are still LISTED — with a chip — because somebody has to approve them.
 */
export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireFeature("/owner/finance/expenses");

  const sp = await searchParams;
  const unapproved = (Array.isArray(sp.view) ? sp.view[0] : sp.view) === "unapproved";

  // Default window: this month to date. A cost page opened with no range is
  // being opened to answer "what have we spent this month", which is the one
  // question that does not need a control to ask.
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = `${to.slice(0, 7)}-01`;

  const [list, summary] = await Promise.all([
    ownerTry<ExpensesData>(
      `/v1/finance/expenses?limit=200&from=${from}&to=${to}${unapproved ? "&unapprovedOnly=1" : ""}`,
    ),
    ownerTry<SummaryData>(`/v1/finance/expenses/summary?from=${from}&to=${to}`),
  ]);

  if (!list.ok) {
    return (
      <>
        <PageHeader title="Expenses" context="Sales" />
        <LoadFailure what="the expense list" failure={list} />
      </>
    );
  }

  const money = (major: number, currency = "INR") =>
    formatMoney(toMinor(major, currency), { currency });

  return (
    <>
      <PageHeader
        title="Expenses"
        context="Sales"
        description={`What the work cost, ${from} to ${to}.`}
        actions={
          <Link href="/owner/finance" className="text-xs text-text-muted underline hover:text-text">
            Finance overview
          </Link>
        }
      />

      {/* A failed summary read does not fail the page: the list below is the
          record, and the split is a reading of it. Same judgement the
          resources page makes about its picker. */}
      {summary.ok ? (
        <section className="space-y-3">
          <SectionHeading
            title={`${money(summary.data.total)} this month`}
            description="Fixed costs are the ones that do not move with the volume of work. Ad spend entered per source lives on the campaign screen and is counted there."
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Card className="space-y-1 p-4">
              <MonoLabel>Fixed</MonoLabel>
              <p className="font-mono text-2xl tabular-nums">{money(summary.data.fixed)}</p>
              <p className="text-xs text-text-muted">
                {percentage(summary.data.fixed, summary.data.total) ?? 0}% of the month
              </p>
            </Card>
            <Card className="space-y-1 p-4">
              <MonoLabel>Variable</MonoLabel>
              <p className="font-mono text-2xl tabular-nums">{money(summary.data.variable)}</p>
              <p className="text-xs text-text-muted">
                {percentage(summary.data.variable, summary.data.total) ?? 0}% of the month
              </p>
            </Card>
          </div>
          {summary.data.categories.length > 0 ? (
            <Card className="space-y-1.5 p-4">
              {summary.data.categories.map((c) => (
                <div key={c.category} className="flex items-baseline gap-3 text-sm">
                  <span className="w-40 shrink-0 text-text-muted">
                    {EXPENSE_CATEGORY_LABELS[c.category as ExpenseCategory] ?? c.category}
                  </span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-subtle">
                    <span
                      className="block h-full rounded-full bg-accent"
                      style={{
                        width: `${Math.round(((c.amount / (summary.data.total || 1)) * 100))}%`,
                      }}
                    />
                  </span>
                  <span className="w-28 shrink-0 text-right font-mono text-xs tabular-nums">
                    {money(c.amount)}
                  </span>
                </div>
              ))}
            </Card>
          ) : null}
        </section>
      ) : null}

      <nav aria-label="Filter expenses" className="flex flex-wrap gap-2 text-xs">
        {[
          ["", "All"],
          ["unapproved", "Waiting for approval"],
        ].map(([value, label]) => (
          <Link
            key={label}
            href={value ? `/owner/finance/expenses?view=${value}` : "/owner/finance/expenses"}
            aria-current={(unapproved ? "unapproved" : "") === value ? "page" : undefined}
            className={`rounded-md border px-2.5 py-1.5 ${
              (unapproved ? "unapproved" : "") === value
                ? "border-accent text-text"
                : "border-border text-text-muted hover:text-text"
            }`}
          >
            {label}
          </Link>
        ))}
      </nav>

      {list.data.expenses.length === 0 ? (
        <EmptyState
          title={unapproved ? "Nothing waiting" : "Nothing recorded this month"}
          description={
            unapproved
              ? "Every expense this month has been approved."
              : "An expense is entered by somebody and approved by somebody else. Until it is approved it does not move the margin."
          }
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <Table caption="Expenses this month, newest first">
            <TableHead>
              <TableRow>
                <TableHeaderCell>Date</TableHeaderCell>
                <TableHeaderCell>Category</TableHeaderCell>
                <TableHeaderCell>Vendor</TableHeaderCell>
                <TableHeaderCell className="text-right">Cost</TableHeaderCell>
                <TableHeaderCell>Kind</TableHeaderCell>
                <TableHeaderCell>State</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {list.data.expenses.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="tabular-nums text-text-muted">{e.incurredOn}</TableCell>
                  <TableCell>
                    {EXPENSE_CATEGORY_LABELS[e.category as ExpenseCategory] ?? e.category}
                    {e.marketingSourceName ? (
                      <span className="block text-xs text-text-muted">
                        {e.marketingSourceName}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-text-muted">{e.vendor ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(e.netCost, e.currency)}
                    {e.tax > 0 ? (
                      <span className="block text-xs text-text-muted">
                        {money(e.amount, e.currency)} incl. tax
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-xs text-text-muted">
                    {e.isFixed ? "Fixed" : "Variable"}
                    {e.recurs ? <span className="block">{e.recurs}</span> : null}
                  </TableCell>
                  <TableCell>
                    {/* StatusChip for the reason the dues page records:
                        `StateChip` carries the console's CALL vocabulary and
                        appends it for screen readers, so "approved" would
                        announce as "approved (answered call)". */}
                    {e.reversesId ? (
                      <StatusChip tone="danger">reversal</StatusChip>
                    ) : e.approvedAt ? (
                      <StatusChip tone="solid">approved</StatusChip>
                    ) : (
                      <StatusChip tone="outline">waiting</StatusChip>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <p className="text-xs text-text-muted">
        An expense&apos;s amount and date cannot be edited once entered — a mistake is reversed, so
        the correction is visible rather than the original being rewritten. Its category, vendor and
        fixed/variable split stay editable.
      </p>
    </>
  );
}
