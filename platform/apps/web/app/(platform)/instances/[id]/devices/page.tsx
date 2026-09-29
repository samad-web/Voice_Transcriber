import { Boxes, KeyRound, Smartphone } from "lucide-react";
import {
  EmptyState,
  StatusChip,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tooltip,
} from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import { operatorGate } from "@/lib/operator-gate";
import { CopyValue } from "../copy-value";
import { DeviceActions } from "../device-actions";
import { KeyGenerator } from "../key-generator";
import { TelecallerForm } from "../telecaller-form";
import { loadFleetHealth, loadInstanceDetails, loadInstances } from "../instance-data";
import {
  DEVICE_TONE,
  HEALTH_LABEL,
  HEALTH_TONE,
  InstanceHeading,
  KEY_TONE,
  SCROLLER,
  Section,
  TablePanel,
  healthTooltip,
} from "../instance-ui";

/**
 * This customer's handsets and the keys that enrol them.
 *
 * `#enrollment` is a real anchor here (the first instance's Enrollment section),
 * which is what the vitals strip's "Active keys" cell and Overview's "Issue
 * enrollment key" link point at. They used to be `data-goto-tab="devices"` plus
 * `data-goto-anchor="enrollment"`, resolved by a delegating click handler on the
 * old client-side tab strip; doc 34 Part B made every panel a route, so they are
 * ordinary URL fragments.
 */
