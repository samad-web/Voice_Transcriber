import type { Metadata } from "next";
import Link from "next/link";
import { formatMoney, toMinor } from "@aura/shared";
import { Card, EmptyState, MonoLabel, SectionHeading, StatusChip } from "@aura/ui";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { ownerTry, requireFeature } from "@/lib/owner-context";

export const metadata: Metadata = { title: "Money-leak inbox" };

interface Alert {
  id: string;
  ruleCode: string;
  ruleLabel: string;
  recommendedAction: string | null;
  statistical: boolean;
  subjectType: string;
  subjectRef: string;
  severity: "low" | "medium" | "high" | "critical";
  status: string;
  amountAtRisk: number | null;
  currency: string;
  assigneeName: string | null;
  assignedRole: string | null;
  escalatedTo: string | null;
  message: string;
  explain: {
    formula?: string;
    inputs?: Record<string, string | number | null>;
    records?: { type: string; id: string; label?: string }[];
    silentBecause?: string | null;
    sampleSize?: number | null;
  };
  firstSeenAt: string;
  lastSeenAt: string;
  dismissCount: number;
}

interface AlertsData {
  alerts: Alert[];
  total: number;
  openBySeverity: Record<string, number>;
}

interface LeaksData {
  totalAtRisk: number;
  byRule: { code: string; label: string; action: string | null; routeTo: string | null; atRisk: number; alerts: number }[];
}

/**
 * §12.6's money-leak report and alert inbox.
 *
 * ── EVERY ROW SHOWS THE RULE, THE CALCULATION AND THE RECORDS ──────────────
 *
 * §12 is a MUST: "every advisory must be reproducible from data and must show
 * the rule that fired, the calculation, and links to the underlying records."
 * So each alert renders its `explain` payload inline rather than behind a
 * second click - the formula with its numbers substituted, the named inputs,
 * and a link per record.
 *
 * The payload is STORED on the alert, not recomputed here. That is what makes
 * the panel honest a month later: an alert raised when a category's median was
 * ₹40,000 still explains itself after the median moves, and a panel that
 * recomputed would eventually contradict the alert it belongs to.
 *
 * ── AND NOTHING ON THIS PAGE WAS WRITTEN BY A MODEL ────────────────────────
 *
 * §12: "rules and statistics decide; language only explains." Every sentence
 * here comes from a rule's `messageTemplate` with values substituted, or from
 * the catalogue's own `recommendedAction`. There is no model call anywhere
 * under `finance/` - the deciding functions are pure and cannot reach a
 * network, which makes the property structural rather than a promise.
 */
