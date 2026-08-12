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
import { relativeTime, type Contact } from "../types";

export const metadata: Metadata = { title: "Contacts — Aura" };

const PAGE_SIZE = 50;

interface ListResponse {
  contacts: Contact[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * CRM Phase 1 foundation (E0.1) — the Contact list, alongside /owner/leads
 * rather than replacing it. Server-rendered filtering (the `q` query string
 * is the state), same reasoning as leads/page.tsx: a filtered list stays a
 * shareable URL.
 */
export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; offset?: string }>;
}) {
  const sp = await searchParams;
  const offset = Math.max(0, Number(sp.offset) || 0);

  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (sp.q) query.set("q", sp.q);
  if (offset > 0) query.set("offset", String(offset));

  const data = await ownerGet<ListResponse>(`/v1/contacts?${query}`);

  if (!data) {
    return (
      <>
        <PageHeader title="Contacts" context="Pipeline" />
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
      <PageHeader title="Contacts" context="Pipeline" />

      {/* Plain GET form — no client JS needed for a search this simple, and the
          result is a bookmarkable URL like every other filtered view here. */}
      <form className="max-w-sm">
        <MonoLabel>Search</MonoLabel>
        <input
          type="search"
          name="q"
          defaultValue={sp.q ?? ""}
          placeholder="Name, email or phone"
          className="mt-1.5 h-9 w-full rounded-md border border-border-strong bg-surface px-3 text-sm text-text placeholder:text-text-muted"
        />
      </form>

      {data.contacts.length === 0 ? (
        <EmptyState
          title="No contacts yet"
          description="Contacts appear automatically as calls are qualified into leads, or when one is created by hand."
        />
      ) : (
        <>
          <Table caption="Contacts">
            <TableHead>
              <tr>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Email</TableHeaderCell>
                <TableHeaderCell>Phone</TableHeaderCell>
                <TableHeaderCell className="text-right">Calls</TableHeaderCell>
                <TableHeaderCell>Last activity</TableHeaderCell>
              </tr>
            </TableHead>
            <TableBody>
              {data.contacts.map((contact) => (
                <TableRow key={contact.id}>
                  <TableCell>
                    <Link
                      href={`/owner/contacts/${contact.id}`}
                      className="block font-medium text-text hover:underline"
                    >
                      {contact.display_name}
                    </Link>
                    {contact.title ? (
                      <span className="text-xs text-text-muted">{contact.title}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-text-muted">{contact.email ?? "—"}</TableCell>
                  <TableCell className="text-text-muted">
                    {contact.phone_prefix
                      ? `${contact.phone_prefix}…`
                      : contact.phone_last3
                        ? `…${contact.phone_last3}`
                        : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{contact.call_count}</TableCell>
                  <TableCell className="text-text-muted tabular-nums">
                    {relativeTime(contact.last_activity_at)}
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
              return `/owner/contacts?${next}`;
            }}
          />
        </>
      )}
    </>
  );
}