export default async function InstanceDevicesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const blocked = await operatorGate();
  if (blocked) return blocked;

  const { id: orgId } = await params;
  const instances = await loadInstances(orgId);
  const [details, fleetHealth] = await Promise.all([
    loadInstanceDetails(orgId, instances),
    loadFleetHealth(orgId),
  ]);
  const healthByDevice = new Map(fleetHealth.map((h) => [h.deviceId, h]));
  const multi = instances.length > 1;

  return (
    <>
      {instances.length === 0 ? (
        <EmptyState
          icon={<Boxes className="h-8 w-8" />}
          title="This tenant has no enrollment target"
          description="There is no instance to enroll a handset against. Reprovision the customer to create one."
        />
      ) : null}

      {instances.map((inst, i) => {
        const detail = details[i];
        const devices = detail?.devices ?? [];
        const keys = detail?.keys ?? [];
        // Per instance, not the org-wide total: with two instances, a header
        // reading "3 need attention" over a table of five healthy handsets is
        // worse than no count at all.
        const instFlagged = devices.filter((d) => healthByDevice.get(d.id)?.needsAttention).length;
        const instConnected = devices.filter((d) => d.connected).length;
        return (
          <div key={inst.id} className="space-y-5">
            {multi ? <InstanceHeading inst={inst} /> : null}

            <TablePanel
              icon={<Smartphone className="h-4 w-4" />}
              title="Enrolled handsets"
              action={
                <span
                  className={
                    "text-xs tabular-nums " +
                    (instFlagged > 0 ? "font-medium text-danger-text" : "text-text-muted")
                  }
                >
                  {instConnected} of {devices.length} connected
                  {instFlagged > 0 ? ` · ${instFlagged} need attention` : ""}
                </span>
              }
              empty={
                devices.length === 0 ? (
                  <p className="px-5 py-8 text-center text-sm text-text-muted">
                    No devices enrolled - issue a key below to enroll the first handset
                  </p>
                ) : undefined
              }
            >
              <div
                tabIndex={0}
                role="region"
                aria-label={`Devices, ${inst.name}`}
                className={SCROLLER}
              >
                {/* Was min-w-[1200px] across eight columns, which forced a
                    sideways scroll on every laptop. Status and health are one
                    stacked cell now (two chips, same glance) and the device id
                    is a copy target rather than 36 characters of column, which
                    brings the table inside a 1440px viewport. */}
                <table className="w-full min-w-[980px] border-collapse text-left text-sm">
                  <caption className="sr-only">Enrolled devices for {inst.name}</caption>
                  <TableHead>
                    <tr>
                      <TableHeaderCell>Device</TableHeaderCell>
                      <TableHeaderCell>Telecaller</TableHeaderCell>
                      <TableHeaderCell>Capability</TableHeaderCell>
                      <TableHeaderCell>Fingerprint</TableHeaderCell>
                      <TableHeaderCell>Last seen</TableHeaderCell>
                      <TableHeaderCell>State</TableHeaderCell>
                      <TableHeaderCell className="text-right">Actions</TableHeaderCell>
                    </tr>
                  </TableHead>
                  <TableBody>
                    {devices.map((device) => {
                      const health = healthByDevice.get(device.id);
                      const staleness = health?.staleness ?? "never";
                      const tone = health?.needsAttention ? "danger" : HEALTH_TONE[staleness];
                      return (
                        <TableRow key={device.id}>
                          <TableCell className="py-2.5">
                            <span className="block text-sm font-medium text-text">
                              {device.label ?? "Unlabeled device"}
                            </span>
                            <CopyValue
                              value={device.id}
                              label="device ID"
                              className="-ml-1.5 mt-0.5 max-w-[24ch] text-text-muted"
                            />
                          </TableCell>
                          <TableCell className="py-2.5">
                            <TelecallerForm
                              orgId={orgId}
                              deviceId={device.id}
                              name={device.telecaller_name}
                              externalId={device.telecaller_external_id}
                            />
                          </TableCell>
                          <TableCell className="py-2.5">
                            <StatusChip tone={device.capture_capability ? "muted" : "outline"}>
                              {device.capture_capability ?? "unprobed"}
                            </StatusChip>
                          </TableCell>
                          <TableCell
                            className="max-w-[14ch] truncate py-2.5 font-mono text-xs text-text-muted"
                            title={device.fingerprint ?? undefined}
                          >
                            {device.fingerprint ?? "-"}
                          </TableCell>
                          <TableCell className="py-2.5">
                            {device.last_seen_at ? (
                              <>
                                <LocalTime
                                  iso={device.last_seen_at}
                                  mode="date"
                                  className="block text-xs text-text tabular-nums"
                                />
                                <LocalTime
                                  iso={device.last_seen_at}
                                  mode="time"
                                  className="block text-xs text-text-muted tabular-nums"
                                />
                              </>
                            ) : (
                              <span className="text-xs text-text-muted">-</span>
                            )}
                          </TableCell>
                          <TableCell className="py-2.5">
                            <div className="flex flex-col items-start gap-1">
                              <StatusChip tone={DEVICE_TONE[device.status]}>
                                {device.status}
                              </StatusChip>
                              <Tooltip content={healthTooltip(health)}>
                                {/* Tooltip's trigger must itself be focusable
                                    (Tooltip's own doc comment) - a bare
                                    StatusChip <span> would never show this to a
                                    keyboard user. */}
                                <button type="button" className="cursor-default rounded-full">
                                  <StatusChip tone={tone}>{HEALTH_LABEL[staleness]}</StatusChip>
                                </button>
                              </Tooltip>
                            </div>
                          </TableCell>
                          <TableCell className="py-2.5">
                            <DeviceActions
                              orgId={orgId}
                              deviceId={device.id}
                              label={device.label ?? "this device"}
                              status={device.status}
                              callCount={device.call_count}
                              leadCount={device.lead_count}
                            />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </table>
              </div>
            </TablePanel>

            <Section
              // Only the first gets the shared anchor - "Issue enrollment key"
              // has to mean one destination, and with a single instance (every
              // customer so far) that is the only one there is.
              id={i === 0 ? "enrollment" : undefined}
              title="Enrollment"
              description={`Keys that let a new handset join ${inst.name}. Each one is shown exactly once.`}
            >
              <div className="space-y-5">
                <KeyGenerator orgId={orgId} instanceId={inst.id} instanceName={inst.name} />

                <TablePanel
                  icon={<KeyRound className="h-4 w-4" />}
                  title="Issued keys"
                  action={
                    <span className="text-xs text-text-muted tabular-nums">
                      {keys.filter((k) => k.status === "active").length} active of {keys.length}
                    </span>
                  }
                  empty={
                    keys.length === 0 ? (
                      <p className="px-5 py-8 text-center text-sm text-text-muted">
                        No keys issued
                      </p>
                    ) : undefined
                  }
                >
                  <div
                    tabIndex={0}
                    role="region"
                    aria-label={`Enrollment keys, ${inst.name}`}
                    className={SCROLLER}
                  >
                    <table className="w-full min-w-[560px] border-collapse text-left text-sm">
                      <caption className="sr-only">Enrollment keys for {inst.name}</caption>
                      <TableHead>
                        <tr>
                          <TableHeaderCell>Issued</TableHeaderCell>
                          <TableHeaderCell>Expires</TableHeaderCell>
                          <TableHeaderCell className="text-right">Uses</TableHeaderCell>
                          <TableHeaderCell>Status</TableHeaderCell>
                        </tr>
                      </TableHead>
                      <TableBody>
                        {keys.map((key) => (
                          <TableRow key={key.id}>
                            <TableCell className="py-2.5">
                              <LocalTime
                                iso={key.created_at}
                                className="text-xs text-text tabular-nums"
                              />
                            </TableCell>
                            <TableCell className="py-2.5">
                              <LocalTime
                                iso={key.expires_at}
                                className="text-xs text-text-muted tabular-nums"
                              />
                            </TableCell>
                            <TableCell className="py-2.5 text-right font-mono text-xs tabular-nums">
                              {key.use_count}/{key.max_uses}
                            </TableCell>
                            <TableCell className="py-2.5">
                              <StatusChip tone={KEY_TONE[key.status]}>{key.status}</StatusChip>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </table>
                  </div>
                </TablePanel>
              </div>
            </Section>
          </div>
        );
      })}
    </>
  );
}
