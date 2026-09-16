import type { Metadata } from "next";
import Link from "next/link";
import {
  Card,
  EmptyState,
  MonoLabel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { Pager } from "@/components/pager";
import { viewHref, viewQueryFrom } from "@/lib/list-views";
import { ownerGet } from "@/lib/owner-context";
import { requireOwnerFeature } from "@/lib/owner-features";
import { FilterSearch, FilterSelect, ListFilterForm } from "../list-filters";
import type { FilterOption } from "../list-options";
import { SavedViewsBar } from "../saved-views/saved-views-bar";
import { loadSavedViews } from "../saved-views/load";
import { relativeTime, type Account } from "../types";

export const metadata: Metadata = { title: "Accounts" };

const PAGE_SIZE = 50;

const SORT_OPTIONS: readonly FilterOption[] = [
  { value: "", label: "Recent activity" },
  { value: "created", label: "Newest" },
  { value: "name", label: "Name A-Z" },
];

interface ListResponse {
  accounts: Account[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * CRM Phase 1 foundation (E0.1) - the Account (company) list. Nothing
 * populates this automatically yet: unlike Contact/Deal, no call carries a
 * company name today, so this starts empty except for accounts created by
 * hand until that mapping exists.
 */
export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Feature gate (migration 0093). Before any fetch: a page this tenant is
  // not provisioned for must neither cost a round trip nor 404 only after
  // proving the data behind it exists.
  await requireOwnerFeature("contacts");

  const sp = await searchParams;
  const current = viewQueryFrom("accounts", sp);
  const offsetRaw = Array.isArray(sp.offset) ? sp.offset[0] : sp.offset;
  const offset = Math.max(0, Number(offsetRaw) || 0);

  const query = new URLSearchParams({ limit: String(PAGE_SIZE), ...current });
  if (offset > 0) query.set("offset", String(offset));

  const [data, views] = await Promise.all([
    ownerGet<ListResponse>(`/v1/accounts?${query}`),
    loadSavedViews("accounts"),
  ]);

  if (!data) {
    return (
      <>
        <PageHeader title="Accounts" context="Pipeline" />
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
      <PageHeader title="Accounts" context="Pipeline" />

      <SavedViewsBar list="accounts" views={views} current={current} allLabel="All accounts" />

      <ListFilterForm key={viewHref("accounts", current)} path="/owner/accounts" label="Filter accounts">
        <FilterSearch defaultValue={current.q} placeholder="Company name or domain" label="Search accounts" />
        <FilterSelect name="sort" label="Sort" defaultValue={current.sort} options={SORT_OPTIONS} />
      </ListFilterForm>

      {data.accounts.length === 0 ? (
        current.q ? (
          <EmptyState title="No accounts match this search" description="Try a different name or domain." />
        ) : (
          <EmptyState
            title="No accounts yet"
            description="Accounts are companies, added by hand for now - nothing extracted from a call names one automatically yet."
          />
        )
      ) : (
        <>
          <Table caption="Accounts">
            <TableHead>
              <tr>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Domain</TableHeaderCell>
                <TableHeaderCell>Phone</TableHeaderCell>
                <TableHeaderCell>Last activity</TableHeaderCell>
              </tr>
            </TableHead>
            <TableBody>
              {data.accounts.map((account) => (
                <TableRow key={account.id}>
                  <TableCell>
                    <Link
                      href={`/owner/accounts/${account.id}`}
                      className="block font-medium text-text hover:underline"
                    >
                      {account.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-text-muted">{account.domain ?? "-"}</TableCell>
                  <TableCell className="text-text-muted">
                    {account.phone_prefix
                      ? `${account.phone_prefix}…`
                      : account.phone_last3
                        ? `…${account.phone_last3}`
                        : "-"}
                  </TableCell>
                  <TableCell className="text-text-muted tabular-nums">
                    {relativeTime(account.last_activity_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <Pager
            total={data.total}
            page={Math.floor(offset / PAGE_SIZE) + 1}
            pageSize={PAGE_SIZE}
            noun="account"
            previousLabel="← Previous"
            nextLabel="Next →"
            hrefFor={(page) => {
              const next = new URLSearchParams(current);
              if (page > 1) next.set("offset", String((page - 1) * PAGE_SIZE));
              const qs = next.toString();
              return `/owner/accounts${qs ? `?${qs}` : ""}`;
            }}
          />
        </>
      )}
    </>
  );
}
