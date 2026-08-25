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
import { ownerGet } from "@/lib/owner-context";
import { relativeTime, type Account } from "../types";

export const metadata: Metadata = { title: "Accounts — Aura" };

const PAGE_SIZE = 50;

interface ListResponse {
  accounts: Account[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * CRM Phase 1 foundation (E0.1) — the Account (company) list. Nothing
 * populates this automatically yet: unlike Contact/Deal, no call carries a
 * company name today, so this starts empty except for accounts created by
 * hand until that mapping exists.
 */
export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; offset?: string }>;
}) {
  const sp = await searchParams;
  const offset = Math.max(0, Number(sp.offset) || 0);

  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (sp.q) query.set("q", sp.q);
  if (offset > 0) query.set("offset", String(offset));

  const data = await ownerGet<ListResponse>(`/v1/accounts?${query}`);

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

      <form className="max-w-sm">
        <MonoLabel>Search</MonoLabel>
        <input
          type="search"
          name="q"
          defaultValue={sp.q ?? ""}
          placeholder="Company name or domain"
          className="mt-1.5 h-9 w-full rounded-md border border-border-strong bg-surface px-3 text-sm text-text placeholder:text-text-muted"
        />
      </form>

      {data.accounts.length === 0 ? (
        <EmptyState
          title="No accounts yet"
          description="Accounts are companies, added by hand for now — nothing extracted from a call names one automatically yet."
        />
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
                  <TableCell className="text-text-muted">{account.domain ?? "—"}</TableCell>
                  <TableCell className="text-text-muted">
                    {account.phone_prefix
                      ? `${account.phone_prefix}…`
                      : account.phone_last3
                        ? `…${account.phone_last3}`
                        : "—"}
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
            hrefFor={(page) => {
              const next = new URLSearchParams(query);
              next.set("offset", String((page - 1) * PAGE_SIZE));
              return `/owner/accounts?${next}`;
            }}
          />
        </>
      )}
    </>
  );
}
