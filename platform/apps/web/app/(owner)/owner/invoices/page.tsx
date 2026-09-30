import type { Metadata } from "next";
import Link from "next/link";
import { formatDateKey } from "@aura/shared";
import {
  EmptyState,
  MonoLabel,
  StatusChip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@aura/ui";
import { FilterLink } from "@/components/filter-link";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { Pager } from "@/components/pager";
import { ownerGet, ownerTry, requireFeature } from "@/lib/owner-context";
import { CustomerCell } from "../customer-cell";
import { formatMoney } from "../lib/format-money";
import type { Invoice, InvoiceStatus, PaymentSettingsResponse } from "./actions";
import { PaymentSettingsCard } from "./payment-settings";

export const metadata: Metadata = { title: "Invoices" };

const PAGE_SIZE = 50;

const STATUSES: Array<{ value: InvoiceStatus | ""; label: string }> = [
  { value: "", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "paid", label: "Paid" },
  { value: "overdue", label: "Overdue" },
  { value: "void", label: "Void" },
];

function statusTone(status: InvoiceStatus): "solid" | "muted" | "outline" | "danger" {
  if (status === "paid") return "solid";
  if (status === "overdue" || status === "void") return "danger";
  if (status === "sent") return "muted";
  return "outline";
}

interface ListResponse {
  invoices: Invoice[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Invoices are listed and viewed here, but not created from scratch - the
 * primary path is the "Create invoice" button on a quotation's detail page
 * (`POST /invoices/from-quotation/:id`). That's why there's no dialog here,
 * unlike products and quotations.
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; offset?: string }>;
}) {
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/invoices");
  const sp = await searchParams;
  const offset = Math.max(0, Number(sp.offset) || 0);
  const status = sp.status ?? "";
  const search = sp.q ?? "";

  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (status) query.set("status", status);
  if (search) query.set("q", search);
  if (offset > 0) query.set("offset", String(offset));

  const result = await ownerTry<ListResponse>(`/v1/invoices?${query}`);

  // Owner-only on the API, so a manager gets null here and simply does not see
  // the card - the same split the route enforces, rather than a second copy of
  // the rule. Fetched alongside the list rather than in its own Suspense
  // boundary: it is one indexed row by primary key, and a second sequential
  // round trip to Seoul would cost more than the query does.
  const settings = await ownerGet<PaymentSettingsResponse>("/v1/owner/payment-settings");

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Invoices" context="Sales" />
        <LoadFailure what="invoices" failure={result} />
      </>
    );
  }
  const data = result.data;

  return (
    <>
      <PageHeader title="Invoices" context="Sales" />

      {settings?.settings ? <PaymentSettingsCard initial={settings.settings} /> : null}
      {/* Stripe beside Razorpay (0099): per-invoice choice, so each gateway has
          its own keys. Rendered only from an API that reports providers. */}
      {settings?.providers?.stripe ? (
        <PaymentSettingsCard
          provider="stripe"
          initial={settings.providers.stripe}
          platformAvailable={settings.providers.stripe.available}
        />
      ) : null}

      <nav className="flex flex-wrap gap-1.5" aria-label="Filter by status">
        {STATUSES.map((s) => {
          // The search survives a status change, and vice versa below. A tab that
          // silently dropped the search box's contents would read as the search
          // having failed.
          const next = new URLSearchParams();
          if (s.value) next.set("status", s.value);
          if (search) next.set("q", search);
          const href = next.toString() ? `/owner/invoices?${next}` : "/owner/invoices";
          return (
            <FilterLink key={s.value || "all"} active={s.value === status} href={href}>
              {s.label}
            </FilterLink>
          );
        })}
      </nav>

      {/* A plain GET form, like the price list's. The status goes along as a
          hidden field because a bare form submits only its own inputs, which
          would drop the active tab. */}
      <form className="max-w-sm">
        {status ? <input type="hidden" name="status" value={status} /> : null}
        <MonoLabel>Search</MonoLabel>
        <input
          type="search"
          name="q"
          aria-label="Search invoices"
          defaultValue={search}
          placeholder="Number, company or person"
          className="mt-1.5 h-9 w-full rounded-md border border-border-strong bg-surface px-3 text-sm text-text placeholder:text-text-muted"
        />
      </form>

      {data.invoices.length === 0 ? (
        search || status ? (
          <EmptyState
            title="No invoices match"
            description="Nothing here matches that search and filter. Clear one of them to see more."
          />
        ) : (
          <EmptyState
            title="No invoices yet"
            description="Invoices are created from an accepted quotation - open one and use Create invoice."
          />
        )
      ) : (
        <>
          <Table caption="Invoices">
            <TableHead>
              <tr>
                <TableHeaderCell>Number</TableHeaderCell>
                <TableHeaderCell>For</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Total</TableHeaderCell>
                <TableHeaderCell>Amount paid</TableHeaderCell>
                <TableHeaderCell>Due date</TableHeaderCell>
              </tr>
            </TableHead>
            <TableBody>
              {data.invoices.map((invoice) => (
                <TableRow key={invoice.id}>
                  <TableCell>
                    <Link
                      href={`/owner/invoices/${invoice.id}`}
                      className="block font-medium text-text hover:underline"
                    >
                      {invoice.invoice_number}
                    </Link>
                  </TableCell>
                  <TableCell className="text-text-muted">
                    <CustomerCell
                      accountId={invoice.account_id}
                      accountName={invoice.account_name}
                      contactId={invoice.contact_id}
                      contactName={invoice.contact_name}
                    />
                  </TableCell>
                  <TableCell>
                    <StatusChip tone={statusTone(invoice.status)}>{invoice.status}</StatusChip>
                  </TableCell>
                  <TableCell className="tabular-nums text-text-muted">
                    {formatMoney(invoice.total, invoice.currency)}
                  </TableCell>
                  <TableCell className="tabular-nums text-text-muted">
                    {formatMoney(invoice.amount_paid, invoice.currency)}
                  </TableCell>
                  <TableCell className="text-text-muted">
                    {/* A calendar date (DATE column): no zone, or it slips a day west of UTC. */}
                    {invoice.due_date ? formatDateKey(invoice.due_date.slice(0, 10)) : "-"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <Pager
            total={data.total}
            page={Math.floor(offset / PAGE_SIZE) + 1}
            pageSize={PAGE_SIZE}
            hrefFor={(page) => {
              const next = new URLSearchParams(query);
              next.set("offset", String((page - 1) * PAGE_SIZE));
              return `/owner/invoices?${next}`;
            }}
          />
        </>
      )}
    </>
  );
}
