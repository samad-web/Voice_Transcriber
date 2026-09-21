import type { Metadata } from "next";
import type { LeadRoutingMatch, LeadRoutingStrategy, ShareReality } from "@aura/shared";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { ownerTry } from "@/lib/owner-context";
import { requireOwnerFeature } from "@/lib/owner-features";
import { LeadRoutingClient } from "./lead-routing-client";

export const metadata: Metadata = { title: "Lead routing" };

export interface RoutingTarget {
  id: string;
  telecallerId: string;
  name: string;
  position: number;
  sharePct: number;
  delivered: number;
  paused: boolean;
  dailyCap: number | null;
  assignedToday: number;
  /** False when this telecaller has no console login to notify. */
  hasLogin: boolean;
  lastAssignedAt: string | null;
}

export interface RoutingRule {
  id: string;
  name: string;
  description: string | null;
  strategy: LeadRoutingStrategy;
  match: LeadRoutingMatch;
  status: "active" | "paused";
  priority: number;
  workspaceId: string | null;
  cursor: string;
  assignedCount: number;
  windowStartedAt: string;
  lastAssignedAt: string | null;
  createdAt: string;
  targets: RoutingTarget[];
  reality: ShareReality[];
  upNext: Array<{ telecallerId: string | null; name: string | null; reason: string }>;
}

export interface RoutingDecisionRow {
  id: string;
  ruleId: string | null;
  leadId: string | null;
  telecallerId: string | null;
  telecallerName: string | null;
  strategy: string;
  outcome: "assigned" | "unassigned";
  reason: string | null;
  trigger: "intake" | "backfill";
  createdAt: string;
  leadTitle: string | null;
}

export interface RoutingOverview {
  rules: RoutingRule[];
  telecallers: Array<{ id: string; displayName: string; userId: string | null }>;
  decisions: RoutingDecisionRow[];
  unassignedLeads: number;
}

export default async function LeadRoutingPage() {
  // Feature gate (migration 0101), before any fetch: a page this tenant is not
  // provisioned for must neither cost a round trip nor 404 only after proving
  // the data behind it exists.
  await requireOwnerFeature("lead_routing");

  const result = await ownerTry<RoutingOverview>("/v1/owner/lead-routing");

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Lead routing" context="Settings" />
        <LoadFailure what="lead routing" failure={result} />
      </>
    );
  }
  const data = result.data;

  return (
    <>
      <PageHeader title="Lead routing" context="Settings" />
      <p className="-mt-2 max-w-2xl text-sm text-text-muted">
        Who works each new lead. Rules run in order and the first one that
        matches wins, so put your specific rules above the catch-all. Routing
        only ever fills an empty owner - it never moves a lead off somebody, and
        a lead source pinned to one person always beats a rule.
      </p>
      <LeadRoutingClient overview={data} />
    </>
  );
}
