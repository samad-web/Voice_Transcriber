import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  Boxes,
  ChevronRight,
  KeyRound,
  Phone,
  Plug,
  ScrollText,
  Settings2,
  Smartphone,
} from "lucide-react";
import type { CrmProviderSpec } from "@aura/shared";
import {
  Card,
  EmptyState,
  MonoLabel,
  STATE_TONE,
  StatusChip,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tooltip,
} from "@aura/ui";
import type { ConsoleState } from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import { PageHeader } from "@/components/page-header";
import { operatorGate } from "@/lib/operator-gate";
import { apiGetAs } from "@/lib/server-api";
import { workspacesFor } from "@/lib/tenant-scope";
import type { CallRow } from "../../calls/calls-explorer";
import { CrmManager, type Integration } from "../../crm/crm-manager";
import { AppLockForm } from "./app-lock-form";
import { CopyValue } from "./copy-value";
import { DeleteInstance } from "./delete-instance";
import { DeviceActions } from "./device-actions";
import { ErasureTool } from "./erasure-tool";
import { InstanceTabs, type InstanceTab } from "./instance-tabs";
import { KeyGenerator } from "./key-generator";
import { OwnerAccounts, type OwnerRow } from "./owner-accounts";
import { PolicyForm } from "./policy-form";
import { TelecallerForm } from "./telecaller-form";
import { AsrSettings } from "./asr-settings";
import { CallIntelToggle } from "./call-intel-toggle";
import { CrmModuleToggle } from "./crm-module-toggle";
import { TranscriptionToggle } from "./transcription-toggle";
import { QualificationToggle } from "./qualification-toggle";

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
  app_lock_enabled: boolean;
  enabled_modules: string[];
  whatsapp_qualification_enabled: boolean;
  qualification_retention_days: number;
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
  telecaller_name: string | null;
  telecaller_id: string | null;
  telecaller_external_id: string | null;
  /** Active and heard from inside the last 24h - instances.controller.ts owns
   *  the definition; the fleet header counts these. */
  connected: boolean;
  /** Uploaded calls and attributed leads. Both zero = an unpaired enrolment,
   *  which is the only kind DeviceActions offers to remove. */
  call_count: number;
  lead_count: number;
}

interface Overview {
  calls: { total: number; complete: number; failed: number; total_seconds: number };
}

/** Mirrors devices.controller.ts's GET /devices/fleet-health response shape. */
interface FleetHealthRow {
  deviceId: string;
  instanceId: string;
  staleness: "never" | "<1h" | "1-24h" | "1-7d" | "stale";
  health: {
    batteryLevel: number | null;
    freeStorageMb: number | null;
    pendingUploads: number | null;
    failureCounts: Record<string, number>;
    ts: string;
  } | null;
  needsAttention: boolean;
  attentionReasons: string[];
}

/** How many recent calls to preview inline before sending the operator to the
 *  full explorer. Enough to see the instance is alive, short enough to scan. */
const CALL_PREVIEW = 8;

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

/*
 * `danger` is the ERROR tone now - orange, not red (see @aura/ui's state.tsx),
 * and reserved for something the system got wrong. That forced a distinction
 * this map had been eliding: `wiped` and `lost` were both painted as faults,
 * and only one of them is. A wiped handset did exactly what an operator told
 * it to and is a settled, terminal state; a LOST one is an unresolved problem
 * with a customer's recordings on it. Only the second is an error.
 */
const DEVICE_TONE = {
  active: "solid",
  logged_out: "muted",
  wiped: "outline",
  lost: "danger",
} as const;

/** Baseline tone per staleness bucket - overridden by `needsAttention` below,
 *  since a device can be freshly-seen and still be flagged (e.g. low storage). */
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

function healthTooltip(row: FleetHealthRow | undefined): string {
  if (!row?.health) return "No health beacon received yet";
  const { batteryLevel, freeStorageMb, pendingUploads } = row.health;
  const parts = [
    batteryLevel != null ? `Battery ${batteryLevel}%` : null,
    freeStorageMb != null ? `${freeStorageMb}MB free` : null,
    pendingUploads != null ? `${pendingUploads} pending upload(s)` : null,
  ].filter(Boolean);
  const base = parts.length > 0 ? parts.join(" · ") : "No telemetry reported";
  return row.needsAttention ? `${base} - ${row.attentionReasons.join(", ")}` : base;
}

/** Mirrors the server-side LIMIT in tenancy.controller.ts's `audit` handler. */
const AUDIT_CAP = 200;

