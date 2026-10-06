import type { Metadata } from "next";
import { Card } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { getPortal } from "../portal-context";
import { SubmitLeadForm } from "./submit-form";

export const metadata: Metadata = { title: "Submit a lead" };

/**
 * The portal's landing screen, and deliberately the form rather than a
 * dashboard.
 *
 * A channel partner opens this surface to do exactly one thing. A summary of
 * their own numbers on arrival would be a screen they have to get past to do
 * it, and the numbers are one tab away under My submissions - where somebody
 * who actually wants them has gone looking.
 */
export default async function PortalSubmitPage() {
  const portal = await getPortal();

  return (
    <>
      <PageHeader
        title="Submit a lead"
        context={portal?.partner.code ? `Referral code ${portal.partner.code}` : undefined}
        description={`Send an enquiry to ${portal?.workspace.name || "the team"}. They'll come back to you with the outcome.`}
      />
      <Card className="space-y-5">
        <SubmitLeadForm />
      </Card>
    </>
  );
}
