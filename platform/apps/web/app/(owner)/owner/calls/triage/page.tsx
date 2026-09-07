import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerGet } from "@/lib/owner-context";
import { TriageQueue } from "./triage-queue";
import type { TriageCounts, UnmatchedCall } from "./actions";

export const metadata: Metadata = { title: "Unmatched calls - Aura" };

interface TriageResponse {
  calls: UnmatchedCall[];
  counts: TriageCounts;
  status: "unmatched" | "dismissed";
}

/**
 * Calls that reached nobody in the pipeline (migration 0094).
 *
 * ── WHAT IS ACTUALLY IN HERE ────────────────────────────────────────────────
 *
 * Not "calls the system failed to process". The sweep links a call to a lead
 * by exact number hash, and that match is deterministic - so what lands on
 * this page is only ever the residue a machine cannot decide: a call whose
 * handset had no call-log permission and therefore carries no number, and a
 * call to a number nobody has ever qualified. The first needs a person to say
 * which lead it was; the second needs a person to say whether it was business
 * at all.
 *
 * ── THE REDIRECT IS NOT THE SECURITY BOUNDARY ───────────────────────────────
 *
 * Same as every other owner/manager page here: the routes behind it carry
 * `@RequireOwnerRole("owner", "manager")` read from `memberships`, and the
 * `call_intel` module is checked per request. This redirect only spares a
 * telecaller following a stale link a page of empty cards.
 */
export default async function CallTriagePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const owner = await getOwner();
  if (!owner) redirect("/dashboard");

  const role = owner.membership.ownerRole;
  if (role !== "owner" && role !== "manager") redirect("/owner");

  const { status: statusParam } = await searchParams;
  const status = statusParam === "dismissed" ? "dismissed" : "unmatched";

  // 15s: the same floor the productivity rollup uses for "connected"
  // (organizations.connected_call_seconds, 0090). A two-second ring-out has
  // nothing in it to triage, and leaving them in makes the queue mostly noise
  // on a floor that dials a lot.
  const data = await ownerGet<TriageResponse>(
    `/v1/owner/call-triage?status=${status}&minSeconds=15&limit=100`,
  );

  if (!data) {
    return (
      <>
        <PageHeader title="Unmatched calls" context="Conversations" />
        <Card>
          <MonoLabel>Data unavailable</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The platform API did not answer, or call intelligence is not enabled on this instance.
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Unmatched calls" context="Conversations" />
      <p className="-mt-2 max-w-prose text-sm leading-relaxed text-text-muted">
        Calls with no lead behind them. Most calls attach themselves automatically — the number on
        the call and the number on the lead are the same value, so the match needs no guesswork.
        What is left is the part that does: make a lead from it, attach it to one that exists, or
        say it was not business. Calls shorter than 15 seconds are left out.
      </p>
      <TriageQueue initial={data.calls} counts={data.counts} status={data.status} />
    </>
  );
}