const KEY_TONE = {
  active: "solid",
  expired: "muted",
  exhausted: "muted",
} as const;

/**
 * The strip above each panel table. Shared so they cannot drift: same 1px
 * rule, same subtle fill, same label weight.
 */
const PANEL_HEAD =
  "flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border bg-bg-subtle px-5 py-3";

/**
 * Scroll wrapper for a panel table. Mirrors the kit's <Table> accessibility -
 * tabIndex + role="region" so a wide table's right-hand columns are reachable
 * without a mouse (WCAG 2.1.1) - while keeping the min-width the kit's wrapper
 * cannot express, since that has to sit on the <table> itself.
 */
const SCROLLER = "overflow-x-auto";

/** A button that reads as a link, for the cross-panel jumps. */
const JUMP =
  "inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors duration-150 ease-out hover:border-border-strong hover:bg-surface-hover";

/** A table inside a panel card: shared head strip, shared empty treatment. */
function TablePanel({
  icon,
  title,
  action,
  empty,
  children,
}: {
  icon: ReactNode;
  title: string;
  action?: ReactNode;
  /** Rendered instead of `children` when the table has no rows. */
  empty?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card className="overflow-hidden p-0">
      <div className={PANEL_HEAD}>
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="text-text-muted">
            {icon}
          </span>
          <span className="text-sm font-medium text-text">{title}</span>
        </div>
        {action}
      </div>
      {empty ?? children}
    </Card>
  );
}

/** One cell of the vitals strip. Optionally the whole cell is a jump target. */
function Metric({
  label,
  value,
  hint,
  state = "neutral",
  href,
  gotoTab,
  gotoAnchor,
}: {
  label: string;
  value: string;
  hint?: string;
  /**
   * The only cell that gets a colour is one reporting an ERROR - a flagged
   * handset. Everything else in this strip is a count, and a count is not a
   * state (@aura/ui's state.tsx). It was `"danger"` and painted red; red is
   * MISSED now, and a device with low storage is not a missed call.
   */
  state?: ConsoleState;
  href?: string;
  gotoTab?: string;
  /** Element id to land on inside that tab, rather than its top. */
  gotoAnchor?: string;
}) {
  const interactive = Boolean(href ?? gotoTab);
  const body = (
    <>
      <MonoLabel>{label}</MonoLabel>
      <p
        className={
          "mt-1 text-2xl leading-tight font-semibold break-words tabular-nums " +
          STATE_TONE[state].text
        }
      >
        {value}
      </p>
      {hint ? (
        <p className="mt-0.5 flex items-center gap-0.5 text-xs text-text-muted tabular-nums">
          {hint}
          {/* The chevron is added here rather than passed in, so a cell that
              goes somewhere always looks like it does and a cell that does not
              never borrows the affordance. */}
          {interactive ? <ChevronRight aria-hidden="true" className="h-3 w-3" /> : null}
        </p>
      ) : null}
    </>
  );

  // `gap-px` on a `bg-border` grid draws the separators, so each cell paints
  // its own surface. Interactive cells get the hover fill for free.
  const cell = "bg-surface px-4 py-3 text-left sm:px-5";
  // The negative outline offset matters: the card that holds these cells is
  // `overflow-hidden` (it has to be, for the rounded corners to clip the grid),
  // and theme.css's global focus ring sits 2px OUTSIDE the element - so on an
  // edge cell the ring would be clipped away to nothing. Drawn inside instead.
  const live =
    " transition-colors duration-150 ease-out hover:bg-surface-hover focus-visible:-outline-offset-2";

  if (href) {
    return (
      <Link href={href} className={cell + live + " block"}>
        {body}
      </Link>
    );
  }
  if (gotoTab) {
    return (
      <button
        type="button"
        data-goto-tab={gotoTab}
        data-goto-anchor={gotoAnchor}
        className={cell + live + " block w-full"}
      >
        {body}
      </button>
    );
  }
  return <div className={cell}>{body}</div>;
}

