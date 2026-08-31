import type { Metadata } from "next";
import Link from "next/link";
import { Card, MonoLabel, StatusChip } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import { CustomFieldEditor } from "../../custom-field-editor";
import { EmailComposer } from "../../email-composer";
import { InteractionTimeline } from "../../interaction-timeline";
import { TaskList } from "../../task-list";
import { formatValue, relativeTime, type Contact, type Deal } from "../../types";

export const metadata: Metadata = { title: "Contact — Aura" };

/**
 * One contact, with the unified timeline (Track A2) as the centrepiece.
 *
 * A page rather than a drawer, unlike deals: a contact is a thing you link
 * someone to ("see Priya's history"), and the deal board's drawer pattern
 * exists because a card must stay in its column behind it. Nothing about a
 * contact list needs that.
 */
export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Two round-trips rather than one: `GET /contacts/:id` and `GET
  // /contacts/:id/deals` are separately permission-gated (contact:view vs
  // deal:view), so a role that may see people but not pipeline still gets a
  // working page instead of a blanket 403.
  const [detail, dealsResponse] = await Promise.all([
    ownerGet<{ contact: Contact }>(`/v1/contacts/${id}`),
    ownerGet<{ deals: Deal[] }>(`/v1/contacts/${id}/deals`),
  ]);

  // ownerGet collapses every failure — network error, 404, 500 — to `null`
  // with no way to tell them apart (see api-result.ts's `unwrap`), so this
  // mirrors every list page in this area (leads, contacts, deals, accounts,
  // board, duplicates) rather than reaching for `notFound()`, which would
  // misreport a transient API outage as "this contact does not exist".
  if (!detail) {
    return (
      <>
        <PageHeader title="Contact" context="Contact" />
        <Card>
          <MonoLabel>Data unavailable</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The platform API did not answer. If this persists, contact your provider.
          </p>
        </Card>
      </>
    );
  }
  const { contact } = detail;
  const deals = dealsResponse?.deals ?? [];

  const phone = contact.phone_prefix
    ? `${contact.phone_prefix}…`
    : contact.phone_last3
      ? `…${contact.phone_last3}`
      : null;

  return (
    <>
      <PageHeader title={contact.display_name} context="Contact" />

      <Link href="/owner/contacts" className="text-xs text-text-muted hover:text-text">
        ← All contacts
      </Link>

      <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          <Card>
            <EmailComposer
              contactId={contact.id}
              contactEmail={contact.email}
              contactName={contact.display_name}
            />
          </Card>
          <Card>
            <TaskList contactId={contact.id} title="Follow-ups" />
          </Card>
          <Card>
            <InteractionTimeline parent="contacts" parentId={contact.id} title="Timeline" />
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <MonoLabel>Details</MonoLabel>
            <dl className="mt-3 space-y-2.5 text-xs">
              <div>
                <dt className="text-text-muted">Email</dt>
                <dd className="mt-0.5 font-medium break-words text-text">{contact.email ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-text-muted">Phone</dt>
                <dd className="mt-0.5 font-medium text-text tabular-nums">{phone ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-text-muted">Title</dt>
                <dd className="mt-0.5 font-medium break-words text-text">{contact.title ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-text-muted">Calls</dt>
                <dd className="mt-0.5 font-medium text-text tabular-nums">{contact.call_count}</dd>
              </div>
              <div>
                <dt className="text-text-muted">Last activity</dt>
                <dd className="mt-0.5 font-medium text-text tabular-nums">
                  {relativeTime(contact.last_activity_at)}
                </dd>
              </div>
            </dl>
          </Card>

          <Card>
            <CustomFieldEditor parent="contacts" parentId={contact.id} />
          </Card>

          <Card>
            <MonoLabel>Deals</MonoLabel>
            {deals.length === 0 ? (
              <p className="mt-3 text-xs text-text-muted">
                {/* dealsResponse is null for ANY fetch failure — network error,
                    404, 500 — not specifically a 403, so this stays neutral
                    rather than implying a permissions problem. */}
                {dealsResponse === null ? "Deals unavailable." : "No deals for this contact."}
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-border rounded-md border border-border">
                {deals.map((deal) => (
                  <li key={deal.id} className="px-3 py-2">
                    <span className="block truncate text-xs font-medium text-text">
                      {deal.name}
                    </span>
                    <span className="mt-0.5 flex items-center gap-2">
                      <StatusChip tone={deal.status === "won" ? "solid" : "muted"}>
                        {deal.stage}
                      </StatusChip>
                      <span className="text-xs text-text-muted tabular-nums">
                        {formatValue(deal.amount)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
