import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Boxes, KeyRound, Phone, Smartphone, Timer } from "lucide-react";
import type { CrmProviderSpec } from "@aura/shared";
import {
  Card,
  EmptyState,
  MonoLabel,
  StatCard,
  StatusChip,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import { PageHeader } from "@/components/page-header";
import { apiGetAs } from "@/lib/server-api";
import { workspacesFor } from "@/lib/tenant-scope";
import type { CallRow } from "../../calls/calls-explorer";
import { CrmManager, type Integration } from "../../crm/crm-manager";
import { DeleteInstance } from "./delete-instance";
import { DeviceActions } from "./device-actions";
import { ErasureTool } from "./erasure-tool";
import { KeyGenerator } from "./key-generator";
import { OwnerAccounts, type OwnerRow } from "./owner-accounts";
import { PolicyForm } from "./policy-form";
import { AsrSettings } from "./asr-settings";
import { TranscriptionToggle } from "./transcription-toggle";

interface Org {
  id: string;
  name: string;
  status: "active" | "suspended" | "churned";
  consent_policy: string;
  on_consent_failure: string;
  retention_days: number;
  region: string;
  store_full_number: boolean;
  transcription_enabled: boolean;
  asr_language: string | null;
  asr_mode: string | null;
  vocabulary: string[] | null;
}

interface InstanceRow {
  id: string;
  name: string;
  workspace_id: string;
  config_version: number;
  created_at: string;
  device_count: number;
}

interface KeyRow {
  id: string;
  expires_at: string;
  max_uses: number;
  use_count: number;
  created_at: string;
  status: "active" | "expired" | "exhausted";
}

interface AuditEntry {
  id: string;
  actor_type: string;
  actor_id: string;
  action: string;
  target_type: string | null;
  created_at: string;
}

interface DeviceRow {
  id: string;
  label: string | null;
  fingerprint: string | null;
  status: "active" | "logged_out" | "wiped" | "lost";
  capture_capability: string | null;
  last_seen_at: string | null;
}

interface Overview {
  calls: { total: number; complete: number; failed: number; total_seconds: number };
}

/** How many recent calls to preview inline before sending the operator to the
 *  full explorer. Enough to see the instance is alive, short enough to scan. */
const CALL_PREVIEW = 5;

const CALL_TONE = (status: string): "solid" | "muted" | "danger" =>
  status === "COMPLETE" ? "solid" : status.startsWith("FAILED") ? "danger" : "muted";

function callLabel(c: CallRow): string {
  if (c.remote_name?.trim()) return c.remote_name.trim();
  if (c.remote_number_prefix) return `${c.remote_number_prefix}…`;
  if (c.remote_number_last3) return `…${c.remote_number_last3}`;
  return "Unknown caller";
}

function formatDuration(s: number) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const DEVICE_TONE = {
  active: "solid",
  logged_out: "muted",
  wiped: "danger",
  lost: "danger",
} as const;

const KEY_TONE = {
  active: "solid",
  expired: "muted",
  exhausted: "muted",
} as const;

/**
 * The strip above each of the three panel tables. Shared so the three cannot
 * drift: same 1px rule, same subtle fill, same label weight.
 */
const PANEL_HEAD =
  "flex items-center justify-between gap-2 border-b border-border bg-bg-subtle px-5 py-3";

/**
 * Scroll wrapper for a panel table. Mirrors the kit's <Table> accessibility —
 * tabIndex + role="region" so a wide table's right-hand columns are reachable
 * without a mouse (WCAG 2.1.1) — while keeping the min-width the kit's wrapper
 * cannot express, since that has to sit on the <table> itself.
 */
const SCROLLER = "overflow-x-auto";

/** `id` is the customer's org id — the tenant boundary the instance lives in. */
export default async function InstanceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: orgId } = await params;

  const org = await apiGetAs<Org>("/v1/org", orgId);
  if (!org?.id) notFound();

  const [list, audit, ownerData, crm, catalogue, overview, workspaces] = await Promise.all([
    apiGetAs<{ instances: InstanceRow[] }>("/v1/instances", orgId),
    apiGetAs<{ entries: AuditEntry[] }>("/v1/org/audit", orgId),
    apiGetAs<{ owners: OwnerRow[]; authConfigured: boolean }>("/v1/owners", orgId),
    // Read as this tenant, not as DEV_ORG_ID: the standalone /crm page can only
    // ever configure the org named in the environment, which is the wrong one
    // for every customer but the first.
    apiGetAs<{ integrations: Integration[] }>("/v1/crm/integrations", orgId),
    apiGetAs<{ providers: CrmProviderSpec[]; sourcePaths: Array<{ path: string; label: string }> }>(
      "/v1/crm/providers",
      orgId,
    ),
    apiGetAs<Overview>("/v1/analytics/overview", orgId),
    workspacesFor(orgId),
  ]);
  const instances = list?.instances ?? [];

  const details = await Promise.all(
    instances.map((inst) =>
      apiGetAs<{ instance: InstanceRow; keys: KeyRow[]; devices: DeviceRow[] }>(
        `/v1/instances/${inst.id}`,
        orgId,
      ),
    ),
  );

  // Recent calls per instance — the answer to "what has this customer actually
  // recorded", which the page could not show at all before.
  const recentCalls = await Promise.all(
    instances.map((inst) =>
      apiGetAs<{ calls: CallRow[] }>(
        `/v1/calls?instanceId=${inst.id}&limit=${CALL_PREVIEW}`,
        orgId,
      ),
    ),
  );

  const deviceTotal = details.reduce((n, d) => n + (d?.devices.length ?? 0), 0);
  const activeKeys = details.reduce(
    (n, d) => n + (d?.keys.filter((k) => k.status === "active").length ?? 0),
    0,
  );
  const callStats = overview?.calls;
  const recordedMinutes = Math.round((callStats?.total_seconds ?? 0) / 60);

  return (
    <>
      <PageHeader title={org.name} context="Instance" />

      <Link
        href="/instances"
        className="inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-text-muted transition-colors duration-150 ease-out hover:text-text"
      >
        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
        All instances
      </Link>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <Link href={`/instances/${orgId}/calls`} className="block">
          <StatCard
            label="Calls"
            value={String(callStats?.total ?? 0)}
            icon={<Phone className="h-4 w-4" />}
            footer={<span>{callStats?.failed ?? 0} failed · view log</span>}
          />
        </Link>
        <StatCard
          label="Recorded time"
          value={`${recordedMinutes} min`}
          icon={<Timer className="h-4 w-4" />}
          footer={<span>{callStats?.complete ?? 0} complete</span>}
        />
        <StatCard
          label="Devices"
          value={String(deviceTotal)}
          icon={<Smartphone className="h-4 w-4" />}
        />
        <StatCard
          label="Active keys"
          value={String(activeKeys)}
          icon={<KeyRound className="h-4 w-4" />}
        />
        <StatCard label="Retention" value={`${org.retention_days}d`} />
      </div>

      <Card shadow className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <MonoLabel>Tenant</MonoLabel>
          <StatusChip tone={org.status === "active" ? "solid" : "muted"}>{org.status}</StatusChip>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <span className="block text-xs text-text-muted">Org ID</span>
            <span className="font-mono text-xs break-all text-text">{org.id}</span>
          </div>
          <div>
            <span className="block text-xs text-text-muted">Region</span>
            <span className="font-mono text-xs text-text">{org.region}</span>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          <OwnerAccounts
            orgId={orgId}
            owners={ownerData?.owners ?? []}
            authConfigured={ownerData?.authConfigured ?? false}
          />
          <AsrSettings
            orgId={orgId}
            asrLanguage={org.asr_language ?? null}
            asrMode={org.asr_mode ?? null}
            vocabulary={org.vocabulary ?? []}
          />
          <TranscriptionToggle
            orgId={orgId}
            enabled={org.transcription_enabled !== false}
            instanceName={org.name}
          />
          <PolicyForm orgId={orgId} initial={org} />
          <ErasureTool orgId={orgId} />
        </div>

        <Card shadow className="space-y-3">
          <MonoLabel>Immutable audit ledger</MonoLabel>
          <div className="max-h-[32rem] divide-y divide-border overflow-y-auto">
            {(audit?.entries ?? []).length === 0 ? (
              <p className="py-6 text-center text-sm text-text-muted">No audit entries yet</p>
            ) : (
              audit!.entries.map((e) => (
                <div key={e.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <span className="block font-mono text-xs font-medium text-text">
                      {e.action}
                    </span>
                    <span className="font-mono text-xs text-text-muted tabular-nums">
                      {e.actor_type}:{e.actor_id.slice(0, 12)} ·{" "}
                      {new Date(e.created_at).toLocaleString()}
                    </span>
                  </div>
                  <StatusChip tone={e.actor_type === "system" ? "muted" : "solid"}>
                    {e.target_type ?? "—"}
                  </StatusChip>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      {catalogue && instances[0] ? (
        <div className="space-y-4 border-t border-border pt-6">
          <div>
            <h3 className="text-xl font-semibold text-text">Lead delivery</h3>
            <p className="mt-0.5 text-sm text-text-muted">
              Where this customer&apos;s calls are pushed. Scoped to {org.name} — nothing here
              affects another tenant.
            </p>
          </div>
          <CrmManager
            integrations={crm?.integrations ?? []}
            providers={catalogue.providers}
            sourcePaths={catalogue.sourcePaths}
            workspaces={workspaces}
            orgId={orgId}
          />
        </div>
      ) : null}

      {instances.length === 0 ? (
        <EmptyState
          icon={<Boxes className="h-8 w-8" />}
          title="This tenant has no enrollment target"
          description="There is no instance to enroll a handset against. Reprovision the customer to create one."
        />
      ) : null}

      {instances.map((inst, i) => {
        const detail = details[i];
        const calls = recentCalls[i]?.calls ?? [];
        return (
          <div key={inst.id} className="space-y-6 border-t border-border pt-6">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h3 className="text-xl font-semibold text-text">{inst.name}</h3>
              <span className="font-mono text-xs break-all text-text-muted tabular-nums">
                Instance {inst.id} · config v{inst.config_version}
              </span>
            </div>

            <Card className="overflow-hidden p-0">
              <div className={PANEL_HEAD}>
                <div className="flex items-center gap-2">
                  <Phone aria-hidden="true" className="h-4 w-4 text-text-muted" />
                  <span className="text-sm font-medium text-text">Recent calls</span>
                </div>
                <Link
                  href={`/instances/${orgId}/calls?instance=${inst.id}`}
                  className="rounded-sm text-sm font-medium text-accent-text underline underline-offset-2 hover:text-accent"
                >
                  View all
                  {/* Three "View all" links on one page; name the target so a
                      screen reader's link list is not three identical rows. */}
                  <span className="sr-only"> calls for {inst.name}</span>
                </Link>
              </div>
              {calls.length === 0 ? (
                <p className="py-8 text-center text-sm text-text-muted">
                  No calls recorded on this instance yet
                </p>
              ) : (
                <div tabIndex={0} role="region" aria-label={`Recent calls, ${inst.name}`} className={SCROLLER}>
                  <table className="w-full min-w-[600px] border-collapse text-left text-sm">
                    <caption className="sr-only">Recent calls for {inst.name}</caption>
                    <TableHead>
                      <tr>
                        <TableHeaderCell>Call</TableHeaderCell>
                        <TableHeaderCell>Device</TableHeaderCell>
                        <TableHeaderCell>Duration</TableHeaderCell>
                        <TableHeaderCell>Status</TableHeaderCell>
                      </tr>
                    </TableHead>
                    <TableBody>
                      {calls.map((c) => (
                        <TableRow key={c.id}>
                          <TableCell>
                            <span className="block text-sm font-medium text-text">
                              {callLabel(c)}
                            </span>
                            <LocalTime
                              iso={c.started_at}
                              className="text-xs text-text-muted tabular-nums"
                            />
                          </TableCell>
                          <TableCell className="text-xs">{c.device_label ?? "—"}</TableCell>
                          <TableCell className="text-xs tabular-nums">
                            {formatDuration(c.duration_s)}
                          </TableCell>
                          <TableCell>
                            <StatusChip tone={CALL_TONE(c.status)}>{c.status}</StatusChip>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </table>
                </div>
              )}
            </Card>

            <KeyGenerator orgId={orgId} instanceId={inst.id} instanceName={inst.name} />

            <Card className="overflow-hidden p-0">
              <div className={PANEL_HEAD}>
                <div className="flex items-center gap-2">
                  <KeyRound aria-hidden="true" className="h-4 w-4 text-text-muted" />
                  <span className="text-sm font-medium text-text">Enrollment keys</span>
                </div>
              </div>
              {!detail || detail.keys.length === 0 ? (
                <p className="py-8 text-center text-sm text-text-muted">No keys issued</p>
              ) : (
                <div tabIndex={0} role="region" aria-label={`Enrollment keys, ${inst.name}`} className={SCROLLER}>
                  <table className="w-full min-w-[600px] border-collapse text-left text-sm">
                    <caption className="sr-only">Enrollment keys for {inst.name}</caption>
                    <TableHead>
                      <tr>
                        <TableHeaderCell>Issued</TableHeaderCell>
                        <TableHeaderCell>Expires</TableHeaderCell>
                        <TableHeaderCell>Uses</TableHeaderCell>
                        <TableHeaderCell>Status</TableHeaderCell>
                      </tr>
                    </TableHead>
                    <TableBody>
                      {detail.keys.map((key) => (
                        <TableRow key={key.id}>
                          <TableCell className="font-mono text-xs tabular-nums">
                            {new Date(key.created_at).toLocaleString()}
                          </TableCell>
                          <TableCell className="font-mono text-xs tabular-nums">
                            {new Date(key.expires_at).toLocaleString()}
                          </TableCell>
                          <TableCell className="font-mono text-xs tabular-nums">
                            {key.use_count}/{key.max_uses}
                          </TableCell>
                          <TableCell>
                            <StatusChip tone={KEY_TONE[key.status]}>{key.status}</StatusChip>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </table>
                </div>
              )}
            </Card>

            <Card className="overflow-hidden p-0">
              <div className={PANEL_HEAD}>
                <div className="flex items-center gap-2">
                  <Smartphone aria-hidden="true" className="h-4 w-4 text-text-muted" />
                  <span className="text-sm font-medium text-text">Devices</span>
                </div>
              </div>
              {!detail || detail.devices.length === 0 ? (
                <p className="py-8 text-center text-sm text-text-muted">
                  No devices enrolled — issue a key above to enroll the first handset
                </p>
              ) : (
                <div tabIndex={0} role="region" aria-label={`Devices, ${inst.name}`} className={SCROLLER}>
                  <table className="w-full min-w-[880px] border-collapse text-left text-sm">
                    <caption className="sr-only">Enrolled devices for {inst.name}</caption>
                    <TableHead>
                      <tr>
                        <TableHeaderCell>Device</TableHeaderCell>
                        <TableHeaderCell>Fingerprint</TableHeaderCell>
                        <TableHeaderCell>Capability</TableHeaderCell>
                        <TableHeaderCell>Last seen</TableHeaderCell>
                        <TableHeaderCell>Status</TableHeaderCell>
                        <TableHeaderCell>Actions</TableHeaderCell>
                      </tr>
                    </TableHead>
                    <TableBody>
                      {detail.devices.map((device) => (
                        <TableRow key={device.id}>
                          <TableCell>
                            <span className="block text-sm font-medium text-text">
                              {device.label ?? "Unlabeled device"}
                            </span>
                            <span className="font-mono text-xs text-text-muted">{device.id}</span>
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {device.fingerprint ?? "—"}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {device.capture_capability ?? "unprobed"}
                          </TableCell>
                          <TableCell className="font-mono text-xs tabular-nums">
                            {device.last_seen_at
                              ? new Date(device.last_seen_at).toLocaleString()
                              : "—"}
                          </TableCell>
                          <TableCell>
                            <StatusChip tone={DEVICE_TONE[device.status]}>
                              {device.status}
                            </StatusChip>
                          </TableCell>
                          <TableCell>
                            <DeviceActions
                              orgId={orgId}
                              deviceId={device.id}
                              status={device.status}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </table>
                </div>
              )}
            </Card>

            <DeleteInstance orgId={orgId} instanceId={inst.id} instanceName={inst.name} />
          </div>
        );
      })}
    </>
  );
}
