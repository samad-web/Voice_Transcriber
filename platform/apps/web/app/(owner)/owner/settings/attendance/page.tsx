import type { Metadata } from "next";
import { todayIn } from "@aura/shared";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import type {
  AttendanceException,
  AttendanceSettings,
  PeopleResponse,
  ShiftPattern,
} from "@/lib/attendance";
import { getOrgTimeZone } from "@/lib/org-time";
import { ownerTry, requireFeature, requireOwnerRoles } from "@/lib/owner-context";
import { AbsenceMessageEditor } from "./absence-message-editor";
import { ExceptionsEditor } from "./exceptions-editor";
import { PatternsEditor } from "./patterns-editor";
import { PeopleTable } from "./people-table";
import { AttendanceSettingsForm } from "./settings-form";

export const metadata: Metadata = { title: "Attendance settings" };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** `?month=YYYY-MM`, or this month in the workspace's own calendar. */
function resolveMonth(raw: string | string[] | undefined, today: string): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return value;
  return today.slice(0, 7);
}

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const index = y! * 12 + (m! - 1) + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function lastDayOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const days = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return `${month}-${String(days).padStart(2, "0")}`;
}

/**
 * Settings → Team → Attendance (Build docs/33 §7.1).
 *
 * Owner and manager only, matching `@RequireOwnerRole("owner", "manager")` on
 * every owner attendance write; anybody else is sent home by
 * `requireOwnerRoles` before a single fetch, the console's usual courtesy.
 * The API is still what refuses.
 *
 * Four independent reads - settings, patterns, people and one month of
 * exceptions - fetched together. Settings failing is the page failing; each
 * of the others degrades to its own error banner, so a broken exceptions
 * query does not hide the switch that turns tracking off.
 */
export default async function AttendanceSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/settings/attendance");
  await requireOwnerRoles(["owner", "manager"]);

  const sp = await searchParams;
  const orgZone = await getOrgTimeZone();
  const month = resolveMonth(sp.month, todayIn(orgZone));
  const range = new URLSearchParams({ from: `${month}-01`, to: lastDayOf(month) });

  const [settings, patterns, people, exceptions] = await Promise.all([
    ownerTry<AttendanceSettings>("/v1/owner/attendance/settings"),
    ownerTry<{ patterns: ShiftPattern[] }>("/v1/owner/attendance/patterns"),
    ownerTry<PeopleResponse>("/v1/owner/attendance/people"),
    ownerTry<{ exceptions: AttendanceException[] }>(`/v1/owner/attendance/exceptions?${range}`),
  ]);

  if (!settings.ok) {
    return (
      <>
        <PageHeader title="Attendance settings" context="Settings" />
        <LoadFailure what="attendance settings" failure={settings} />
      </>
    );
  }

  const zone = settings.data.timeZone || orgZone;
  const [y, m] = month.split("-").map(Number);
  const monthLabel = `${MONTHS[m! - 1]} ${y}`;
  const patternList = patterns.ok ? patterns.data.patterns : [];
  const peopleList = people.ok ? people.data.people : [];

  return (
    <>
      <PageHeader title="Attendance settings" context="Settings" />

      <AttendanceSettingsForm initial={settings.data} />

      {/* Under the alert settings, because it is the wording of one of them. */}
      <div className="mt-4">
        <AbsenceMessageEditor initial={settings.data} />
      </div>

      {patterns.ok ? (
        <PatternsEditor initial={patternList} zone={zone} />
      ) : (
        <LoadFailure what="shift patterns" failure={patterns} />
      )}

      {exceptions.ok ? (
        <ExceptionsEditor
          initial={exceptions.data.exceptions}
          people={peopleList}
          month={month}
          monthLabel={monthLabel}
          prevHref={`/owner/settings/attendance?month=${shiftMonth(month, -1)}`}
          nextHref={`/owner/settings/attendance?month=${shiftMonth(month, 1)}`}
          zone={zone}
        />
      ) : (
        <LoadFailure what="holidays and exceptions" failure={exceptions} />
      )}

      {people.ok ? (
        <PeopleTable initial={peopleList} approvers={people.data.approvers} patterns={patternList} />
      ) : (
        <LoadFailure what="the people table" failure={people} />
      )}
    </>
  );
}
