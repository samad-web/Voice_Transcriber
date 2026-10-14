import Link from "next/link";
import { Card, MonoLabel, StatusChip } from "@aura/ui";
import { ageFrom, hoursMinutes, money, pct } from "./money";
import type { CommercialClient, Commercial } from "./types";

/**
 * ROW 4 - THE CLIENT TABLE, EXTENDED TO THE COLUMNS AN OPERATOR ACTS ON.
 *
 * Doc 49 P13c: plan, MRR, last invoice status, capture minutes used vs limit,
 * transcription success rate, enabled modules, last call, and - new - ONBOARDED
 * BY. That last column is doc 49's own phrasing for why it matters: it is "what
 * makes the hierarchy legible rather than merely enforced".
 *
 * ── WHY MRR IS A WORD AND NOT ALWAYS A NUMBER ───────────────────────────────
 *
 * Six states reach this cell and "₹0" would be the same pixel for four of
 * them: a trial, a cancellation, a tenant with no subscription row, and a
 * tenant on a plan nobody has published a price for. Those call for four
 * different actions, so each prints its own word. The unpriced one is the
 * important one - it is revenue we are probably collecting and cannot report.
 *
 * ── SORTED BY MRR, NOT BY NAME ──────────────────────────────────────────────
 *
 * The roster at /instances is sorted for finding a client you already have in
 * mind. This table is for reading the book, and the book reads top-down by
 * what each client is worth. Unpriced and non-paying clients sort last rather
 * than being mixed in at zero.
 */

/** What this tenant's MRR cell says, and whether it is a number. */
function mrrCell(c: CommercialClient): { text: string; muted: boolean; note?: string } {
  switch (c.mrr.state) {
    case "recurring":
      return { text: `${money(c.mrr.minor, c.mrr.currency)}/mo`, muted: false };
    case "at_risk":
      return {
        text: `${money(c.mrr.minor, c.mrr.currency)}/mo`,
        muted: false,
        note: "past due",
      };
    case "trialing":
      return {
        text: "In trial",
        muted: true,
        note: c.trialEndsAt ? `ends ${new Date(c.trialEndsAt).toLocaleDateString()}` : undefined,
      };
    case "cancelled":
      return { text: "Cancelled", muted: true };
    case "no_subscription":
      return { text: "No subscription", muted: true, note: "predates the plan system" };
    case "unpriced":
      return { text: "Unpriced", muted: true, note: "no published price for this plan" };
  }
}

const MRR_ORDER: Record<CommercialClient["mrr"]["state"], number> = {
  recurring: 0,
  at_risk: 1,
  trialing: 2,
  unpriced: 3,
  no_subscription: 4,
  cancelled: 5,
};

const STATUS_TONE = {
  active: "solid",
  suspended: "muted",
  churned: "danger",
} as const;

