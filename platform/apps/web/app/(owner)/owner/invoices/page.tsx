import type { Metadata } from "next";
import Link from "next/link";
import {
  Card,
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
import { PageHeader } from "@/components/page-header";
import { Pager } from "@/components/pager";
import { ownerGet } from "@/lib/owner-context";
import { formatMoney } from "../lib/format-money";
import type { Invoice, InvoiceStatus } from "./actions";

export const metadata: Metadata = { title: "Invoices — Aura" };

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
 * Invoices are listed and viewed here, but not created from scratch — the
 * primary path is the "Create invoice" button on a quotation's detail page
 * (`POST /invoices/from-quotation/:id`). That's why there's no dialog here,
 * unlike products and quotations.
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; offset?: string }>;
}) {
  const sp = await searchParams;
  const offset = Math.max(0, Number(sp.offset) || 0);
  const status = sp.status ?? "";

  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (status) query.set("status", status);
  if (offset > 0) query.set("offset", String(offset));

  const data = await ownerGet<ListResponse>(`/v1/invoices?${query}`);

  if (!data) {
    return (
      <>
        <PageHeader title="Invoices" context="Pipeline" />
        <Card>
          <MonoLabel>Data unavailable</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The platform API did not answer. If this persists, contact your provider.
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Invoices" context="Pipeline" />

      <nav className="flex flex-wrap gap-1" aria-label="Filter by status">
        {STATUSES.map((s) => {
          const next = new URLSearchParams();
          if (s.value) next.set("status", s.value);
          const href = next.toString() ? `/owner/invoices?${next}` : "/owner/invoices";
          const active = s.value === status;
          return (
            <Link
              key={s.value || "all"}
              href={href}
              aria-current={active ? "page" : undefined}
              style={active ? { backgroundImage: "var(--brand-gradient)" } : undefined}
              className={
                "inline-flex h-8 items-center rounded-full px-3 text-xs font-medium transition-colors duration-150 ease-out " +
                (active
                  ? "text-white"
                  : "border border-border-strong text-text-muted hover:bg-surface-hover hover:text-text")
              }
            >
              {s.label}
            </Link>
          );
        })}
      </nav>

      {data.invoices.length === 0 ? (
        <EmptyState
          title="No invoices yet"
          description="Invoices are created from an accepted quotation — open one and use Create invoice."
        />
      ) : (
        <>
          <Table caption="Invoices">
            <TableHead>
              <tr>
                <TableHeaderCell>Number</TableHeaderCell>
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
                    {invoice.due_date ? new Date(invoice.due_date).toLocaleDateString() : "—"}
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
