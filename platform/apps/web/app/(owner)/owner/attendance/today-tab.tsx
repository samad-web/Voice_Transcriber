import Link from "next/link";
import { Card, MonoLabel } from "@aura/ui";
import { formatDateKey, timeZoneLabel } from "@aura/shared";
import { LoadFailure } from "@/components/load-failure";
import type { AttendanceSettings, TodayResponse } from "@/lib/attendance";
import { ownerTry } from "@/lib/owner-context";
import { TodayBoard } from "./today-board";

/**
 * Today (doc 33 §7.1). The API scopes the rows by persona - a telecaller gets
 * their own - so the page renders what it is given.
 *
 * An owner or manager also reads the workspace switch, so a board of "No
 * handset" rows on a workspace that never turned tracking on says why.
 */
export async function TodayTab({ role, fallbackZone }: { role: string; fallbackZone: string }) {
  const manages = role === "owner" || role === "manager";
  const [today, settings] = await Promise.all([
    ownerTry<TodayResponse>("/v1/owner/attendance/today"),
    manages ? ownerTry<AttendanceSettings>("/v1/owner/attendance/settings") : Promise.resolve(null),
  ]);

  if (!today.ok) return <LoadFailure what="today's attendance" failure={today} />;
  const data = today.data;
  const zone = data.timeZone || fallbackZone;
  const trackingOff = settings?.ok === true && !settings.data.enabled;

  return (
    <>
      <p className="text-xs text-text-muted tabular-nums">
        <span className="font-medium text-text">{formatDateKey(data.date)}</span> · times in{" "}
        {timeZoneLabel(zone)} · updates live as phones report
      </p>

      {trackingOff ? (
        <Card className="space-y-1.5">
          <MonoLabel>Attendance tracking is off</MonoLabel>
          <p className="text-sm text-text-muted">
            No phone records anything until it is switched on in{" "}
            <Link href="/owner/settings/attendance" className="text-accent-text underline-offset-2 hover:underline">
              Attendance settings
            </Link>
            .
          </p>
        </Card>
      ) : null}

      {manages && data.unassignedHandsets > 0 ? (
        <Card className="space-y-1.5">
          <MonoLabel>
            {data.unassignedHandsets === 1
              ? "1 handset is not assigned to a telecaller"
              : `${data.unassignedHandsets} handsets are not assigned to a telecaller`}
          </MonoLabel>
          <p className="text-sm text-text-muted">
            Their attendance cannot be shown against anybody.{" "}
            <Link href="/owner/devices" className="text-accent-text underline-offset-2 hover:underline">
              Assign them on the Phones page
            </Link>
            .
          </p>
        </Card>
      ) : null}

      <TodayBoard
        rows={data.rows}
        date={data.date}
        zone={zone}
        canOverride={manages}
        own={role === "telecaller"}
      />
    </>
  );
}
