import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Card, MonoLabel, STATE_TONE } from "@aura/ui";
import type { ConsoleState } from "@aura/ui";
import type { OrgStorageFields } from "@/components/storage-vital";
import type { CallRow } from "./calls/calls-explorer";
import { CopyValue } from "./copy-value";

/**
 * Shared vocabulary for the instance routes.
 *
 * Doc 34 Part B split a single 1171-line page - which drew five panels behind a
 * client-side tab strip and fetched all fourteen of their APIs on every visit -
 * into one route per panel. These are the pieces more than one of those routes
 * needs: the response shapes, the tone maps, and the four small components that
 * give every panel the same table head, the same vitals cell, the same section
 * spine and the same instance heading.
 *
 * It holds NO data fetching and NO route knowledge on purpose. A panel route
 * imports what it renders with; where its rows come from is its own business.
 */

export interface Org {
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
  /** Doc 27 §6.4 - the worker's storage snapshot and the operator's quota. */
  storage_quota_bytes?: OrgStorageFields["storage_quota_bytes"];
  storage_usage?: OrgStorageFields["storage_usage"];
}

export interface InstanceRow {
  id: string;
  name: string;
  workspace_id: string;
  config_version: number;
  created_at: string;
  device_count: number;
}

export interface KeyRow {
  id: string;
  expires_at: string;
  max_uses: number;
  use_count: number;
  created_at: string;
  status: "active" | "expired" | "exhausted";
}

export interface AuditEntry {
  id: string;
  actor_type: string;
  actor_id: string;
  action: string;
  target_type: string | null;
  created_at: string;
}

export interface DeviceRow {
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

export interface Overview {
  calls: { total: number; complete: number; failed: number; total_seconds: number };
}

/** Mirrors devices.controller.ts's GET /devices/fleet-health response shape. */
export interface FleetHealthRow {
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
export const CALL_PREVIEW = 8;

export const CALL_TONE = (status: string): "solid" | "muted" | "danger" =>
  status === "COMPLETE" ? "solid" : status.startsWith("FAILED") ? "danger" : "muted";

export function callLabel(c: CallRow): string {
  if (c.remote_name?.trim()) return c.remote_name.trim();
  if (c.remote_number_prefix) return `${c.remote_number_prefix}…`;
  if (c.remote_number_last3) return `…${c.remote_number_last3}`;
  return "Unknown caller";
}

export function formatDuration(s: number) {
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
export const DEVICE_TONE = {
  active: "solid",
  logged_out: "muted",
  wiped: "outline",
  lost: "danger",
} as const;

/** Baseline tone per staleness bucket - overridden by `needsAttention` below,
 *  since a device can be freshly-seen and still be flagged (e.g. low storage). */
export const HEALTH_TONE = {
  "<1h": "solid",
  "1-24h": "muted",
  "1-7d": "muted",
  stale: "danger",
  never: "outline",
} as const;

export const HEALTH_LABEL = {
  "<1h": "Active <1h",
  "1-24h": "Seen 1-24h ago",
  "1-7d": "Seen 1-7d ago",
  stale: "Stale 7d+",
  never: "Never seen",
} as const;

export function healthTooltip(row: FleetHealthRow | undefined): string {
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
export const AUDIT_CAP = 200;

export const KEY_TONE = {
  active: "solid",
  expired: "muted",
  exhausted: "muted",
} as const;

/**
 * The strip above each panel table. Shared so they cannot drift: same 1px
 * rule, same subtle fill, same label weight.
 */
export const PANEL_HEAD =
  "flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border bg-bg-subtle px-5 py-3";

/**
 * Scroll wrapper for a panel table. Mirrors the kit's <Table> accessibility -
 * tabIndex + role="region" so a wide table's right-hand columns are reachable
 * without a mouse (WCAG 2.1.1) - while keeping the min-width the kit's wrapper
 * cannot express, since that has to sit on the <table> itself.
 */
export const SCROLLER = "overflow-x-auto";

/** A button that reads as a link, for the cross-panel jumps. */
export const JUMP =
  "inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors duration-150 ease-out hover:border-border-strong hover:bg-surface-hover";

/** A table inside a panel card: shared head strip, shared empty treatment. */
export function TablePanel({
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

/** One cell of the vitals strip. Optionally the whole cell is a link. */
export function Metric({
  label,
  value,
  hint,
  state = "neutral",
  href,
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
  /**
   * Where the cell goes. It used to be either this OR a `data-goto-tab`
   * attribute, which a delegating click handler on the old client-side tab
   * strip turned into a panel switch (doc 34 SS6.1). Every panel is a route now,
   * so a jump is an ordinary link and the delegation is gone - which also means
   * a middle-click, a bookmark and the back button all work on these cells for
   * the first time.
   */
  href?: string;
}) {
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
          {href ? <ChevronRight aria-hidden="true" className="h-3 w-3" /> : null}
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
  return <div className={cell}>{body}</div>;
}

/** A titled block inside a panel - the settings panel's spine. */
export function Section({
  id,
  title,
  description,
  tone = "default",
  children,
}: {
  /** Anchor id, so a link may land on this section rather than the page top. */
  id?: string;
  title: string;
  description?: string;
  tone?: "default" | "danger";
  children: ReactNode;
}) {
  return (
    // scroll-mt clears the sticky tab strip, so an anchored jump (e.g.
    // /instances/<id>/devices#enrollment) does not park the heading under it.
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
export function InstanceHeading({ inst }: { inst: InstanceRow }) {
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