export function ClientTable({ data }: { data: Commercial }) {
  const clients = [...data.clients].sort((a, b) => {
    const byState = MRR_ORDER[a.mrr.state] - MRR_ORDER[b.mrr.state];
    if (byState !== 0) return byState;
    if (b.mrr.minor !== a.mrr.minor) return b.mrr.minor - a.mrr.minor;
    return a.name.localeCompare(b.name);
  });

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b-2 border-border-strong px-5 py-4">
        <div>
          <MonoLabel>Clients</MonoLabel>
          <p className="mt-1 text-xs text-text-muted">
            Sorted by what each one is worth per month. Non-paying states sort last rather than
            being mixed in at zero.
          </p>
        </div>
        <Link href="/instances" className="text-xs text-text-muted underline hover:text-text">
          Full roster &rarr;
        </Link>
      </div>

      {clients.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-text-muted">
          {data.scope === "all" || !data.scope
            ? "No clients yet."
            : "No clients are attributed to your account."}
        </p>
      ) : (
        /* Below `md` each client draws as a labelled card (theme.css). Nine
           columns at a 1200px minimum is three times a phone, and the data
           labels are what make the stacked form readable. */
        <div data-stacked="true" className="overflow-x-auto">
          <table className="w-full min-w-[1200px] text-left border-collapse">
            <thead>
              <tr className="bg-bg-subtle border-b-2 border-border-strong font-mono text-[10px] font-bold uppercase tracking-wider text-text">
                <th className="px-5 py-3">Client</th>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3">MRR</th>
                <th className="px-4 py-3">Last order</th>
                <th className="px-4 py-3">Capture</th>
                <th className="px-4 py-3">Transcription 24h</th>
                <th className="px-4 py-3">Last call</th>
                <th className="px-4 py-3">Onboarded by</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y-2 divide-border text-sm">
              {clients.map((c) => {
                const cell = mrrCell(c);
                const captureShare =
                  c.capture.limitMinutes && c.capture.limitMinutes > 0
                    ? Math.round((c.capture.usedMinutes / c.capture.limitMinutes) * 10_000)
                    : null;
                return (
                  <tr key={c.orgId} className="hover:bg-surface-hover">
                    <td className="px-5 py-4" data-label="Client">
                      <Link
                        href={`/instances/${c.orgId}`}
                        className="block font-display font-bold text-text hover:underline"
                      >
                        {c.name}
                      </Link>
                      <span className="text-[10px] text-text-muted">
                        {c.enabledModules.length > 0
                          ? c.enabledModules.join(", ")
                          : "no modules"}
                      </span>
                      {c.openIncidents > 0 ? (
                        <span className="block text-[10px] text-danger-text">
                          {c.openIncidents} open platform incident
                          {c.openIncidents === 1 ? "" : "s"}
                        </span>
                      ) : null}
                    </td>

                    <td className="px-4 py-4 font-mono text-xs" data-label="Plan">
                      {c.planName ?? <span className="text-text-muted">&mdash;</span>}
                      {c.billingPeriod ? (
                        <span className="block text-[10px] text-text-subtle">
                          billed {c.billingPeriod}
                        </span>
                      ) : null}
                    </td>

                    <td className="px-4 py-4 font-mono text-xs tabular-nums" data-label="MRR">
                      <span className={cell.muted ? "text-text-muted" : "font-bold text-text"}>
                        {cell.text}
                      </span>
                      {cell.note ? (
                        <span className="block text-[10px] text-text-subtle">{cell.note}</span>
                      ) : null}
                      {c.unpricedAddons.length > 0 ? (
                        <span className="block text-[10px] text-danger-text">
                          {c.unpricedAddons.length} add-on
                          {c.unpricedAddons.length === 1 ? "" : "s"} unpriced
                        </span>
                      ) : null}
                    </td>

                    <td className="px-4 py-4 font-mono text-xs" data-label="Last order">
                      {c.lastOrderStatus ? (
                        <span
                          className={
                            c.lastOrderStatus === "paid" ? "text-text" : "text-danger-text"
                          }
                        >
                          {c.lastOrderStatus}
                        </span>
                      ) : (
                        <span className="text-text-muted">none</span>
                      )}
                      {c.unsettled.orders > 0 ? (
                        <span className="block text-[10px] text-danger-text">
                          {money(c.unsettled.minor, c.mrr.currency)} unsettled
                          {c.unsettled.oldestAt ? `, ${ageFrom(c.unsettled.oldestAt)} old` : ""}
                        </span>
                      ) : null}
                    </td>

                    <td className="px-4 py-4 font-mono text-xs tabular-nums" data-label="Capture">
                      {c.capture.limitMinutes === null ? (
                        <span className="text-text-muted">no limit</span>
                      ) : (
                        <>
                          <span className={c.capture.overLimit ? "text-danger-text" : "text-text"}>
                            {pct(captureShare, 0)}
                          </span>
                          <span className="block text-[10px] text-text-subtle">
                            {hoursMinutes(c.capture.usedMinutes)} of{" "}
                            {hoursMinutes(c.capture.limitMinutes)}
                          </span>
                        </>
                      )}
                    </td>

                    <td
                      className="px-4 py-4 font-mono text-xs tabular-nums"
                      data-label="Transcription 24h"
                    >
                      {c.transcription24h.rateBp === null ? (
                        <span className="text-text-muted">no calls</span>
                      ) : (
                        <>
                          <span
                            className={
                              c.transcription24h.rateBp < 9000 ? "text-danger-text" : "text-text"
                            }
                          >
                            {pct(c.transcription24h.rateBp, 0)}
                          </span>
                          <span className="block text-[10px] text-text-subtle">
                            {c.transcription24h.complete} of {c.transcription24h.audioCalls}
                          </span>
                        </>
                      )}
                    </td>

                    <td className="px-4 py-4 font-mono text-xs" data-label="Last call">
                      {c.lastCallAt ? (
                        new Date(c.lastCallAt).toLocaleDateString()
                      ) : (
                        <span className="text-text-muted">never</span>
                      )}
                    </td>

                    <td className="px-4 py-4 font-mono text-xs" data-label="Onboarded by">
                      {c.onboardedByRole === "self_serve" ? (
                        <>
                          <span className="text-text">Self-serve</span>
                          <span className="block text-[10px] text-text-subtle">
                            no operator
                          </span>
                        </>
                      ) : c.onboardedBy ? (
                        <>
                          <span className="text-text">{c.onboardedBy}</span>
                          <span className="block text-[10px] text-text-subtle">
                            {c.onboardedByRole === "root" ? "Root" : "Superadmin"}
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="text-text-muted">Not recorded</span>
                          <span className="block text-[10px] text-text-subtle">
                            predates attribution
                          </span>
                        </>
                      )}
                    </td>

                    <td className="px-4 py-4" data-label="Status">
                      <StatusChip
                        tone={STATUS_TONE[c.status as keyof typeof STATUS_TONE] ?? "muted"}
                      >
                        {c.status}
                      </StatusChip>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
