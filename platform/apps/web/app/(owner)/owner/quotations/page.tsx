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
import type { Product } from "../products/actions";
import { NewQuotationDialog } from "./new-quotation-dialog";
import type { Quotation, QuotationStatus } from "./actions";

export const metadata: Metadata = { title: "Quotes" };

const PAGE_SIZE = 50;

/** Enough of the price list for the new-quotation dialog to pick from without typing. */
const PRICE_LIST_PAGE = 20;

const STATUSES: Array<{ value: QuotationStatus | ""; label: string }> = [
  { value: "", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Rejected" },
  { value: "expired", label: "Expired" },
  { value: "superseded", label: "Superseded" },
];

function statusTone(status: QuotationStatus): "solid" | "muted" | "outline" | "danger" {
  if (status === "accepted") return "solid";
  if (status === "rejected" || status === "expired") return "danger";
  // Not danger: a revision replacing it is the system working, not a loss. The
  // same muted tone `sent` gets - a document that has had its turn.
  if (status === "sent" || status === "superseded") return "muted";
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
  searchParams: Promise<{ status?: string; q?: string; offset?: string }>;
}) {
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/quotations");
  const sp = await searchParams;
  const offset = Math.max(0, Number(sp.offset) || 0);
  const status = sp.status ?? "";
  const search = sp.q ?? "";

  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (status) query.set("status", status);
  if (search) query.set("q", search);
  if (offset > 0) query.set("offset", String(offset));

  // The price list rides along so the New Quotation dialog can offer it the
  // moment it opens. `null` - a role without `product:view`, or an unreachable
  // API - hides the picker rather than offering a control that cannot work; it
  // never blocks the quotation list itself.
  const [result, priceList] = await Promise.all([
    ownerTry<ListResponse>(`/v1/quotations?${query}`),
    ownerGet<{ products: Product[] }>(`/v1/products?status=active&limit=${PRICE_LIST_PAGE}`),
  ]);

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Quotes" context="Sales" />
        <LoadFailure what="quotations" failure={result} />
      </>
    );
  }
  const data = result.data;

  return (
    <>
      <PageHeader title="Quotes" context="Sales" />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-1.5" aria-label="Filter by status">
          {STATUSES.map((s) => {
            // The search survives a status change, and vice versa below. A tab
            // that silently dropped the search box's contents would read as the
            // search having failed.
            const next = new URLSearchParams();
            if (s.value) next.set("status", s.value);
            if (search) next.set("q", search);
            const href = next.toString() ? `/owner/quotations?${next}` : "/owner/quotations";
            return (
              <FilterLink key={s.value || "all"} active={s.value === status} href={href}>
                {s.label}
              </FilterLink>
            );
          })}
        </nav>
        <NewQuotationDialog products={priceList?.products ?? null} />
      </div>

      {/* A plain GET form, like the price list's. The status goes along as a
          hidden field because a bare form submits only its own inputs, which
          would drop the active tab. */}
      <form className="max-w-sm">
        {status ? <input type="hidden" name="status" value={status} /> : null}
        <MonoLabel>Search</MonoLabel>
        <input
          type="search"
          name="q"
          aria-label="Search quotations"
          defaultValue={search}
          placeholder="Number, company or person"
          className="mt-1.5 h-9 w-full rounded-md border border-border-strong bg-surface px-3 text-sm text-text placeholder:text-text-muted"
        />
      </form>

      {data.quotations.length === 0 ? (
        search || status ? (
          <EmptyState
            title="No quotations match"
            description="Nothing here matches that search and filter. Clear one of them to see more."
          />
        ) : (
          <EmptyState title="No quotations yet" description="Start one with New Quotation above." />
        )
      ) : (
        <>
          <Table caption="Quotations">
            <TableHead>
              <tr>
                <TableHeaderCell>Number</TableHeaderCell>
                <TableHeaderCell>For</TableHeaderCell>
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
                  <TableCell className="text-text-muted">
                    <CustomerCell
                      accountId={quotation.account_id}
                      accountName={quotation.account_name}
                      contactId={quotation.contact_id}
                      contactName={quotation.contact_name}
                    />
                  </TableCell>
                  <TableCell>
                    <StatusChip tone={statusTone(quotation.status)}>{quotation.status}</StatusChip>
                  </TableCell>
                  <TableCell className="tabular-nums text-text-muted">
                    {formatMoney(quotation.total, quotation.currency)}
                  </TableCell>
                  <TableCell className="text-text-muted">
                    {/* A calendar date (DATE column): no zone, or it slips a day west of UTC. */}
                    {quotation.valid_until ? formatDateKey(quotation.valid_until.slice(0, 10)) : "-"}
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
