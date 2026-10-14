import type { Metadata } from "next";
import Link from "next/link";
import { Card, MonoLabel } from "@aura/ui";
import { LoadFailure } from "@/components/load-failure";
import { OperatorScopeNote } from "@/components/operator-scope-note";
import { PageHeader } from "@/components/page-header";
import { operatorGate } from "@/lib/operator-gate";
import { apiTryAdmin } from "@/lib/server-api";
import { EscalationBoard } from "./escalation-board";
import type { Escalation, EscalationStats } from "./actions";

export const metadata: Metadata = { title: "Escalations" };

/**
 * The escalation queue: every tenant's reported call problems (migration 0147,
 * doc 36 §13).
 *
 * ── WHY THIS PAGE EXISTS ────────────────────────────────────────────────────
 *
 * Reprocessing a call used to be a button in the CUSTOMER's console. It spent
 * money at the ASR provider on every press, and a client pressing it could not
 * say what was actually wrong - so a run that changed nothing looked exactly like
 * one that fixed it. 0147 took the button away and gave them a way to state the
 * problem instead. This is the other end of that: where we read what they said,
 * decide whether a re-run could plausibly help, and answer them.
 *
 * ── OPEN TO EVERY OPERATOR ──────────────────────────────────────────────────
 *
 * No `isMax` check. Every superadmin works this queue, the same way `/operators`
 * is readable by all of them: a support list only one person can see is a support
 * list nobody works. The narrower privileges over this data are per TENANT, not
 * per operator, and they live in the API (0122's gate).
 *
 * ── HOW IT READS ────────────────────────────────────────────────────────────
 *
 * `apiTryAdmin`, twice, CONCURRENTLY: both routes are cross-tenant, so neither
 * may carry an org header, and a broken stats query must not blank the work list
 * that somebody actually came here for. `apiTryAdmin` rather than `apiGetAdmin`
 * so a failure can say which failure it was.
 *
 * Everything the board WRITES goes through `./actions`, each of which re-asserts
 * `requireOperator()` - a page gate has never been a boundary for a Server
 * Action, and those actions carry the operator's name, which every mutation on
 * that controller requires.
 */
export default async function SupportPage({
  searchParams,
}: {
  /**
   * `?source=system` narrows the queue to tickets the PLATFORM opened against
   * itself (P12) - the destination of the commercial dashboard's incidents
   * CTA. Validated here rather than forwarded: an unrecognised value must mean
   * "no filter" and never reach the API as one, because the API would then
   * decide what an unknown source means.
   */
  searchParams: Promise<{ source?: string }>;
}) {
  const blocked = await operatorGate();
  if (blocked) return blocked;

  const { source } = await searchParams;
  const sourceFilter = source === "system" || source === "client" ? source : null;

  const [queue, stats] = await Promise.all([
    apiTryAdmin<{ reports: Escalation[]; scope?: string | null; scopeNote?: string | null }>(
      `/v1/admin/call-issues?state=unacknowledged${
        sourceFilter ? `&source=${sourceFilter}` : ""
      }`,
    ),
    apiTryAdmin<EscalationStats>("/v1/admin/call-issues/stats"),
  ]);

  return (
    <>
      <PageHeader
        title="Escalations"
        context="Support"
        description="Problems clients have reported with their processed calls. Re-running a call is ours to do, and it spends - so read the snapshot before you press it."
      />

      {/* A filtered queue says so. The board's own counts come from the
          unfiltered stats route, so without this line a reader sees "3 open"
          above a list of one and distrusts both. */}
      {sourceFilter ? (
        <Card>
          <MonoLabel>
            {sourceFilter === "system" ? "Platform incidents only" : "Client reports only"}
          </MonoLabel>
          <p className="mt-1 text-sm text-text-muted">
            {sourceFilter === "system"
              ? "Showing only tickets the platform opened against itself - a vendor refusing us, a worker that stopped. A client's own report is not one of these."
              : "Showing only tickets a client reported."}{" "}
            <Link href="/support" className="underline hover:text-text">
              Show the whole queue
            </Link>
            .
          </p>
        </Card>
      ) : null}

      {/* Doc 49 P13b. Above the board, because the board's own stats row is
          computed over the scoped queue too. */}
      {queue.ok ? (
        <OperatorScopeNote
          scope={queue.data.scope}
          note={queue.data.scopeNote}
          subject="clients"
        />
      ) : null}

      {queue.ok ? (
        <EscalationBoard
          initialReports={queue.data.reports}
          initialStats={stats.ok ? stats.data : null}
        />
      ) : (
        <LoadFailure failure={queue} what="the escalation queue" />
      )}
    </>
  );
}
