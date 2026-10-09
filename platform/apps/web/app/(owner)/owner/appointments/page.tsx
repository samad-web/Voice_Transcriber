import type { Metadata } from "next";
import { DEFAULT_TIME_ZONE } from "@aura/shared";
import { APPOINTMENT_TYPE_SUGGESTIONS } from "@aura/shared/dist/appointments";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerTry, requireFeature, requireOwnerRoles } from "@/lib/owner-context";
import type { ResourceView } from "../resources/resources-console";
import { AppointmentsConsole, type AppointmentView } from "./appointments-console";

export const metadata: Metadata = { title: "Appointments" };

/** The day the diary opens on, as YYYY-MM-DD in the workspace's own zone. */
function todayInZone(zone: string): string {
  // `en-CA` gives YYYY-MM-DD, which is what the API's `from`/`to` want and what
  // an <input type="date"> reads. Formatted in the ORG's zone rather than the
  // server's: a Mumbai VPS rendering "today" for a Dubai desk at 02:00 would
  // open the diary on yesterday.
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date());
}

/**
 * The diary (Build docs/40 §B2, migration 0166).
 *
 * 0166 built the table, the RLS, the booking and attendance routes, calendar
 * sync and the reschedule tokens - and no console ever opened any of it, so a
 * clinic could be sold "Appointment booked" as a pipeline stage and have
 * nowhere to see the appointment (doc 40, F5 and F8).
 *
 * ── OWNER, MANAGER AND THE FLOOR ───────────────────────────────────────────
 *
 * Wider than the other two Phase B pages, and deliberately so. A diary is the
 * day's work: the person who booked the site visit is the person who needs to
 * see it, move it and say whether anybody turned up. `appointment:view` and
 * `appointment:edit` both reach `workspace_member` in 0166 for that reason, and
 * `OwnerScopeGuard` narrows a telecaller's list to their own rows server-side -
 * so this page does not have to decide who may see whose.
 *
 * `appointment:create` is wider than the admin roles too: booking is the thing
 * a rep does while the customer is still on the phone.
 */
export default async function AppointmentsPage() {
  await requireFeature("/owner/appointments");
  await requireOwnerRoles(["owner", "manager", "telecaller", "sales"]);

  const owner = await getOwner();
  const zone = owner?.membership.reportingTimezone ?? DEFAULT_TIME_ZONE;
  const today = todayInZone(zone);

  const [list, resources] = await Promise.all([
    // The whole diary from today forward, not a single day: the first question
    // somebody opens this page with is "what is coming", and a day view that
    // starts empty on a quiet Tuesday reads as a broken page. The console
    // groups by date and lets the reader jump.
    ownerTry<{ appointments: AppointmentView[]; total: number }>(
      `/v1/appointments?from=${today}T00:00:00Z&limit=200`,
    ),
    // For the room/chair picker. A diary is usable without it - an appointment
    // need not consume a resource - so a failure here is not worth the page.
    ownerTry<{ resources: ResourceView[] }>("/v1/resources?availableOnly=1&limit=200"),
  ]);

  if (!list.ok) {
    return (
      <>
        <PageHeader title="Appointments" context="Customers" />
        <LoadFailure what="your appointments" failure={list} />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Appointments" context="Customers" />
      <AppointmentsConsole
        initial={list.data.appointments}
        timeZone={zone}
        types={[...APPOINTMENT_TYPE_SUGGESTIONS]}
        resources={resources.ok ? resources.data.resources : []}
      />
    </>
  );
}
