import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Smartphone } from "lucide-react";
import {
  Card,
  EmptyState,
  MonoLabel,
  StatusChip,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tooltip,
} from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerGet } from "@/lib/owner-context";

export const metadata: Metadata = { title: "Handsets - Aura" };

interface DeviceRow {
  id: string;
  label: string | null;
  status: "active" | "logged_out" | "wiped" | "lost";
  last_seen_at: string | null;
  telecaller_name: string | null;
  connected: boolean;
}

/** Mirrors devices.controller.ts's GET /devices/fleet-health response shape -
 *  the same contract the operator console's instance page reads. */
interface FleetHealthRow {
  deviceId: string;
  staleness: "never" | "<1h" | "1-24h" | "1-7d" | "stale";
  needsAttention: boolean;
  attentionReasons: string[];
}

const DEVICE_TONE = {
  active: "solid",
  logged_out: "muted",
  wiped: "danger",
  lost: "danger",
} as const;

const HEALTH_TONE = {
  "<1h": "solid",
  "1-24h": "muted",
  "1-7d": "muted",
  stale: "danger",
  never: "outline",
} as const;

const HEALTH_LABEL = {
  "<1h": "Active <1h",
  "1-24h": "Seen 1-24h ago",
  "1-7d": "Seen 1-7d ago",
  stale: "Stale 7d+",
  never: "Never seen",
} as const;

/**
 * The fleet, as the customer sees it - read-only.
 *
 * Provisioning a key, remote-wiping or removing a handset stays an operator
 * action on the other console (Instances -> instance -> Devices, see
 * device-actions.tsx there); this page answers the question an owner or
 * manager actually has day to day, "how many of our phones are working right
 * now", without handing them a button that can strand a telecaller mid-shift.
 *
 * `GET /v1/devices` and `/v1/devices/fleet-health` carry no OrgRoleGuard - any
 * admin-keyed caller scoped to this org can read them - so the persona check
 * below is the only gate. That is the same asymmetry nav.ts's comment on this
 * item already states, and matches how `/owner/transcription` relies on its
 * own server-side check for the same underlying reason (see that route).
 */
export default async function HandsetsPage() {
  const owner = await getOwner();
  if (!owner) redirect("/dashboard");

  const role = owner.membership.ownerRole;
  // Sent home, not shown a refusal: the nav never offered this page to them,
  // so arriving here means a stale bookmark or a shared link - see team/page.tsx
  // for the same reasoning on the same redirect.
  if (role !== "owner" && role !== "manager") redirect("/owner");

  const [list, fleetHealth] = await Promise.all([
    ownerGet<{ devices: DeviceRow[] }>("/v1/devices"),
    ownerGet<{ devices: FleetHealthRow[] }>("/v1/devices/fleet-health"),
  ]);

  if (!list) {
    return (
      <>
        <PageHeader title="Handsets" context="Settings" />
        <Card>
          <MonoLabel>Data unavailable</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The platform API did not answer. If this persists, contact your provider.
          </p>
        </Card>
      </>
    );
  }

  const devices = list.devices;
  const healthByDevice = new Map((fleetHealth?.devices ?? []).map((h) => [h.deviceId, h]));
  const connected = devices.filter((d) => d.connected).length;

  return (
    <>
      <PageHeader title="Handsets" context="Settings" />
      <p className="max-w-2xl text-sm text-text-muted">
        Every phone enrolled to record your calls, and whether it is reachable right now. To
        enroll a new one, remote-wipe, or take a phone out of the fleet, ask your provider.
      </p>

      {devices.length === 0 ? (
        <EmptyState
          icon={<Smartphone className="h-8 w-8" />}
          title="No handsets enrolled yet"
          description="Ask your provider to issue an enrollment key for the first phone."
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="flex items-center justify-between gap-3 border-b border-border bg-bg-subtle px-4 py-3">
            <div className="flex items-center gap-2">
              <Smartphone aria-hidden="true" className="h-4 w-4 text-text-muted" />
              <span className="text-sm font-medium text-text">Fleet</span>
            </div>
            <span className="text-xs text-text-muted tabular-nums">
              {connected} of {devices.length} connected
            </span>
          </div>
          <div tabIndex={0} role="region" aria-label="Handsets" className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left text-sm">
              <caption className="sr-only">Enrolled handsets</caption>
              <TableHead>
                <tr>
                  <TableHeaderCell>Device</TableHeaderCell>
                  <TableHeaderCell>Telecaller</TableHeaderCell>
                  <TableHeaderCell>Last seen</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Health</TableHeaderCell>
                </tr>
              </TableHead>
              <TableBody>
                {devices.map((device) => {
                  const health = healthByDevice.get(device.id);
                  const staleness = health?.staleness ?? "never";
                  const tone = health?.needsAttention ? "danger" : HEALTH_TONE[staleness];
                  return (
                    <TableRow key={device.id}>
                      <TableCell className="py-2.5 text-sm font-medium text-text">
                        {device.label ?? "Unlabeled device"}
                      </TableCell>
                      <TableCell className="py-2.5 text-sm text-text-muted">
                        {device.telecaller_name ?? "-"}
                      </TableCell>
                      <TableCell className="py-2.5">
                        {device.last_seen_at ? (
                          <LocalTime
                            iso={device.last_seen_at}
                            className="text-xs text-text-muted tabular-nums"
                          />
                        ) : (
                          <span className="text-xs text-text-muted">Never</span>
                        )}
                      </TableCell>
                      <TableCell className="py-2.5">
                        <StatusChip tone={DEVICE_TONE[device.status]}>{device.status}</StatusChip>
                      </TableCell>
                      <TableCell className="py-2.5">
                        <Tooltip
                          content={
                            health?.needsAttention
                              ? health.attentionReasons.join(", ")
                              : "No issues reported"
                          }
                        >
                          {/* Tooltip's trigger must itself be focusable (Tooltip's
                              own doc comment) - a bare StatusChip <span> would
                              never show this to a keyboard user. */}
                          <button type="button" className="cursor-default rounded-full">
                            <StatusChip tone={tone}>{HEALTH_LABEL[staleness]}</StatusChip>
                          </button>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
