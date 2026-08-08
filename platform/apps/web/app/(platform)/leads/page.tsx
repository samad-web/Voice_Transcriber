import { PageHeader } from "@/components/page-header";
import { listLeadsAction, listMessageTemplatesAction } from "./actions";
import { LeadsTabs } from "./leads-tabs";

/**
 * Funnel leads — enquiries from the marketing site, the door from an enquiry to
 * a provisioned client, and the WhatsApp copy sent along the way.
 *
 * Reads through the operator API rather than the database directly, like every
 * other page in this group: the marketing schema is reachable only by the role
 * that owns it, which apps/api holds and the console does not.
 *
 * `state=open` by default. An operator working this page is looking for who to
 * call next, and a list where converted customers outnumber live enquiries by
 * ten to one is a list nobody uses.
 *
 * Both fetches run CONCURRENTLY and fail independently. Awaiting them in
 * sequence would make the templates tab wait on a leads query it has nothing to
 * do with, and a single try/catch around both would mean one unreachable
 * endpoint blanked the other tab.
 */
export default async function LeadsPage() {
  const [leadsResult, templatesResult] = await Promise.all([
    listLeadsAction("open"),
    listMessageTemplatesAction(),
  ]);

  return (
    <>
      <PageHeader title="Funnel Leads" context="Platform" />

      <p className="max-w-xl font-sans text-xs font-medium text-neutral-500">
        Enquiries from the marketing site. Converting one provisions a client
        instance and returns its enrollment key once.
      </p>

      <LeadsTabs
        leads={leadsResult.leads ?? []}
        leadsError={leadsResult.error}
        templates={templatesResult.templates ?? []}
        templatesError={templatesResult.error}
        maxLength={templatesResult.maxLength ?? 1200}
      />
    </>
  );
}
