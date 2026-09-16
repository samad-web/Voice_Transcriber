import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { INTEGRATIONS, integrationsByCategory, type IntegrationStatus } from "@aura/shared";
import { Card, MonoLabel, StatusChip } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerGet, requireFeature } from "@/lib/owner-context";

export const metadata: Metadata = { title: "Integrations" };

/**
 * One page that answers both questions a customer actually asks: what can this
 * connect to, and what IS connected.
 *
 * ── WHY THIS EXISTS WHEN EVERY ONE OF THESE WAS ALREADY REACHABLE ───────────
 *
 * Google was under Connections, WhatsApp under Messaging setup, Meta lead ads
 * on their own page, a spreadsheet under Lead sources, Razorpay inside an
 * invoice. Five places, and no page that answered either question - so the
 * honest reply to a prospect asking "does it do WhatsApp" was a tour of the
 * console, and the honest reply to a customer asking "is my sheet still
 * syncing" was to go and look.
 *
 * It deliberately does NOT configure anything. Every card links to the page
 * that already owns that integration, because a second place to set up a
 * WhatsApp channel is a second place for the two to disagree.
 *
 * ── THREE KINDS OF "NO" ─────────────────────────────────────────────────────
 *
 * Not connected is a button. Not available means the OPERATOR has not
 * configured the deployment - no Google OAuth app - and no button the customer
 * presses will help. Not on your plan is a sales conversation. They read
 * differently here because they are answered by different people, and
 * collapsing them into one grey chip is how a customer ends up in support
 * being told to reconnect something that was never available to them.
 */
export default async function IntegrationsPage() {
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/integrations");
  const owner = await getOwner();
  if (!owner) redirect("/dashboard");
  const role = owner.membership.ownerRole;
  if (role !== "owner" && role !== "manager") redirect("/owner");

  const data = await ownerGet<{ integrations: IntegrationStatus[] }>("/v1/owner/integrations");
  const byId = new Map((data?.integrations ?? []).map((s) => [s.id, s]));

  const connected = (data?.integrations ?? []).filter((s) => s.connected).length;
  const groups = integrationsByCategory();

  return (
    <>
      <PageHeader title="Integrations" context="Workspace" />
      <p className="-mt-2 max-w-prose text-sm leading-relaxed text-text-muted">
        Everything Aura can be joined to, and what is joined up right now.{" "}
        <span className="text-text">
          {connected} of {INTEGRATIONS.length} connected.
        </span>{" "}
        Nothing here sends anything on its own — a message goes out when a person presses send.
      </p>

      {groups.map((group) => (
        <section key={group.category} className="space-y-2">
          <MonoLabel>{group.label}</MonoLabel>
          <div className="grid gap-2 md:grid-cols-2">
            {group.items.map((spec) => {
              const status = byId.get(spec.id);
              return (
                <Link
                  key={spec.id}
                  href={spec.href}
                  className="block rounded-lg border border-border p-3 transition-colors hover:border-border-strong"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-text">{spec.label}</span>
                    <Badge status={status} />
                  </span>
                  <span className="mt-1 block max-w-prose text-xs leading-relaxed text-text-muted">
                    {spec.blurb}
                  </span>
                  {/* The failure, on the card, in the provider's own words.
                      A tenant whose sheet stopped syncing three weeks ago
                      should find that out here rather than by noticing the
                      leads stopped. */}
                  {status?.lastError ? (
                    <span className="mt-1.5 block text-xs text-danger-text">
                      {status.lastError}
                    </span>
                  ) : null}
                  {status?.unavailable ? (
                    <span className="mt-1.5 block text-xs text-text-muted">
                      Your provider has not set this up on this deployment yet.
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        </section>
      ))}

      {data === null ? (
        <Card>
          <MonoLabel>Status unavailable</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The list above is what Aura supports. Whether each one is connected could not be read
            just now — the platform API did not answer.
          </p>
        </Card>
      ) : null}
    </>
  );
}

function Badge({ status }: { status: IntegrationStatus | undefined }) {
  if (!status) return <StatusChip tone="outline">unknown</StatusChip>;
  if (status.notEntitled) return <StatusChip tone="outline">not on your plan</StatusChip>;
  if (status.unavailable) return <StatusChip tone="outline">not available</StatusChip>;
  if (status.lastError && status.connected) return <StatusChip tone="danger">failing</StatusChip>;
  if (status.connected) {
    return (
      <StatusChip tone="solid">
        {status.count > 1 ? `${status.count} connected` : "connected"}
      </StatusChip>
    );
  }
  return <StatusChip tone="muted">not connected</StatusChip>;
}
