import Link from "next/link";
import { Card, MonoLabel, StatusChip } from "@aura/ui";
import { ownerGet } from "@/lib/owner-context";
import type { Conversation } from "./inbox/actions";
import type { Invoice } from "./invoices/actions";
import type { Quotation } from "./quotations/actions";
import { formatValue, relativeTime, type Deal } from "./types";

/**
 * Everything else that points at one contact or account, on its own page.
 *
 * WHY THIS EXISTS. A contact's page showed its deals, tasks and timeline, and
 * nothing more - so the quotation you sent this person, the invoice they have
 * not paid and the WhatsApp thread you are in the middle of were all real,
 * linked records that could only be found by going to another page and
 * searching (doc 23, H2). An account's page did not even show its deals.
 *
 * Each list is fetched on its own and fails on its own: every endpoint here is
 * separately permission-gated (quotation:view, invoice:view, conversation:view,
 * deal:view), and a role that may see people but not money still gets a
 * working page, with that one card saying it is unavailable.
 */

type Parent = { contactId: string } | { accountId: string };

function query(parent: Parent): string {
  const params = new URLSearchParams({ limit: "20" });
  if ("contactId" in parent) params.set("contactId", parent.contactId);
  else params.set("accountId", parent.accountId);
  return params.toString();
}

/** A deal's own URL: its pipeline's board with the drawer open. */
export function dealHref(deal: Pick<Deal, "id" | "pipeline_id">): string {
  return `/owner/deals?pipelineId=${deal.pipeline_id}&focus=${deal.id}`;
}

export async function LinkedRecords({
  parent,
  showDeals = false,
  showConversations = false,
}: {
  parent: Parent;
  /** The contact page already lists its deals; the account page does not. */
  showDeals?: boolean;
  /** Threads are one-to-one with a person, so only a contact has them. */
  showConversations?: boolean;
}) {
  const q = query(parent);
  const [quotations, invoices, deals, conversations] = await Promise.all([
    ownerGet<{ quotations: Quotation[] }>(`/v1/quotations?${q}`),
    ownerGet<{ invoices: Invoice[] }>(`/v1/invoices?${q}`),
    showDeals ? ownerGet<{ deals: Deal[] }>(`/v1/deals?${q}`) : Promise.resolve(null),
    showConversations && "contactId" in parent
      ? ownerGet<{ conversations: Conversation[] }>(`/v1/conversations?contactId=${parent.contactId}&limit=10`)
      : Promise.resolve(null),
  ]);

  return (
    <>
      {showDeals ? (
        <RecordCard title="Deals" rows={deals?.deals} empty="No deals for this account.">
          {(deal) => (
            <Link key={deal.id} href={dealHref(deal)} className="block px-3 py-2 hover:bg-surface-hover">
              <span className="block truncate text-xs font-medium text-text">{deal.name}</span>
              <span className="mt-0.5 flex items-center gap-2">
                <StatusChip tone={deal.status === "won" ? "solid" : "muted"}>{deal.stage}</StatusChip>
                <span className="text-xs text-text-muted tabular-nums">{formatValue(deal.amount)}</span>
              </span>
            </Link>
          )}
        </RecordCard>
      ) : null}

      <RecordCard title="Quotations" rows={quotations?.quotations} empty="No quotations yet.">
        {(quotation) => (
          <Link
            key={quotation.id}
            href={`/owner/quotations/${quotation.id}`}
            className="block px-3 py-2 hover:bg-surface-hover"
          >
            <span className="flex items-center justify-between gap-2">
              <span className="truncate text-xs font-medium text-text">{quotation.quotation_number}</span>
              <span className="text-xs text-text-muted tabular-nums">{formatValue(quotation.total)}</span>
            </span>
            <span className="mt-0.5 block text-xs text-text-muted capitalize">{quotation.status}</span>
          </Link>
        )}
      </RecordCard>

      <RecordCard title="Invoices" rows={invoices?.invoices} empty="No invoices yet.">
        {(invoice) => (
          <Link
            key={invoice.id}
            href={`/owner/invoices/${invoice.id}`}
            className="block px-3 py-2 hover:bg-surface-hover"
          >
            <span className="flex items-center justify-between gap-2">
              <span className="truncate text-xs font-medium text-text">{invoice.invoice_number}</span>
              <span className="text-xs text-text-muted tabular-nums">{formatValue(invoice.total)}</span>
            </span>
            <span className="mt-0.5 block text-xs text-text-muted capitalize">{invoice.status}</span>
          </Link>
        )}
      </RecordCard>

      {showConversations ? (
        <RecordCard title="Conversations" rows={conversations?.conversations} empty="No message threads yet.">
          {(thread) => (
            <Link key={thread.id} href="/owner/inbox" className="block px-3 py-2 hover:bg-surface-hover">
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium text-text capitalize">{thread.channel}</span>
                <span className="text-xs text-text-muted tabular-nums">
                  {relativeTime(thread.last_message_at)}
                </span>
              </span>
              <span className="mt-0.5 block truncate text-xs text-text-muted">
                {thread.peer_label ?? thread.peer_address}
              </span>
            </Link>
          )}
        </RecordCard>
      ) : null}
    </>
  );
}

function RecordCard<T>({
  title,
  rows,
  empty,
  children,
}: {
  title: string;
  /** undefined = the fetch failed or this role may not read it. */
  rows: T[] | undefined;
  empty: string;
  children: (row: T) => React.ReactNode;
}) {
  return (
    <Card>
      <MonoLabel>{title}</MonoLabel>
      {rows === undefined ? (
        // Any failure, not specifically a 403 - so this stays neutral rather
        // than implying a permissions problem.
        <p className="mt-3 text-xs text-text-muted">{title} unavailable.</p>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-xs text-text-muted">{empty}</p>
      ) : (
        <ul className="mt-3 divide-y divide-border rounded-md border border-border">
          {rows.map((row, i) => (
            <li key={i}>{children(row)}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}
