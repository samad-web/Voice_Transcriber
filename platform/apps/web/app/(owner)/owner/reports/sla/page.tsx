import type { Metadata } from "next";
import { Card, EmptyState, MonoLabel, StatusChip } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import { requireOwnerFeature } from "@/lib/owner-features";

export const metadata: Metadata = { title: "Response & Follow-ups" };

interface ResponseTimeReport {
  from: string;
  to: string;
  timezone: string;
  kpi: {
    leads: number;
    responded: number;
    unresponded: number;
    medianMinutes: number | null;
    avgMinutes: number | null;
    within5min: number;
    within30min: number;
    within1hr: number;
    within1hrPct: number | null;
  };
  buckets: Array<{ key: string; label: string; count: number; pct: number | null }>;
  byTelecaller: Array<{
    telecallerId: string | null;
    telecaller: string;
    leads: number;
    responded: number;
    unresponded: number;
    medianMinutes: number | null;
    within1hPct: number | null;
  }>;
  awaitingFirstResponse: Array<{
    id: string;
    title: string;
    contactName: string | null;
    stage: string;
    createdAt: string;
    hoursWaiting: number;
  }>;
}

interface ComplianceReport {
  from: string;
  to: string;
  today: string;
  kpi: {
    total: number;
    completed: number;
    overdue: number;
    pending: number;
    completedLate: number;
    completedOnTime: number;
    compliancePct: number | null;
  };
  byUser: Array<{
    userId: string | null;
    assignee: string;
    total: number;
    completed: number;
    overdue: number;
    pending: number;
    compliancePct: number | null;
  }>;
  overdueList: Array<{
    id: string;
    title: string;
    dueOn: string;
    assignee: string;
    overdueDays: number;
  }>;
}

interface AgingReport {
  total: number;
  neverResponded: number;
  buckets: Array<{
    key: string;
    label: string;
    count: number;
    pct: number | null;
    minDays: number;
    maxDays: number | null;
  }>;
  stale: Array<{
    id: string;
    title: string;
    contactName: string | null;
    stage: string;
    ageDays: number;
    neverResponded: boolean;
  }>;
}

/**
 * Response time, follow-up compliance and lead aging - Tier 1 of the Hawcus
 * gap analysis (Build docs/21_HAWCUS_CRM_GAP_ANALYSIS.md, G1-G3).
 *
 * One page rather than three, because the three answer one question between
 * them - "is the floor keeping up?" - and splitting them would mean a manager
 * checking three tabs to find out.
 *
 * Every count on this page is a work queue, not a statistic: the design note
 * the gap analysis took from Hawcus (§3.7) is that a number nobody can act on
 * is decoration. So each section ends in a LIST of the actual records behind
 * the worst number in it.
 */
