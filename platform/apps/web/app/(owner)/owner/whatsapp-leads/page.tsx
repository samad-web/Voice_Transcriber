import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { QualificationQueue } from "./queue-client";

export const metadata: Metadata = { title: "WhatsApp leads - Aura" };

/**
 * WhatsApp qualification review (migration 0080).
 *
 * The screen that closes the gap 0055 left: an enquiry from a number nobody
 * recognises used to land in the unmatched inbox and stop there. A worker sweep
 * now reads those threads and proposes a lead; this is where a person accepts
 * or refuses one. Nothing reaches the CRM without that click.
 */
export default function WhatsAppLeadsPage() {
  return (
    <>
      <PageHeader title="WhatsApp leads" context="Pipeline" />

      <div className="space-y-4">
        <Card>
          <MonoLabel>How this works</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            Inbound WhatsApp threads from numbers that match no contact are read and scored.
            Approving one creates the contact, lead and deal, and claims the thread onto that
            contact. Nothing here messages anyone.
          </p>
        </Card>

        <Card>
          <QualificationQueue />
        </Card>
      </div>
    </>
  );
}
