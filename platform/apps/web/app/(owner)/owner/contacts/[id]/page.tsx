import type { Metadata } from "next";
import Link from "next/link";
import { Card, MonoLabel, StatusChip } from "@aura/ui";
import { BreadcrumbLeaf } from "@/components/breadcrumbs";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { activitySourceFor } from "@/lib/crm-activity";
import { getOwner, ownerGet, ownerTry } from "@/lib/owner-context";
import { ContactActivity } from "../../contact-activity";
import { ContactDetails } from "../../contact-details";
import { CustomFieldEditor } from "../../custom-field-editor";
import { EmailComposer } from "../../email-composer";
import { dealHref, LinkedRecords } from "../../linked-records";
import { SourceChannelTag } from "../../source-channel-tag";
import { TaskList } from "../../task-list";
import { formatValue, type Contact, type Deal } from "../../types";

export const metadata: Metadata = { title: "Contact" };

/**
 * One person, everything about them, one scrolling page (the 360° record).
 *
 * A page rather than a drawer, unlike deals: a contact is a thing you link
 * someone to ("see Priya's history"), and the deal board's drawer pattern
 * exists because a card must stay in its column behind it.
 *
 * ── WHAT IS ON IT, AND WHY NOTHING IS BEHIND A TAB ──────────────────────────
 *
 * Who they are (edited in place), where they came from, what has happened
 * with them across every channel, what is owed next, and what they are buying.
 * Tabs would make "did anyone reply to her WhatsApp before we called?" a
 * question you answer by clicking between panels; one feed answers it by
 * reading down. The feed's filters narrow that same list in place.
 *
 * The activity feed is rendered on the server with the page, from the same
 * composed source the client refreshes from (lib/crm-activity.ts), so the core
 * of the record never arrives as a loading placeholder.
 */
export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Separate round trips on purpose: `GET /contacts/:id` and
  // `GET /contacts/:id/deals` are separately permission-gated (contact:view vs
  // deal:view), so a role that may see people but not pipeline still gets a
  // working page instead of a blanket 403.
  const [result, dealsResponse, owner] = await Promise.all([
    ownerTry<{ contact: Contact }>(`/v1/contacts/${id}`),
    ownerGet<{ deals: Deal[] }>(`/v1/contacts/${id}/deals`),
    getOwner(),
  ]);

  // `ownerTry` keeps the failures apart - network error, 403, 404, 500 - so the
  // banner below can say which one happened. Still not `notFound()`, which
  // would misreport a transient API outage as "this contact does not exist",
  // and this mirrors every list page in this area.
  if (!result.ok || !owner) {
    return (
      <>
        <PageHeader title="Contact" context="Contact" />
        {/* A null `owner` is the signed-out case, which `ownerTry` has already
            classified as `auth` on the same `getOwner()` - so `result` is
            always the failed arm here, and the first ternary branch is
            unreachable. It exists so this narrows for TypeScript. */}
        <LoadFailure
          what="this contact"
          failure={
            result.ok
              ? { ok: false, kind: "auth", status: 401, message: "Not signed in to a workspace." }
              : result
          }
        />
      </>
    );
  }
  const { contact } = result.data;
  const deals = dealsResponse?.deals ?? [];

  const [activity, lead] = await Promise.all([
    activitySourceFor(owner.membership).forContact(
      { id: contact.id, displayName: contact.display_name },
      owner,
    ),
    // The lead this person arrived as, for the source's NAME and campaign -
    // the contact row carries only the channel. Lead reads are persona-scoped,
    // so a refusal just means the tag shows the channel alone.
    contact.source_lead_id
      ? ownerGet<{
          lead: { source_channel: string | null; source_name: string | null; campaign_name: string | null };
        }>(`/v1/leads/${contact.source_lead_id}`)
      : Promise.resolve(null),
  ]);

  return (
    <>
      <BreadcrumbLeaf label={contact.display_name} />
      <PageHeader title={contact.display_name} context="Contact" />

      <div className="-mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <SourceChannelTag
          channel={contact.source_channel ?? lead?.lead.source_channel}
          sourceName={lead?.lead.source_name}
          campaignName={lead?.lead.campaign_name}
        />
        {contact.source_lead_id ? (
          // The lead this person was first created from, opened on the Lead
          // Board (doc 23, H2).
          <Link
            href={`/owner/board?focus=${contact.source_lead_id}`}
            className="text-xs font-medium text-accent-text hover:underline"
          >
            Open the original lead
          </Link>
        ) : null}
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-6">
          <Card>
            <ContactActivity contactId={contact.id} contactName={contact.display_name} initial={activity} />
          </Card>
          <Card>
            <TaskList contactId={contact.id} title="Follow-ups" />
          </Card>
          <Card>
            <EmailComposer
              contactId={contact.id}
              contactEmail={contact.email}
              contactName={contact.display_name}
            />
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <Card>
            <ContactDetails contact={contact} />
          </Card>

          <Card>
            <MonoLabel>Deals</MonoLabel>
            {deals.length === 0 ? (
              <p className="mt-3 text-xs text-text-muted">
                {/* dealsResponse is null for ANY fetch failure - network error,
                    404, 500 - not specifically a 403, so this stays neutral
                    rather than implying a permissions problem. */}
                {dealsResponse === null ? "Deals unavailable." : "No deals for this contact."}
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-border rounded-md border border-border">
                {deals.map((deal) => (
                  <li key={deal.id}>
                    {/* The deal opens in its own pipeline's board with its
                        drawer open (doc 23, H2). */}
                    <Link href={dealHref(deal)} className="block px-3 py-2 hover:bg-surface-hover">
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
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <LinkedRecords parent={{ contactId: contact.id }} showConversations />

          <Card>
            <CustomFieldEditor parent="contacts" parentId={contact.id} />
          </Card>
        </div>
      </div>
    </>
  );
}
