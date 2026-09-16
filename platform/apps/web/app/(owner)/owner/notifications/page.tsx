import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OWNER_ROLE_ADMINS } from "@aura/shared";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerGet } from "@/lib/owner-context";
import type { NotificationPreferences } from "./actions";
import { NotificationSettings } from "./notification-settings";
import { ResponseSlaForm } from "./response-sla-form";

export const metadata: Metadata = { title: "Notifications" };

/**
 * A person's notification settings (CRM dashboard Phase 7, migration 0109):
 * Instant or Digest per kind, and - for owners and managers - the response
 * time target the "Response time missed" notification measures against.
 *
 * No persona restriction on the page: every person has a bell. The SLA card is
 * the owner/manager half and is simply not rendered for anyone else.
 */
export default async function NotificationsPage() {
  const owner = await getOwner();
  if (!owner) notFound();

  const isAdmin = OWNER_ROLE_ADMINS.includes(owner.membership.ownerRole);
  const [preferences, sla] = await Promise.all([
    ownerGet<NotificationPreferences>("/v1/notifications/preferences"),
    isAdmin ? ownerGet<{ minutes: number }>("/v1/owner/lead-routing/response-sla") : Promise.resolve(null),
  ]);

  return (
    <>
      <PageHeader title="Notifications" context="Your account" />

      <Card>
        <MonoLabel>How you hear about things</MonoLabel>
        <p className="mt-2 mb-4 text-sm text-text-muted">
          Instant shows a notification in the bell as soon as it happens. Digest holds it and shows
          that day&apos;s held notifications together at the hour you pick.
        </p>
        {preferences ? (
          <NotificationSettings initial={preferences} />
        ) : (
          <p className="text-sm text-text-muted">
            Your settings couldn&apos;t be loaded. Notification settings belong to a signed-in person, so
            this page needs a personal login rather than a shared key.
          </p>
        )}
      </Card>

      {isAdmin ? (
        <Card>
          <MonoLabel>Response time</MonoLabel>
          <p className="mt-2 mb-4 text-sm text-text-muted">
            Applies to everyone in this organisation. The assigned telecaller and every owner and manager
            are told when a new lead waits longer than this for a first response.
          </p>
          {sla ? (
            <ResponseSlaForm initial={sla.minutes} />
          ) : (
            <p className="text-sm text-text-muted">The response time couldn&apos;t be loaded right now.</p>
          )}
        </Card>
      ) : null}
    </>
  );
}