export default async function SlaReportsPage() {
  // Feature gate (migration 0093). Before any fetch: a page this tenant is
  // not provisioned for must neither cost a round trip nor 404 only after
  // proving the data behind it exists.
  await requireOwnerFeature("reports");

  const [response, compliance, aging] = await Promise.all([
    ownerGet<ResponseTimeReport>("/v1/reports/response-time"),
    ownerGet<ComplianceReport>("/v1/reports/followup-compliance"),
    ownerGet<AgingReport>("/v1/reports/lead-aging"),
  ]);

  if (!response && !compliance && !aging) {
    return (
      <>
        <PageHeader title="Response & Follow-ups" context="Pipeline" />
        <Card>
          <MonoLabel>Data unavailable</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The platform API did not answer. If this persists, contact your provider.
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Response & Follow-ups" context="Pipeline" />

      {/* ── Response time ─────────────────────────────────────────────── */}
      <SectionHeading
        title="Lead response time"
        note={
          response
            ? `Leads that arrived ${response.from} to ${response.to} (${response.timezone})`
            : undefined
        }
      />

      {response ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label="Median first response"
              value={fmtMinutes(response.kpi.medianMinutes)}
              hint={`Mean ${fmtMinutes(response.kpi.avgMinutes)} - skewed by the slowest few`}
            />
            <Stat
              label="Answered within 1 hour"
              value={fmtPct(response.kpi.within1hrPct)}
              hint={`${response.kpi.within1hr} of ${response.kpi.leads} leads`}
            />
            <Stat
              label="Answered within 5 min"
              value={String(response.kpi.within5min)}
              hint={`${response.kpi.within30min} within 30 min`}
            />
            <Stat
              label="Never answered"
              value={String(response.kpi.unresponded)}
              hint="Nobody has touched these at all"
            />
          </div>

          <Card>
            <MonoLabel>How fast, in bands</MonoLabel>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[420px] border-collapse text-left text-sm">
                <thead>
                  <tr>
                    <Th>Band</Th>
                    <Th right>Leads</Th>
                    <Th right>Share</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {response.buckets.map((b) => (
                    <tr key={b.key}>
                      <Td>{b.label}</Td>
                      <Td right>{b.count}</Td>
                      <Td right>{fmtPct(b.pct)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {response.byTelecaller.length > 0 ? (
            <Card>
              <MonoLabel>By telecaller</MonoLabel>
              <p className="mt-1 text-xs text-text-muted">
                A lead is assigned to a telecaller, so this breaks down by telecaller. Follow-ups
                below break down by console user - the two are different people and are never
                added together.
              </p>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[560px] border-collapse text-left text-sm">
                  <thead>
                    <tr>
                      <Th>Telecaller</Th>
                      <Th right>Leads</Th>
                      <Th right>Answered</Th>
                      <Th right>Never</Th>
                      <Th right>Median</Th>
                      <Th right>Within 1h</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {response.byTelecaller.map((row) => (
                      <tr key={row.telecallerId ?? "unassigned"}>
                        <Td>{row.telecaller}</Td>
                        <Td right>{row.leads}</Td>
                        <Td right>{row.responded}</Td>
                        <Td right>{row.unresponded}</Td>
                        <Td right>{fmtMinutes(row.medianMinutes)}</Td>
                        <Td right>{fmtPct(row.within1hPct)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          <Card>
            <MonoLabel>Waiting for a first response</MonoLabel>
            <p className="mt-1 text-xs text-text-muted">
              Open leads nobody has touched, oldest first. Not limited to the window above - a
              lead ignored six weeks ago is still ignored.
            </p>
            {response.awaitingFirstResponse.length === 0 ? (
              <div className="mt-3">
                <EmptyState title="Every open lead has been answered." />
              </div>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[520px] border-collapse text-left text-sm">
                  <thead>
                    <tr>
                      <Th>Lead</Th>
                      <Th>Contact</Th>
                      <Th>Stage</Th>
                      <Th right>Waiting</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {response.awaitingFirstResponse.map((lead) => (
                      <tr key={lead.id}>
                        <Td>{lead.title}</Td>
                        <Td>{lead.contactName ?? "-"}</Td>
                        <Td>{lead.stage}</Td>
                        <Td right>{fmtHours(lead.hoursWaiting)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      ) : (
        <NotPermitted what="Response time" />
      )}

      {/* ── Follow-up compliance ──────────────────────────────────────── */}
      <SectionHeading
        title="Follow-up compliance"
        note={
          compliance
            ? `Follow-ups due ${compliance.from} to ${compliance.to}`
            : undefined
        }
      />

      {compliance ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label="Compliance"
              value={fmtPct(compliance.kpi.compliancePct)}
              hint="Of follow-ups whose date has passed. Work due later is not counted."
            />
            <Stat
              label="Overdue"
              value={String(compliance.kpi.overdue)}
              hint={`${compliance.kpi.pending} still due later`}
            />
            <Stat
              label="Completed on time"
              value={String(compliance.kpi.completedOnTime)}
              hint={`${compliance.kpi.completedLate} completed late`}
            />
            <Stat label="Follow-ups in window" value={String(compliance.kpi.total)} />
          </div>

          {compliance.byUser.length > 0 ? (
            <Card>
              <MonoLabel>By assignee</MonoLabel>
              <p className="mt-1 text-xs text-text-muted">
                Lowest compliance first. A dash means nothing of theirs had come due yet.
              </p>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[520px] border-collapse text-left text-sm">
                  <thead>
                    <tr>
                      <Th>Assignee</Th>
                      <Th right>Due</Th>
                      <Th right>Done</Th>
                      <Th right>Overdue</Th>
                      <Th right>Compliance</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {compliance.byUser.map((row) => (
                      <tr key={row.userId ?? "unassigned"}>
                        <Td>{row.assignee}</Td>
                        <Td right>{row.total}</Td>
                        <Td right>{row.completed}</Td>
                        <Td right>{row.overdue}</Td>
                        <Td right>{fmtPct(row.compliancePct)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          <Card>
            <MonoLabel>Overdue now</MonoLabel>
            {compliance.overdueList.length === 0 ? (
              <div className="mt-3">
                <EmptyState title="Nothing is overdue." />
              </div>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[520px] border-collapse text-left text-sm">
                  <thead>
                    <tr>
                      <Th>Follow-up</Th>
                      <Th>Assignee</Th>
                      <Th>Was due</Th>
                      <Th right>Days late</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {compliance.overdueList.map((task) => (
                      <tr key={task.id}>
                        <Td>{task.title}</Td>
                        <Td>{task.assignee}</Td>
                        <Td>{task.dueOn}</Td>
                        <Td right>{task.overdueDays}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      ) : (
        <NotPermitted what="Follow-up compliance" />
      )}

      {/* ── Lead aging ────────────────────────────────────────────────── */}
      <SectionHeading title="Lead aging" note="Open leads, by how long they have been sitting" />

      {aging ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
            {aging.buckets.map((b) => (
              <Stat
                key={b.key}
                label={b.label}
                value={String(b.count)}
                hint={b.pct === null ? undefined : `${b.pct}% of open leads`}
              />
            ))}
          </div>

          <Card>
            <MonoLabel>Oldest open leads</MonoLabel>
            <p className="mt-1 text-xs text-text-muted">
              {aging.total} open. {aging.neverResponded} of them have never been answered.
            </p>
            {aging.stale.length === 0 ? (
              <div className="mt-3">
                <EmptyState title="No open leads." />
              </div>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[520px] border-collapse text-left text-sm">
                  <thead>
                    <tr>
                      <Th>Lead</Th>
                      <Th>Contact</Th>
                      <Th>Stage</Th>
                      <Th right>Age</Th>
                      <Th>Answered</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {aging.stale.map((lead) => (
                      <tr key={lead.id}>
                        <Td>{lead.title}</Td>
                        <Td>{lead.contactName ?? "-"}</Td>
                        <Td>{lead.stage}</Td>
                        <Td right>{lead.ageDays}d</Td>
                        <Td>
                          <StatusChip tone={lead.neverResponded ? "danger" : "muted"}>
                            {lead.neverResponded ? "Never" : "Yes"}
                          </StatusChip>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      ) : (
        <NotPermitted what="Lead aging" />
      )}
    </>
  );
}

/**
 * Durations are read at a glance next to a person's name, so they are written
 * the way a person would say them - "1h 12m", not "72 minutes" and not
 * "0.05 days".
 */
function fmtMinutes(minutes: number | null): string {
  if (minutes === null) return "-";
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 1440) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }
  const d = Math.floor(minutes / 1440);
  const h = Math.round((minutes % 1440) / 60);
  return h === 0 ? `${d}d` : `${d}d ${h}h`;
}

function fmtHours(hours: number): string {
  return fmtMinutes(hours * 60);
}

/** `null` is "no basis", which must not render as 0%. */
function fmtPct(value: number | null): string {
  return value === null ? "-" : `${value}%`;
}

function SectionHeading({ title, note }: { title: string; note?: string }) {
  return (
    <div className="mt-2">
      <h2 className="text-lg font-semibold text-text">{title}</h2>
      {note ? <p className="mt-0.5 text-xs text-text-muted">{note}</p> : null}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <MonoLabel>{label}</MonoLabel>
      <p className="mt-1 text-2xl font-semibold text-text tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs text-text-muted">{hint}</p> : null}
    </Card>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={`pb-2 text-xs font-medium uppercase tracking-wide text-text-muted ${
        right ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function Td({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <td className={`py-2 text-text ${right ? "text-right tabular-nums" : "text-left"}`}>
      {children}
    </td>
  );
}

/**
 * One report failing does not blank the page - a role that may not read one
 * still gets the others, the same degradation the main reports page uses.
 */
function NotPermitted({ what }: { what: string }) {
  return (
    <Card>
      <MonoLabel>{what} unavailable</MonoLabel>
      <p className="mt-2 text-sm text-text-muted">
        This report could not be loaded. It needs the org-wide `deal:view` permission - a role
        limited to its own records cannot be shown a floor-wide response time.
      </p>
    </Card>
  );
}
