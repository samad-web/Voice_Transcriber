import type { Metadata } from "next";
import { Card, EmptyState } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { getPortal, portalGet } from "../../portal-context";
import { ProfileForm } from "./profile-form";

export const metadata: Metadata = { title: "Profile" };

interface Profile {
  partner: {
    id: string;
    name: string;
    kind: string;
    code: string;
    status: string;
    email: string | null;
    onboarded_at: string | null;
    created_at: string;
  };
  people: Array<{ id: string; role: string; created_at: string; email: string; name: string | null }>;
  me: { id: string; role: string; email: string; name: string | null };
}

const KIND_LABEL: Record<string, string> = {
  broker: "Broker",
  dealer: "Dealer",
  referrer: "Referrer",
  reseller: "Reseller",
};

/**
 * Screen five (Build docs/39 §19): what the tenant's record of this partner
 * says, who is on the account, and the one field the partner may change.
 *
 * `people` lists this partner's own colleagues and nobody else's - the
 * `partner_isolation` policy 0162 puts on `partner_users` is RESTRICTIVE, so
 * it is ANDed with the org policy rather than ORed with it, and the query that
 * feeds this cannot return another partner's contacts even if it forgot its
 * WHERE clause.
 */
export default async function PortalProfilePage() {
  const [portal, data] = await Promise.all([getPortal(), portalGet<Profile>("/v1/portal/profile")]);

  if (!data) {
    return (
      <>
        <PageHeader title="Profile" />
        <EmptyState
          title="We couldn't load your profile"
          description="The portal didn't answer. Reload the page in a moment."
        />
      </>
    );
  }

  const { partner, people, me } = data;

  return (
    <>
      <PageHeader
        title="Profile"
        description={`Your details, as ${portal?.workspace.name || "the team"} has them.`}
      />

      <Card className="space-y-4">
        <h2 className="text-base font-semibold text-text">You</h2>
        <ProfileForm name={me.name ?? ""} />
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-md border border-border bg-surface-hover p-3 text-sm">
          <dt className="text-text-muted">Email</dt>
          <dd className="min-w-0 break-all text-text">{me.email}</dd>
          <dt className="text-text-muted">Your role</dt>
          <dd className="text-text">{me.role === "owner" ? "Account owner" : "Member"}</dd>
        </dl>
      </Card>

      <Card className="space-y-4">
        <h2 className="text-base font-semibold text-text">{partner.name}</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-text-muted">Type</dt>
          <dd className="text-text">{KIND_LABEL[partner.kind] ?? partner.kind}</dd>
          <dt className="text-text-muted">Referral code</dt>
          <dd className="font-medium text-text">{partner.code}</dd>
          {partner.email ? (
            <>
              <dt className="text-text-muted">Account email</dt>
              <dd className="min-w-0 break-all text-text">{partner.email}</dd>
            </>
          ) : null}
          {partner.onboarded_at ? (
            <>
              <dt className="text-text-muted">Partner since</dt>
              <dd className="text-text">{partner.onboarded_at.slice(0, 10)}</dd>
            </>
          ) : null}
        </dl>
        {/* Says who owns these fields, so nobody looks for an Edit button that
            is deliberately absent. */}
        <p className="text-xs leading-relaxed text-text-muted">
          {portal?.workspace.name || "The team"} maintains these. Ask them if anything needs
          changing.
        </p>
      </Card>

      {people.length > 1 ? (
        <Card className="space-y-3">
          <h2 className="text-base font-semibold text-text">People on this account</h2>
          <ul className="divide-y divide-border text-sm">
            {people.map((person) => (
              <li key={person.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <span className="min-w-0 break-words text-text">{person.name || person.email}</span>
                <span className="text-xs text-text-muted">
                  {person.role === "owner" ? "Account owner" : "Member"}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}