export default async function AdvisorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireFeature("/owner/finance/advisor");

  const sp = await searchParams;
  const order = (Array.isArray(sp.order) ? sp.order[0] : sp.order) === "at_risk" ? "at_risk" : "newest";

  const [alerts, leaks] = await Promise.all([
    ownerTry<AlertsData>(`/v1/finance/advisor/alerts?order=${order}&limit=100`),
    ownerTry<LeaksData>("/v1/finance/advisor/leaks"),
  ]);

  if (!alerts.ok) {
    return (
      <>
        <PageHeader title="Money-leak inbox" context="Sales" />
        <LoadFailure what="the Advisor's inbox" failure={alerts} />
      </>
    );
  }

  const money = (major: number, currency = "INR") =>
    formatMoney(toMinor(major, currency), { currency });
  const open = alerts.data.openBySeverity;

  return (
    <>
      <PageHeader
        title="Money-leak inbox"
        context="Sales"
        description="Found by rules and statistics - never by a language model, and never sent to a customer."
        actions={
          <Link
            href="/owner/finance/advisor/rules"
            className="text-xs text-text-muted underline hover:text-text"
          >
            Tune the rules
          </Link>
        }
      />

      {/* §12.6's leak report: ranked by rupees, severity as the tie-break.
          Money first because the question this page answers is "where is it
          going"; severity is the second question, not the first. */}
      {leaks.ok && leaks.data.byRule.length > 0 ? (
        <section className="space-y-3">
          <SectionHeading
            title={`${money(leaks.data.totalAtRisk)} at risk`}
            description="Ranked by the money involved. A connector problem carries no amount - it is ingestion at risk, not rupees."
          />
          <Card className="space-y-2 p-4">
            {leaks.data.byRule.map((rule) => (
              <div key={rule.code} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                <span className="font-mono text-xs tabular-nums text-text-muted">
                  {rule.atRisk === 0 ? "—" : money(rule.atRisk)}
                </span>
                <span className="text-text">{rule.label}</span>
                <span className="text-xs text-text-muted">
                  {rule.alerts} open · goes to {rule.routeTo?.replace("_", " ") ?? "nobody"}
                </span>
                {rule.action ? (
                  <span className="basis-full text-xs text-text-muted">{rule.action}</span>
                ) : null}
              </div>
            ))}
          </Card>
        </section>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 text-xs">
        {(["critical", "high", "medium", "low"] as const).map((severity) => (
          <span key={severity} className="rounded-md border border-border px-2 py-1 text-text-muted">
            {severity} · {open[severity] ?? 0}
          </span>
        ))}
        <Link
          href={`/owner/finance/advisor?order=${order === "at_risk" ? "newest" : "at_risk"}`}
          className="ml-auto underline hover:text-text"
        >
          {order === "at_risk" ? "Sort by newest" : "Sort by money at risk"}
        </Link>
      </div>

      {alerts.data.alerts.length === 0 ? (
        <EmptyState
          title="Nothing is leaking"
          description="No rule has found anything. The four statistical rules stay silent until there are eight periods of history to compare against, so a new workspace is quiet by construction rather than by configuration."
        />
      ) : (
        <ul className="space-y-3">
          {alerts.data.alerts.map((alert) => (
            <li key={alert.id}>
              <Card className="space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      {/* Severity as a StatusChip. `critical`/`high` take the
                          `danger` tone, which draws from the console's ERROR
                          orange rather than the red that means a missed call -
                          a settlement mismatch is a fault, not a call nobody
                          answered.

                          StatusChip rather than StateChip because an alert
                          severity is not one of the four call states, and
                          StateChip appends the tone's call meaning for screen
                          readers when the label is overridden. */}
                      <StatusChip
                        tone={
                          alert.severity === "critical" || alert.severity === "high"
                            ? "danger"
                            : "muted"
                        }
                      >
                        {alert.severity}
                      </StatusChip>
                      <span className="text-sm text-text">{alert.ruleLabel}</span>
                      {alert.statistical ? <MonoLabel>statistical</MonoLabel> : null}
                    </div>
                    <p className="text-sm text-text">{alert.message}</p>
                    {alert.recommendedAction ? (
                      <p className="text-xs text-text-muted">→ {alert.recommendedAction}</p>
                    ) : null}
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-sm tabular-nums">
                      {alert.amountAtRisk === null ? "—" : money(alert.amountAtRisk, alert.currency)}
                    </p>
                    <p className="text-xs text-text-muted">
                      {alert.assigneeName ?? alert.assignedRole?.replace("_", " ") ?? "unassigned"}
                      {alert.escalatedTo ? ` · escalated to ${alert.escalatedTo.replace("_", " ")}` : null}
                    </p>
                  </div>
                </div>

                {/* §12.6's explain panel. Inline, not behind a disclosure: an
                    explanation somebody has to go looking for is an
                    explanation they will not read, and the whole premise of a
                    logic-driven Advisor is that its reasoning is checkable. */}
                <details className="rounded-md border border-border bg-bg-subtle p-3">
                  <summary className="cursor-pointer text-xs text-text-muted">
                    Why this fired
                  </summary>
                  <div className="mt-2 space-y-2 text-xs">
                    <p className="font-mono text-text">{alert.explain.formula ?? "—"}</p>
                    {alert.explain.inputs && Object.keys(alert.explain.inputs).length > 0 ? (
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
                        {Object.entries(alert.explain.inputs).map(([key, value]) => (
                          <div key={key} className="flex justify-between gap-2">
                            <dt className="text-text-muted">{key}</dt>
                            <dd className="font-mono tabular-nums">{value ?? "—"}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                    {alert.explain.sampleSize !== null && alert.explain.sampleSize !== undefined ? (
                      <p className="text-text-muted">
                        Compared against {alert.explain.sampleSize} period
                        {alert.explain.sampleSize === 1 ? "" : "s"} of this workspace&apos;s own
                        history.
                      </p>
                    ) : null}
                    {alert.explain.records && alert.explain.records.length > 0 ? (
                      <p className="text-text-muted">
                        {alert.explain.records.length} underlying record
                        {alert.explain.records.length === 1 ? "" : "s"}:{" "}
                        {alert.explain.records.map((r) => r.label ?? r.type).join(", ")}
                      </p>
                    ) : null}
                    <p className="text-text-muted">
                      First seen {alert.firstSeenAt.slice(0, 10)} · last confirmed{" "}
                      {alert.lastSeenAt.slice(0, 10)}
                      {alert.dismissCount > 0
                        ? ` · dismissed ${alert.dismissCount} time${alert.dismissCount === 1 ? "" : "s"} before`
                        : null}
                    </p>
                  </div>
                </details>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-text-muted">
        The Advisor notifies your own people and creates tasks for them. It never messages a
        customer and never moves money.
      </p>
    </>
  );
}
