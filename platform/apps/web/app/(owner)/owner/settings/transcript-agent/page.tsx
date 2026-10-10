import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, StatusChip } from "@aura/ui";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerTry } from "@/lib/owner-context";
import { AgentSwitchboard } from "./switchboard";

export const metadata: Metadata = { title: "Call assistant" };

/**
 * §3A.6's ADMIN UI: Settings → Features → Transcript Agent.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE SCREEN'S JOB IS TO MAKE THE CONSEQUENCES LEGIBLE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §3A.6 asks for a master switch, a maximum mode, a capability checklist "with
 * a plain-language explanation of each", a users table with usage and accuracy,
 * defaults, a change dialog that "states exactly what will happen", a locked
 * state, and an audit tab.
 *
 * All of that is one page here rather than a wizard, because the decisions are
 * not sequential: an owner comes to this screen to answer one question - "what
 * is this allowed to do, and for whom" - and a wizard would make them walk
 * past four answers to change the fifth.
 *
 * ── THE BLURBS COME FROM THE API, NOT FROM THIS FILE ─────────────────────
 *
 * `GET /features/gated/catalogue` serves the mode and capability explanations
 * out of `GATED_FEATURES` in @aura/shared. A second copy here would be a
 * second answer to "what does `assisted` mean" - and the one an owner reads
 * when deciding has to be the one the gate enforces.
 *
 * ── THE LOCKED STATE IS THE ONE PLACE A GREYED-OUT CONTROL IS RIGHT ──────
 *
 * §3A.4: sections are "hidden, not greyed out (EXCEPT AN OWNER-ONLY 'locked,
 * upgrade' state)". That exception is this page: an owner whose plan does not
 * include the module needs to see that the feature exists and is not theirs
 * yet, which is the only way they would know to ask for it.
 */

interface CatalogueResponse {
  features: Array<{
    key: string;
    name: string;
    description: string;
    module: string;
    modes: Array<{ key: string; label: string; blurb: string }>;
    capabilities: Array<{ key: string; label: string; blurb: string }>;
    defaultModeOnEnable: string;
    defaultCapabilitiesOnEnable: string[];
    consentNoticeVersion: string;
  }>;
}

export interface UsersResponse {
  feature: string;
  org: {
    id: string;
    state: string;
    mode: string | null;
    capabilities: string[] | null;
    effective_from: string;
  } | null;
  users: Array<{
    userId: string | null;
    telecallerId: string | null;
    name: string;
    position: string | null;
    teamId: string | null;
    teamName: string | null;
    ownerRole: string | null;
    state: string;
    mode: string;
    capabilities: string[] | null;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    lastActivityAt: string | null;
    usage: { transcripts: number; audioMinutes: number; modelCostMinor: number };
    precision: number | null;
    reviewedCases: number;
  }>;
}

export default async function TranscriptAgentSettingsPage() {
  const owner = await getOwner();
  // OWNER ONLY. §18: "who can change toggles: owner and admin only." The nav
  // already restricts the entry; this is the gate a bookmark hits.
  if (!owner?.membership) notFound();
  if (owner.membership.ownerRole !== "owner") notFound();

  const entitled = owner.membership.enabledModules.includes("call_intel");

  const [catalogue, users] = await Promise.all([
    ownerTry<CatalogueResponse>("/v1/features/gated/catalogue"),
    // Not fetched when the plan lacks the module: the locked state needs the
    // catalogue (to say what the feature IS) and nothing else, and asking for a
    // users table the API would refuse is a round trip for a 403.
    entitled
      ? ownerTry<UsersResponse>("/v1/features/gated/users")
      : Promise.resolve(null),
  ]);

  if (!catalogue.ok) {
    return (
      <>
        <PageHeader title="Call assistant" context="Settings" />
        <LoadFailure failure={catalogue} what="the call assistant's settings" />
      </>
    );
  }

  const spec = catalogue.data.features.find((f) => f.key === "transcript_agent");
  if (!spec) notFound();

  if (!entitled) {
    // §3A.6's locked state. Owner-only, which this page already is.
    return (
      <>
        <PageHeader title="Call assistant" context="Settings" />
        <Card>
          <div className="p-6">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">{spec.name}</h2>
              <StatusChip tone="outline">Not part of your plan</StatusChip>
            </div>
            <p className="mt-2 max-w-prose text-sm text-text-muted">{spec.description}</p>
            <p className="mt-4 max-w-prose text-sm text-text-muted">
              It reads what was said on a call, so it needs the call-transcription part of
              the product. Contact your provider to have it switched on for this workspace.
            </p>
          </div>
        </Card>
      </>
    );
  }

  if (users && !users.ok) {
    return (
      <>
        <PageHeader title="Call assistant" context="Settings" />
        <LoadFailure failure={users} what="who the call assistant is on for" />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Call assistant"
        context="Settings"
        description="What it may do, and for whom. Off for everybody until you say otherwise."
      />
      <AgentSwitchboard spec={spec} data={users?.ok ? users.data : null} />
    </>
  );
}
