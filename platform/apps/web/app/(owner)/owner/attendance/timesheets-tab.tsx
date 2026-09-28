import { Download } from "lucide-react";
import { todayIn } from "@aura/shared";
import { DateRangeBar, DateRangeNotice, DateRangeSummary } from "@/components/date-range-bar";
import { LoadFailure } from "@/components/load-failure";
import type { PeopleResponse, TimesheetsResponse } from "@/lib/attendance";
import { dateWindowHref, parseDateWindow, rangePresets, resolveDateWindow } from "@/lib/date-range";
import { ownerTry } from "@/lib/owner-context";
import { PersonFilter } from "./person-filter";
import { TimesheetTable } from "./timesheet-table";

export const TIMESHEET_DEFAULT_DAYS = 7;
const PATH = "/owner/attendance";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Timesheets (doc 33 §7.1): per telecaller per day over the shared date range,
 * with the CSV of exactly the same rows.
 *
 * The API takes dates, so the window is resolved against the WORKSPACE's
 * today, never this server's UTC one (lib/date-range.ts).
 */
export async function TimesheetsTab({
  role,
  zone,
  searchParams,
}: {
  role: string;
  zone: string;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const manages = role === "owner" || role === "manager";
  const { window, invalid } = parseDateWindow(searchParams, { defaultDays: TIMESHEET_DEFAULT_DAYS });
  const rawPerson = Array.isArray(searchParams.telecallerId) ? searchParams.telecallerId[0] : searchParams.telecallerId;
  const telecallerId = manages && rawPerson && UUID.test(rawPerson) ? rawPerson : "";
  const today = todayIn(zone);
  const requested = resolveDateWindow(window, today);

  const query = new URLSearchParams({ ...requested, ...(telecallerId ? { telecallerId } : {}) });
  const [result, people] = await Promise.all([
    ownerTry<TimesheetsResponse>(`/v1/owner/attendance/timesheets?${query}`),
    manages ? ownerTry<PeopleResponse>("/v1/owner/attendance/people") : Promise.resolve(null),
  ]);

  const shown = { from: result.ok ? result.data.from : requested.from, to: result.ok ? result.data.to : requested.to };
  const keep = { tab: "timesheets", telecallerId: telecallerId || null };
  const opts = { defaultDays: TIMESHEET_DEFAULT_DAYS, keep };

  const personList = people?.ok ? people.data.people.map((p) => ({ id: p.telecallerId, name: p.name })) : [];
  const hrefFor: Record<string, string> = Object.fromEntries(
    ["", ...personList.map((p) => p.id)].map((id) => [
      id,
      dateWindowHref(PATH, window, { defaultDays: TIMESHEET_DEFAULT_DAYS, keep: { tab: "timesheets", telecallerId: id || null } }),
    ]),
  );

  // A plain link the browser downloads; the basePath is added by hand because
  // Next only prefixes its own <Link>s (lib/call-insights.ts does the same).
  const csvHref = `${(process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "")}${PATH}/export?${new URLSearchParams(
    { from: shown.from, to: shown.to, ...(telecallerId ? { telecallerId } : {}) },
  )}`;

  return (
    <>
      <DateRangeBar
        path={PATH}
        presets={rangePresets(PATH, window, opts)}
        from={shown.from}
        to={shown.to}
        keep={keep}
        today={today}
        aside={
          result.ok && result.data.rows.length > 0 ? (
            <a
              href={csvHref}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-text hover:underline"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Download CSV
            </a>
          ) : null
        }
      />
      {invalid ? <DateRangeNotice fallbackDays={TIMESHEET_DEFAULT_DAYS} /> : null}
      <DateRangeSummary from={shown.from} to={shown.to} zone={zone} />

      {manages && personList.length > 0 ? (
        <PersonFilter people={personList} value={telecallerId} hrefFor={hrefFor} />
      ) : null}

      {result.ok ? (
        <TimesheetTable rows={result.data.rows} zone={zone} canOverride={manages} showName={role !== "telecaller"} />
      ) : (
        <LoadFailure what="timesheets" failure={result} />
      )}
    </>
  );
}
