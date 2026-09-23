import type { Metadata } from "next";
import Link from "next/link";
import { Card, MonoLabel } from "@aura/ui";
import { BreadcrumbLeaf } from "@/components/breadcrumbs";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { getOrgTimeZone } from "@/lib/org-time";
import { ownerTry } from "@/lib/owner-context";
import { CustomFieldEditor } from "../../custom-field-editor";
import { InteractionTimeline } from "../../interaction-timeline";
import { LinkedRecords } from "../../linked-records";
import { TaskList } from "../../task-list";
import { relativeTime, type Account, type Contact } from "../../types";

export const metadata: Metadata = { title: "Account" };

/**
 * One account, matching the contact detail page.
 *
 * A2 built an account timeline route - and a deliberately clever one, since
 * an account's history includes every interaction belonging to a contact who
 * works there - but nothing in the console ever called it: the account list
 * had no rows you could click. This is the page that reaches it.
 */
export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [result, zone] = await Promise.all([
    ownerTry<{ account: Account; contacts: Contact[] }>(`/v1/accounts/${id}`),
    getOrgTimeZone(),
  ]);

  // `ownerTry` keeps the failures apart - network error, 404, 500 - so the
  // banner below can say which one happened. Still not `notFound()`, which
  // would misreport a transient API outage as "this account does not exist",
  // and this mirrors every list page in this area (leads, contacts, deals,
  // accounts, board, duplicates).
  if (!result.ok) {
    return (
      <>
        <PageHeader title="Account" context="Account" />
        <LoadFailure what="this account" failure={result} />
      </>
    );
  }
  const { account, contacts } = result.data;

  const phone = account.phone_prefix
    ? `${account.phone_prefix}…`
    : account.phone_last3
      ? `…${account.phone_last3}`
      : null;

  return (
    <>
      <BreadcrumbLeaf label={account.name} />
      <PageHeader title={account.name} context="Account" />

      <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          <Card>
            <TaskList accountId={account.id} title="Follow-ups" />
          </Card>
          <Card>
            {/* Includes its contacts' interactions - see the route's own note. */}
            <InteractionTimeline parent="accounts" parentId={account.id} title="Timeline" />
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <MonoLabel>Details</MonoLabel>
            <dl className="mt-3 space-y-2.5 text-xs">
              <div>
                <dt className="text-text-muted">Domain</dt>
                <dd className="mt-0.5 font-medium break-words text-text">
                  {account.domain ?? "-"}
                </dd>
              </div>
              <div>
                <dt className="text-text-muted">Phone</dt>
                <dd className="mt-0.5 font-medium text-text tabular-nums">{phone ?? "-"}</dd>
              </div>
              <div>
                <dt className="text-text-muted">Last activity</dt>
                <dd className="mt-0.5 font-medium text-text tabular-nums">
                  {relativeTime(account.last_activity_at, zone)}
                </dd>
              </div>
            </dl>
          </Card>

          <Card>
            <CustomFieldEditor parent="accounts" parentId={account.id} />
          </Card>

          <Card>
            <MonoLabel>People</MonoLabel>
            {contacts.length === 0 ? (
              <p className="mt-3 text-xs text-text-muted">Nobody linked to this account yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-border rounded-md border border-border">
                {contacts.map((contact) => (
                  <li key={contact.id}>
                    <Link
                      href={`/owner/contacts/${contact.id}`}
                      className="block px-3 py-2 hover:bg-surface-hover"
                    >
                      <span className="block truncate text-xs font-medium text-text">
                        {contact.display_name}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-text-muted">
                        {contact.title ?? contact.email ?? "-"}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Deals, quotations and invoices for the company - none of which this
              page showed before (doc 23, H2). */}
          <LinkedRecords parent={{ accountId: account.id }} showDeals />
        </div>
      </div>
    </>
  );
}
