import type { Metadata } from "next";
import Link from "next/link";
import { attendanceTabsFor, resolveAttendanceTab } from "@/lib/attendance";
import { PageHeader } from "@/components/page-header";
import { getOrgTimeZone } from "@/lib/org-time";
import { requireFeature, requireOwnerRoles } from "@/lib/owner-context";
import { RequestsTab } from "./requests-tab";
import { ReviewTab } from "./review-tab";
import { TimesheetsTab } from "./timesheets-tab";
import { TodayTab } from "./today-tab";

export const metadata: Metadata = { title: "Attendance" };

/**
 * Reports → Attendance (Build docs/33 §7.1), four tabs in the URL
 * (`?tab=today|timesheets|requests|review`) so a link to the Requests tab -
 * which is what the WhatsApp alert sends a manager - opens the Requests tab.
 *
 * Owner, manager and telecaller. The API scopes every read by persona: a
 * telecaller's Today board is their own row, their timesheet is their own
 * days, their requests are their own, and they get no decide buttons and no
 * Review tab. The persona redirect below is the console's courtesy, not the
 * control.
 *
 * Live: the beacon handler and the worker announce on the `attendance` topic,
 * and the realtime provider re-renders this page from the server when they do.
 */
export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/attendance");
  const owner = await requireOwnerRoles(["owner", "manager", "telecaller"]);
  const role = owner.membership.ownerRole;

  const sp = await searchParams;
  const tab = resolveAttendanceTab(sp.tab, role);
  const zone = await getOrgTimeZone();
  const filter = Array.isArray(sp.filter) ? sp.filter[0] : sp.filter;

  return (
    <>
      <PageHeader
        title="Attendance"
        context="Reports"
        actions={
          role === "owner" || role === "manager" ? (
            <Link
              href="/owner/settings/attendance"
              className="text-sm font-medium text-accent-text underline-offset-2 hover:underline"
            >
              Shifts & settings
            </Link>
          ) : undefined
        }
      />

      <nav className="flex flex-wrap gap-1" aria-label="Attendance views">
        {attendanceTabsFor(role).map((t) => {
          const active = t.key === tab;
          return (
            <Link
              key={t.key}
              href={t.key === "today" ? "/owner/attendance" : `/owner/attendance?tab=${t.key}`}
              aria-current={active ? "page" : undefined}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                active
                  ? "border-border-strong bg-surface-hover font-medium text-text"
                  : "border-border text-text-muted hover:text-text"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>

      {tab === "today" ? <TodayTab role={role} fallbackZone={zone} /> : null}
      {tab === "timesheets" ? <TimesheetsTab role={role} zone={zone} searchParams={sp} /> : null}
      {tab === "requests" ? <RequestsTab role={role} zone={zone} filterParam={filter} /> : null}
      {tab === "review" ? <ReviewTab zone={zone} searchParams={sp} /> : null}
    </>
  );
}
