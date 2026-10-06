import { notFound } from "next/navigation";
import type { CrmProviderSpec } from "@aura/shared";
import { apiGetAs } from "@/lib/server-api";
import { workspacesFor } from "@/lib/tenant-scope";
import type { CallRow } from "./calls/calls-explorer";
import type { Integration } from "./crm-manager";
import type { OwnerRow } from "./owner-accounts";
import type { InstanceInvite } from "./actions";
import type {
  AuditEntry,
  DeviceRow,
  FleetHealthRow,
  InstanceRow,
  KeyRow,
  Org,
  Overview,
} from "./instance-ui";
import { AUDIT_CAP, CALL_PREVIEW } from "./instance-ui";

/**
 * Reads for the instance routes, one loader per thing a route needs.
 *
 * ── WHY THESE ARE SEPARATE ──────────────────────────────────────────────────
 *
 * Before doc 34 Part B this was a single page that drew five panels behind a
 * client-side tab strip. Because every panel was mounted at once, ONE visit
 * issued all fourteen of these requests - the audit ledger, the CRM catalogue,
 * the owner logins and a per-instance detail call were all fetched to look at
 * the fleet. Splitting the panels into routes only helps if the fetching splits
 * with them, which is what this file is for.
 *
 * Each loader takes `orgId` - the customer's org id, which IS the tenant
 * boundary - and reads with `apiGetAs`, never `apiGetAdmin`: these are one
 * tenant's rows behind RLS.
 */

/** Everything the detail routes agree the tenant is. `notFound()` on a bad id. */
export async function loadOrg(orgId: string): Promise<Org> {
  const org = await apiGetAs<Org>("/v1/org", orgId);
  if (!org?.id) notFound();
  return org;
}

export async function loadInstances(orgId: string): Promise<InstanceRow[]> {
  const list = await apiGetAs<{ instances: InstanceRow[] }>("/v1/instances", orgId);
  return list?.instances ?? [];
}

export interface InstanceDetail {
  instance: InstanceRow;
  keys: KeyRow[];
  devices: DeviceRow[];
}

/**
 * One request per instance - the keys and handsets the list endpoint does not
 * carry. Most tenants have exactly one, so this is usually a single round trip.
 */
export async function loadInstanceDetails(
  orgId: string,
  instances: InstanceRow[],
): Promise<Array<InstanceDetail | null>> {
  return Promise.all(
    instances.map((inst) => apiGetAs<InstanceDetail>(`/v1/instances/${inst.id}`, orgId)),
  );
}

/** Org-wide, fetched once: cheaper than a round trip per instance, and the
 *  devices table only needs it keyed by device id. */
export async function loadFleetHealth(orgId: string): Promise<FleetHealthRow[]> {
  const data = await apiGetAs<{ devices: FleetHealthRow[] }>("/v1/devices/fleet-health", orgId);
  return data?.devices ?? [];
}

export async function loadOverview(orgId: string): Promise<Overview | null> {
  return apiGetAs<Overview>("/v1/analytics/overview", orgId);
}

export async function loadOwners(
  orgId: string,
): Promise<{ owners: OwnerRow[]; authConfigured: boolean }> {
  const data = await apiGetAs<{ owners: OwnerRow[]; authConfigured: boolean }>("/v1/owners", orgId);
  return { owners: data?.owners ?? [], authConfigured: data?.authConfigured ?? false };
}

export async function loadAudit(orgId: string): Promise<AuditEntry[]> {
  const data = await apiGetAs<{ entries: AuditEntry[] }>("/v1/org/audit", orgId);
  // The server LIMITs to AUDIT_CAP; sliced here too so a future server change
  // cannot quietly turn this table into thousands of rows.
  return (data?.entries ?? []).slice(0, AUDIT_CAP);
}

/**
 * Owner invites by link (0137). SECONDARY: a failure here must hide the pending
 * list and the invite option, never the rest of the page - so the caller gets
 * nulls rather than an exception.
 */
export async function loadInvites(orgId: string) {
  return apiGetAs<{
    invites: InstanceInvite[];
    mailConfigured: boolean;
    authConfigured: boolean;
  }>("/v1/instance-invites", orgId);
}

/**
 * The lead-delivery route's three reads.
 *
 * Read as THIS tenant, not as `DEV_ORG_ID`. The standalone `/crm` page that
 * Part B deleted could only ever configure the org named in the environment,
 * which is the wrong one for every customer but the first.
 */
export async function loadCrm(orgId: string) {
  const [data, catalogue, workspaces] = await Promise.all([
    apiGetAs<{ integrations: Integration[] }>("/v1/crm/integrations", orgId),
    apiGetAs<{
      providers: CrmProviderSpec[];
      sourcePaths: Array<{ path: string; label: string }>;
    }>("/v1/crm/providers", orgId),
    workspacesFor(orgId),
  ]);
  return { integrations: data?.integrations ?? [], catalogue, workspaces };
}

/** Recent calls per instance - "what has this customer actually recorded". */
export async function loadRecentCalls(
  orgId: string,
  instances: InstanceRow[],
): Promise<Array<{ calls: CallRow[] } | null>> {
  return Promise.all(
    instances.map((inst) =>
      apiGetAs<{ calls: CallRow[] }>(
        `/v1/calls?instanceId=${inst.id}&limit=${CALL_PREVIEW}`,
        orgId,
      ),
    ),
  );
}

/**
 * What the LAYOUT's vitals strip needs, in one call.
 *
 * The strip sits above every instance route, so these six reads happen on all
 * of them - the one cost the split does not remove. It is deliberate: the strip
 * is how an operator knows which customer they are looking at and whether
 * anything is wrong, and a header that changed shape per route would be worse
 * than a little repeated fetching. Everything else is now paid for only by the
 * route that renders it.
 */
export async function loadVitals(orgId: string) {
  const org = await loadOrg(orgId);
  const [instances, fleetHealth, overview, ownerData] = await Promise.all([
    loadInstances(orgId),
    loadFleetHealth(orgId),
    loadOverview(orgId),
    loadOwners(orgId),
  ]);
  const details = await loadInstanceDetails(orgId, instances);

  const deviceTotal = details.reduce((n, d) => n + (d?.devices.length ?? 0), 0);
  const activeKeys = details.reduce(
    (n, d) => n + (d?.keys.filter((k) => k.status === "active").length ?? 0),
    0,
  );
  // Only count handsets this tenant actually has: /devices/fleet-health is
  // org-wide, but a row for a device since removed from every instance would
  // inflate a badge nobody can then act on.
  const enrolledIds = new Set(details.flatMap((d) => d?.devices.map((x) => x.id) ?? []));
  const flagged = fleetHealth.filter((h) => h.needsAttention && enrolledIds.has(h.deviceId)).length;

  return {
    org,
    instances,
    owners: ownerData.owners,
    callStats: overview?.calls,
    deviceTotal,
    activeKeys,
    flagged,
  };
}
