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
import { requireOwnerFeature } from "@/lib/owner-features";
import { formatMoney } from "../lib/format-money";
import { NewQuotationDialog } from "./new-quotation-dialog";
import type { Quotation, QuotationStatus } from "./actions";

export const metadata: Metadata = { title: "Quotations" };

const PAGE_SIZE = 50;

const STATUSES: Array<{ value: QuotationStatus | ""; label: string }> = [
  { value: "", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Rejected" },
  { value: "expired", label: "Expired" },
];

function statusTone(status: QuotationStatus): "solid" | "muted" | "outline" | "danger" {
  if (status === "accepted") return "solid";
  if (status === "rejected" || status === "expired") return "danger";
  if (status === "sent") return "muted";
  return "outline";
}

interface ListResponse {
  quotations: Quotation[];
  total: number;
  limit: number;
  offset: number;
}

export default async function QuotationsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; offset?: string }>;
}) {
  // Feature gate (migration 0093). Before any fetch: a page this tenant is
  // not provisioned for must neither cost a round trip nor 404 only after
  // proving the data behind it exists.
  await requireOwnerFeature("quotations");

  const sp = await searchParams;
  const offset = Math.max(0, Number(sp.offset) || 0);
  const status = sp.status ?? "";

  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (status) query.set("status", status);
  if (offset > 0) query.set("offset", String(offset));

  const data = await ownerGet<ListResponse>(`/v1/quotations?${query}`);

  if (!data) {
    return (
      <>
        <PageHeader title="Quotations" context="Pipeline" />
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
      <PageHeader title="Quotations" context="Pipeline" />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-1" aria-label="Filter by status">
          {STATUSES.map((s) => {
            const next = new URLSearchParams();
            if (s.value) next.set("status", s.value);
            const href = next.toString() ? `/owner/quotations?${next}` : "/owner/quotations";
            const active = s.value === status;
            return (
              <Link
                key={s.value || "all"}
                href={href}
                aria-current={active ? "page" : undefined}
                className={
                  "inline-flex h-8 items-center rounded-full px-3 text-xs font-medium transition-colors duration-150 ease-out " +
                  (active
                    ? "bg-text text-bg"
                    : "border border-border-strong text-text-muted hover:bg-surface-hover hover:text-text")
                }
              >
                {s.label}
              </Link>
            );
          })}
        </nav>
        <NewQuotationDialog />
      </div>

      {data.quotations.length === 0 ? (
        <EmptyState
          title="No quotations yet"
          description="Start one with New Quotation above."
        />
      ) : (
        <>
          <Table caption="Quotations">
            <TableHead>
              <tr>
                <TableHeaderCell>Number</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Total</TableHeaderCell>
                <TableHeaderCell>Valid until</TableHeaderCell>
              </tr>
            </TableHead>
            <TableBody>
              {data.quotations.map((quotation) => (
                <TableRow key={quotation.id}>
                  <TableCell>
                    <Link
                      href={`/owner/quotations/${quotation.id}`}
                      className="block font-medium text-text hover:underline"
                    >
                      {quotation.quotation_number}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusChip tone={statusTone(quotation.status)}>{quotation.status}</StatusChip>
                  </TableCell>
                  <TableCell className="tabular-nums text-text-muted">
                    {formatMoney(quotation.total, quotation.currency)}
                  </TableCell>
                  <TableCell className="text-text-muted">
                    {quotation.valid_until
                      ? new Date(quotation.valid_until).toLocaleDateString()
                      : "-"}
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
              return `/owner/quotations?${next}`;
            }}
          />
        </>
      )}
    </>
  );
}
