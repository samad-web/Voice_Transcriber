import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Boxes, KeyRound, Phone, Smartphone, Timer } from "lucide-react";
import type { CrmProviderSpec } from "@aura/shared";
import { Card, MonoLabel, StatCard, StatusChip } from "@aura/ui";
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
        className="inline-flex items-center gap-1.5 text-[10px] font-mono font-bold uppercase tracking-wider text-neutral-500 hover:text-black"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
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
          label="Recorded Time"
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
          label="Active Keys"
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
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs font-mono">
          <div>
            <span className="text-neutral-400 block uppercase text-[10px] font-bold">Org ID</span>
            <span className="break-all">{org.id}</span>
          </div>
          <div>
            <span className="text-neutral-400 block uppercase text-[10px] font-bold">Region</span>
            <span>{org.region}</span>
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
          <MonoLabel>Immutable Audit Ledger</MonoLabel>
          <div className="max-h-[32rem] overflow-y-auto divide-y-2 divide-neutral-100">
            {(audit?.entries ?? []).length === 0 ? (
              <p className="text-xs font-mono font-bold uppercase text-neutral-400 py-6 text-center">
                No audit entries yet
              </p>
            ) : (
              audit!.entries.map((e) => (
                <div key={e.id} className="py-2.5 flex items-center justify-between gap-3">
                  <div>
                    <span className="font-mono text-xs font-bold text-black block">{e.action}</span>
                    <span className="text-[10px] text-neutral-400 font-mono">
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
        <div className="space-y-4 border-t-2 border-black pt-6">
          <div>
            <h3 className="text-xl font-display font-black uppercase tracking-tight">
              Lead Delivery
            </h3>
            <p className="text-xs text-neutral-500 font-sans font-medium mt-0.5">
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
        <Card className="flex flex-col items-center py-12 gap-3">
          <Boxes className="h-8 w-8 text-neutral-300" />
          <p className="text-xs font-mono font-bold uppercase text-neutral-400">
            This instance has no enrollment target — reprovision the customer
          </p>
        </Card>
      ) : null}

      {instances.map((inst, i) => {
        const detail = details[i];
        const calls = recentCalls[i]?.calls ?? [];
        return (
          <div key={inst.id} className="space-y-6 border-t-2 border-black pt-6">
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <h3 className="text-xl font-display font-black uppercase tracking-tight">
                {inst.name}
              </h3>
              <span className="text-[10px] font-mono text-neutral-400 break-all">
                instance {inst.id} · config v{inst.config_version}
              </span>
            </div>

            <Card className="overflow-hidden p-0">
              <div className="px-5 py-3.5 border-b-2 border-black bg-neutral-50 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Phone className="h-4 w-4" />
                  <span className="text-xs font-display font-bold uppercase tracking-wider">
                    Recent Calls
                  </span>
                </div>
                <Link
                  href={`/instances/${orgId}/calls?instance=${inst.id}`}
                  className="text-[10px] font-mono font-bold uppercase tracking-wider text-neutral-500 hover:text-black underline"
                >
                  View all
                </Link>
              </div>
              {calls.length === 0 ? (
                <p className="text-xs font-mono font-bold uppercase text-neutral-400 py-8 text-center">
                  No calls recorded on this instance yet
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[600px] text-left border-collapse">
                    <thead>
                      <tr className="bg-neutral-100 border-b-2 border-neutral-200 font-mono text-[10px] text-black font-bold uppercase tracking-wider">
                        <th className="py-3 px-5">Call</th>
                        <th className="py-3 px-4">Device</th>
                        <th className="py-3 px-4">Duration</th>
                        <th className="py-3 px-4">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y-2 divide-neutral-100 text-sm">
                      {calls.map((c) => (
                        <tr key={c.id} className="hover:bg-neutral-50">
                          <td className="py-3.5 px-5">
                            <span className="font-sans font-bold text-black block">
                              {callLabel(c)}
                            </span>
                            <LocalTime
                              iso={c.started_at}
                              className="text-[10px] text-neutral-400 font-mono"
                            />
                          </td>
                          <td className="py-3.5 px-4 text-xs font-sans font-bold">
                            {c.device_label ?? "—"}
                          </td>
                          <td className="py-3.5 px-4 font-mono text-xs font-bold">
                            {formatDuration(c.duration_s)}
                          </td>
                          <td className="py-3.5 px-4">
                            <StatusChip tone={CALL_TONE(c.status)}>{c.status}</StatusChip>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <KeyGenerator orgId={orgId} instanceId={inst.id} instanceName={inst.name} />

            <Card className="overflow-hidden p-0">
              <div className="px-5 py-3.5 border-b-2 border-black bg-neutral-50 flex items-center gap-2">
                <KeyRound className="h-4 w-4" />
                <span className="text-xs font-display font-bold uppercase tracking-wider">
                  Enrollment Keys
                </span>
              </div>
              {!detail || detail.keys.length === 0 ? (
                <p className="text-xs font-mono font-bold uppercase text-neutral-400 py-8 text-center">
                  No keys issued
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[600px] text-left border-collapse">
                    <thead>
                      <tr className="bg-neutral-100 border-b-2 border-neutral-200 font-mono text-[10px] text-black font-bold uppercase tracking-wider">
                        <th className="py-3 px-5">Issued</th>
                        <th className="py-3 px-4">Expires</th>
                        <th className="py-3 px-4">Uses</th>
                        <th className="py-3 px-4">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y-2 divide-neutral-100 text-sm">
                      {detail.keys.map((key) => (
                        <tr key={key.id} className="hover:bg-neutral-50">
                          <td className="py-3.5 px-5 font-mono text-xs">
                            {new Date(key.created_at).toLocaleString()}
                          </td>
                          <td className="py-3.5 px-4 font-mono text-xs">
                            {new Date(key.expires_at).toLocaleString()}
                          </td>
                          <td className="py-3.5 px-4 font-mono text-xs">
                            {key.use_count}/{key.max_uses}
                          </td>
                          <td className="py-3.5 px-4">
                            <StatusChip tone={KEY_TONE[key.status]}>{key.status}</StatusChip>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card className="overflow-hidden p-0">
              <div className="px-5 py-3.5 border-b-2 border-black bg-neutral-50 flex items-center gap-2">
                <Smartphone className="h-4 w-4" />
                <span className="text-xs font-display font-bold uppercase tracking-wider">
                  Devices
                </span>
              </div>
              {!detail || detail.devices.length === 0 ? (
                <p className="text-xs font-mono font-bold uppercase text-neutral-400 py-8 text-center">
                  No devices enrolled — issue a key above to enroll the first handset
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[880px] text-left border-collapse">
                    <thead>
                      <tr className="bg-neutral-100 border-b-2 border-neutral-200 font-mono text-[10px] text-black font-bold uppercase tracking-wider">
                        <th className="py-3 px-5">Device</th>
                        <th className="py-3 px-4">Fingerprint</th>
                        <th className="py-3 px-4">Capability</th>
                        <th className="py-3 px-4">Last Seen</th>
                        <th className="py-3 px-4">Status</th>
                        <th className="py-3 px-4 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y-2 divide-neutral-100 text-sm">
                      {detail.devices.map((device) => (
                        <tr key={device.id} className="hover:bg-neutral-50">
                          <td className="py-4 px-5">
                            <span className="font-display font-bold text-black block">
                              {device.label ?? "Unlabeled device"}
                            </span>
                            <span className="text-[10px] font-mono text-neutral-400">
                              {device.id}
                            </span>
                          </td>
                          <td className="py-4 px-4 font-mono text-xs">
                            {device.fingerprint ?? "—"}
                          </td>
                          <td className="py-4 px-4 font-mono text-xs">
                            {device.capture_capability ?? "unprobed"}
                          </td>
                          <td className="py-4 px-4 font-mono text-xs">
                            {device.last_seen_at
                              ? new Date(device.last_seen_at).toLocaleString()
                              : "—"}
                          </td>
                          <td className="py-4 px-4">
                            <StatusChip tone={DEVICE_TONE[device.status]}>
                              {device.status}
                            </StatusChip>
                          </td>
                          <td className="py-4 px-4 text-right">
                            <DeviceActions
                              orgId={orgId}
                              deviceId={device.id}
                              status={device.status}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
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