/** A titled block inside a panel - the settings panel's spine. */
function Section({
  id,
  title,
  description,
  tone = "default",
  children,
}: {
  /** Makes the section a `data-goto-anchor` target. */
  id?: string;
  title: string;
  description?: string;
  tone?: "default" | "danger";
  children: ReactNode;
}) {
  return (
    // scroll-mt clears the sticky tab strip, so an anchored jump does not park
    // the heading underneath it.
    <section id={id} className="scroll-mt-28 space-y-4 md:scroll-mt-20">
      <div className="border-b border-border pb-2">
        <h3
          className={
            "text-base font-semibold " + (tone === "danger" ? "text-danger-text" : "text-text")
          }
        >
          {title}
        </h3>
        {description ? <p className="mt-0.5 text-sm text-text-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Names which instance a panel's tables belong to.
 *
 * Rendered only when the tenant has more than one instance. With exactly one -
 * the shape of every customer provisioned so far - the heading would restate
 * the page title and the tab label, so it is dropped rather than repeated
 * three times down the page.
 */
function InstanceHeading({ inst }: { inst: InstanceRow }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h3 className="text-base font-semibold text-text">{inst.name}</h3>
      <span className="flex items-center gap-2 text-xs text-text-muted tabular-nums">
        config v{inst.config_version}
        <CopyValue
          value={inst.id}
          label={`instance ID for ${inst.name}`}
          className="text-text-muted"
        />
      </span>
    </div>
  );
}

/** `id` is the customer's org id - the tenant boundary the instance lives in. */
export default async function InstanceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const blocked = await operatorGate();
  if (blocked) return blocked;

  const { id: orgId } = await params;
  // Deep link support: `?tab=devices` opens straight into the fleet. The tab
  // component owns every switch after this one (client-side, no refetch), so
  // this value is only ever read for the first render.
  const { tab: initialTab } = await searchParams;

  const org = await apiGetAs<Org>("/v1/org", orgId);
  if (!org?.id) notFound();

  const [list, audit, ownerData, crm, catalogue, overview, workspaces, fleetHealth] =
    await Promise.all([
      apiGetAs<{ instances: InstanceRow[] }>("/v1/instances", orgId),
      apiGetAs<{ entries: AuditEntry[] }>("/v1/org/audit", orgId),
      apiGetAs<{ owners: OwnerRow[]; authConfigured: boolean }>("/v1/owners", orgId),
      // Read as this tenant, not as DEV_ORG_ID: the standalone /crm page can only
      // ever configure the org named in the environment, which is the wrong one
      // for every customer but the first.
      apiGetAs<{ integrations: Integration[] }>("/v1/crm/integrations", orgId),
      apiGetAs<{
        providers: CrmProviderSpec[];
        sourcePaths: Array<{ path: string; label: string }>;
      }>("/v1/crm/providers", orgId),
      apiGetAs<Overview>("/v1/analytics/overview", orgId),
      workspacesFor(orgId),
      // Org-wide, fetched once: cheaper than one extra round trip per instance
      // below, and the devices table only needs to key it by device id.
      apiGetAs<{ devices: FleetHealthRow[] }>("/v1/devices/fleet-health", orgId),
    ]);
  const instances = list?.instances ?? [];
  const healthByDevice = new Map((fleetHealth?.devices ?? []).map((h) => [h.deviceId, h]));

  const details = await Promise.all(
    instances.map((inst) =>
      apiGetAs<{ instance: InstanceRow; keys: KeyRow[]; devices: DeviceRow[] }>(
        `/v1/instances/${inst.id}`,
        orgId,
      ),
    ),
  );

  // Recent calls per instance - the answer to "what has this customer actually
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
  const connectedTotal = details.reduce(
    (n, d) => n + (d?.devices.filter((x) => x.connected).length ?? 0),
    0,
  );
  const activeKeys = details.reduce(
    (n, d) => n + (d?.keys.filter((k) => k.status === "active").length ?? 0),
    0,
  );
  const callStats = overview?.calls;
  const recordedMinutes = Math.round((callStats?.total_seconds ?? 0) / 60);
  const auditEntries = audit?.entries ?? [];
  const owners = ownerData?.owners ?? [];

  // Only count handsets this tenant actually has: /devices/fleet-health is
  // org-wide, but a row for a device that has since been removed from every
  // instance would inflate a badge nobody can then act on.
  const enrolledIds = new Set(details.flatMap((d) => d?.devices.map((x) => x.id) ?? []));
  const flagged = (fleetHealth?.devices ?? []).filter(
    (h) => h.needsAttention && enrolledIds.has(h.deviceId),
  ).length;

  const multi = instances.length > 1;
  const showCrm = Boolean(catalogue && instances[0]);

  /* ── Vitals ──────────────────────────────────────────────────────────────
     One card in place of the old five stat cards plus a separate tenant card.
     Same numbers, a third of the height, and four of the six cells are now
     jump targets rather than read-only decoration. */
  const vitals = (
    <Card className="overflow-hidden p-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-bg-subtle px-4 py-2.5 sm:px-5">
        <StatusChip tone={org.status === "active" ? "solid" : "muted"}>{org.status}</StatusChip>
        <span className="flex items-center gap-1.5 text-xs text-text-muted">
          Org
          <CopyValue value={org.id} label="org ID" className="text-text" />
        </span>
        <span className="text-xs text-text-muted">
          Region <span className="font-mono text-text">{org.region}</span>
        </span>
        <span className="text-xs text-text-muted">
          Consent{" "}
          <span className="font-mono text-text">{org.consent_policy.replace(/_/g, " ")}</span>
        </span>
        <span className="text-xs text-text-muted sm:ml-auto">
          {instances.length} {instances.length === 1 ? "instance" : "instances"} · {owners.length}{" "}
          {owners.length === 1 ? "owner login" : "owner logins"}
        </span>
      </div>

      {/* gap-px over a bg-border grid: exact 1px separators at every column
          count, without per-cell border rules that break on the last column. */}
      <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-6">
        <Metric
          label="Calls"
          value={(callStats?.total ?? 0).toLocaleString()}
          hint={`${(callStats?.failed ?? 0).toLocaleString()} failed · call log`}
          href={`/instances/${orgId}/calls`}
        />
        <Metric
          label="Recorded"
          value={`${recordedMinutes.toLocaleString()} min`}
          hint={`${(callStats?.complete ?? 0).toLocaleString()} complete`}
        />
        <Metric
          label="Devices"
          value={deviceTotal.toLocaleString()}
          hint="Open fleet"
          gotoTab="devices"
        />
        <Metric
          label="Active keys"
          value={activeKeys.toLocaleString()}
          hint="Issue a key"
          gotoTab="devices"
          gotoAnchor="enrollment"
        />
        <Metric
          label="Retention"
          value={`${org.retention_days}d`}
          hint="Consent policy"
          gotoTab="settings"
        />
        {flagged > 0 ? (
          <Metric
            label="Needs attention"
            value={flagged.toLocaleString()}
            state="error"
            hint={flagged === 1 ? "1 handset flagged" : `${flagged} handsets flagged`}
            gotoTab="devices"
          />
        ) : (
          <Metric
            label="Fleet health"
            value={deviceTotal === 0 ? "-" : "OK"}
            hint={deviceTotal === 0 ? "No handsets yet" : "Nothing flagged"}
          />
        )}
      </div>
    </Card>
  );

  /* ── Overview ────────────────────────────────────────────────────────── */
  const overviewPanel = (
    <>
      <div className="flex flex-wrap gap-2">
        <Link href={`/instances/${orgId}/calls`} className={JUMP}>
          <Phone aria-hidden="true" className="h-4 w-4 text-text-muted" />
          Open call log
        </Link>
        <button
          type="button"
          data-goto-tab="devices"
          data-goto-anchor="enrollment"
          className={JUMP}
        >
          <KeyRound aria-hidden="true" className="h-4 w-4 text-text-muted" />
          Issue enrollment key
        </button>
        <button type="button" data-goto-tab="settings" className={JUMP}>
          <Settings2 aria-hidden="true" className="h-4 w-4 text-text-muted" />
          Owner logins &amp; modules
        </button>
        {showCrm ? (
          <button type="button" data-goto-tab="integrations" className={JUMP}>
            <Plug aria-hidden="true" className="h-4 w-4 text-text-muted" />
            Lead delivery
          </button>
        ) : null}
      </div>

      {instances.length === 0 ? (
        <EmptyState
          icon={<Boxes className="h-8 w-8" />}
          title="This tenant has no enrollment target"
          description="There is no instance to enroll a handset against. Reprovision the customer to create one."
        />
      ) : null}

      {instances.map((inst, i) => {
        const calls = recentCalls[i]?.calls ?? [];
        return (
          <div key={inst.id} className="space-y-3">
            {multi ? <InstanceHeading inst={inst} /> : null}
            <TablePanel
              icon={<Phone className="h-4 w-4" />}
              title="Recent calls"
              action={
                <Link
                  href={`/instances/${orgId}/calls?instance=${inst.id}`}
                  className="rounded-sm text-sm font-medium text-accent-text underline underline-offset-2 hover:text-accent"
                >
                  View all
                  {/* One "View all" per instance; name the target so a screen
                      reader's link list is not N identical rows. */}
                  <span className="sr-only"> calls for {inst.name}</span>
                </Link>
              }
              empty={
                calls.length === 0 ? (
                  <p className="px-5 py-8 text-center text-sm text-text-muted">
                    No calls recorded on this instance yet
                  </p>
                ) : undefined
              }
            >
              <div
                tabIndex={0}
                role="region"
                aria-label={`Recent calls, ${inst.name}`}
                className={SCROLLER}
              >
                <table className="w-full min-w-[560px] border-collapse text-left text-sm">
                  <caption className="sr-only">Recent calls for {inst.name}</caption>
                  <TableHead>
                    <tr>
                      <TableHeaderCell>Call</TableHeaderCell>
                      <TableHeaderCell>Device</TableHeaderCell>
                      <TableHeaderCell className="text-right">Duration</TableHeaderCell>
                      <TableHeaderCell>Status</TableHeaderCell>
                    </tr>
                  </TableHead>
                  <TableBody>
                    {calls.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="py-2.5">
                          <span className="block text-sm font-medium text-text">
                            {callLabel(c)}
                          </span>
                          <LocalTime
                            iso={c.started_at}
                            className="text-xs text-text-muted tabular-nums"
                          />
                        </TableCell>
                        <TableCell className="py-2.5 text-xs">{c.device_label ?? "-"}</TableCell>
                        <TableCell className="py-2.5 text-right text-xs tabular-nums">
                          {formatDuration(c.duration_s)}
                        </TableCell>
                        <TableCell className="py-2.5">
                          <StatusChip tone={CALL_TONE(c.status)}>{c.status}</StatusChip>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </table>
              </div>
            </TablePanel>
          </div>
        );
      })}
    </>
  );

  /* ── Devices ─────────────────────────────────────────────────────────── */
  const devicesPanel = (
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

  /* ── Settings ────────────────────────────────────────────────────────── */
  const settingsPanel = (
    <>
      <Section
        title="Modules"
        description="What this customer's own console can see. Each switch is scoped to this tenant."
      >
        {/* Four on/off cards, 2x2, so the whole module state is one glance.

            The grid stretches (no `items-start`) and ModuleCard pins each
            button to a footer, so cards in a row share a height and their
            headers and buttons line up.

            The rows are paired by kind, which also pairs them by height.
            Row 1 is what runs on the tenant's data - paid ASR, and WhatsApp
            text sent to an AI provider - and both are a bare switch. Row 2 is
            what the tenant's own console shows, and both carry a panel about
            which of their accounts it reaches. Pairing a bare switch with a
            panel card is what left a card-sized hole under the short one. */}
        <div className="grid gap-5 lg:grid-cols-2">
          <TranscriptionToggle
            orgId={orgId}
            enabled={org.transcription_enabled !== false}
            instanceName={org.name}
          />
          <QualificationToggle
            orgId={orgId}
            enabled={org.whatsapp_qualification_enabled === true}
            retentionDays={org.qualification_retention_days ?? 90}
            instanceName={org.name}
          />
          <CallIntelToggle
            orgId={orgId}
            enabled={org.enabled_modules.includes("call_intel")}
            instanceName={org.name}
            owners={owners}
            modules={org.enabled_modules}
          />
          <CrmModuleToggle
            orgId={orgId}
            enabled={org.enabled_modules.includes("crm")}
            instanceName={org.name}
            owners={owners}
            modules={org.enabled_modules}
          />
        </div>
      </Section>

      <Section
        title="Capture & retention"
        description="How this customer's calls are transcribed, how long they are kept, and who can open the app."
      >
        <div className="grid items-start gap-5 lg:grid-cols-2">
          <AsrSettings
            orgId={orgId}
            asrLanguage={org.asr_language ?? null}
            asrMode={org.asr_mode ?? null}
            vocabulary={org.vocabulary ?? []}
          />
          <div className="flex flex-col gap-5">
            <PolicyForm orgId={orgId} initial={org} />
            <AppLockForm orgId={orgId} enabled={org.app_lock_enabled} />
          </div>
        </div>
      </Section>

      <Section
        title="Access"
        description="Sign-ins scoped to this instance only - never the operator console."
      >
        <OwnerAccounts
          orgId={orgId}
          owners={owners}
          authConfigured={ownerData?.authConfigured ?? false}
        />
      </Section>

      <Section
        title="Danger zone"
        tone="danger"
        description="Irreversible. Both of these destroy customer data that no backup on this side restores."
      >
        <div className="grid items-start gap-5 lg:grid-cols-2">
          <ErasureTool orgId={orgId} />
          {instances.map((inst) => (
            <DeleteInstance
              key={inst.id}
              orgId={orgId}
              instanceId={inst.id}
              instanceName={inst.name}
            />
          ))}
        </div>
      </Section>
    </>
  );

  /* ── Audit ───────────────────────────────────────────────────────────── */
  const auditPanel = (
    <TablePanel
      icon={<ScrollText className="h-4 w-4" />}
      title="Immutable audit ledger"
      action={
        <span className="text-xs text-text-muted tabular-nums">
          {auditEntries.length} {auditEntries.length === 1 ? "entry" : "entries"}
          {/* The API caps at 200 (tenancy.controller.ts). Saying so beats a
              list that silently stops at an arbitrary depth. */}
          {auditEntries.length >= AUDIT_CAP ? " · newest 200" : ""}
        </span>
      }
      empty={
        auditEntries.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-text-muted">No audit entries yet</p>
        ) : undefined
      }
    >
      {/* Full width now that it owns a panel - it used to be a 32rem box
          beside an eight-screen settings column, so it was both cramped AND
          surrounded by empty page. Still capped in height, though: 200 entries
          laid out down the page would be 8,000px of scroll, which is the
          problem this redesign exists to remove. The log scrolls inside its
          own frame and the tab stays one screen. */}
      <div
        tabIndex={0}
        role="region"
        aria-label="Audit ledger"
        className="max-h-[70vh] overflow-auto"
      >
        <table className="w-full min-w-[560px] border-collapse text-left text-sm">
          <caption className="sr-only">Audit ledger for {org.name}</caption>
          <TableHead>
            <tr>
              <TableHeaderCell>Action</TableHeaderCell>
              <TableHeaderCell>Actor</TableHeaderCell>
              <TableHeaderCell>Target</TableHeaderCell>
              <TableHeaderCell>When</TableHeaderCell>
            </tr>
          </TableHead>
          <TableBody>
            {auditEntries.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="py-2.5 font-mono text-xs font-medium text-text">
                  {e.action}
                </TableCell>
                <TableCell className="py-2.5 font-mono text-xs text-text-muted">
                  {e.actor_type}:{e.actor_id.slice(0, 12)}
                </TableCell>
                <TableCell className="py-2.5">
                  <StatusChip tone={e.actor_type === "system" ? "muted" : "solid"}>
                    {e.target_type ?? "-"}
                  </StatusChip>
                </TableCell>
                <TableCell className="py-2.5">
                  <LocalTime iso={e.created_at} className="text-xs text-text-muted tabular-nums" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </table>
      </div>
    </TablePanel>
  );

  const tabs: InstanceTab[] = [
    {
      id: "overview",
      label: "Overview",
      icon: <Boxes className="h-4 w-4" />,
      content: overviewPanel,
    },
    {
      id: "devices",
      label: "Devices",
      icon: <Smartphone className="h-4 w-4" />,
      count: deviceTotal,
      attention: flagged > 0,
      content: devicesPanel,
    },
    {
      id: "settings",
      label: "Settings",
      icon: <Settings2 className="h-4 w-4" />,
      content: settingsPanel,
    },
    ...(showCrm
      ? [
          {
            id: "integrations",
            label: "Lead delivery",
            icon: <Plug className="h-4 w-4" />,
            count: crm?.integrations.length ?? 0,
            content: (
              <>
                <p className="text-sm text-text-muted">
                  Where this customer&apos;s calls are pushed. Scoped to {org.name} - nothing here
                  affects another tenant.
                </p>
                <CrmManager
                  integrations={crm?.integrations ?? []}
                  providers={catalogue!.providers}
                  sourcePaths={catalogue!.sourcePaths}
                  workspaces={workspaces}
                  orgId={orgId}
                />
              </>
            ),
          } satisfies InstanceTab,
        ]
      : []),
    {
      id: "audit",
      label: "Audit",
      icon: <ScrollText className="h-4 w-4" />,
      count: auditEntries.length,
      content: auditPanel,
    },
  ];

  return (
    <>
      {/* Breadcrumb above the title, not below it: the way back should be the
          first thing in the reading order, not something found after the page
          heading has already been read. */}
      <Link
        href="/instances"
        className="inline-flex items-center gap-1.5 self-start rounded-sm text-sm font-medium text-text-muted transition-colors duration-150 ease-out hover:text-text"
      >
        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
        All instances
      </Link>

      <PageHeader title={org.name} context="Instance" />

      <InstanceTabs tabs={tabs} initialTab={initialTab} header={vitals} />
    </>
  );
}
