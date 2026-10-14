import { ORG_MODULES, type AdoptionState, type OrgModule } from "@aura/shared";
import { Card, MonoLabel, StatCard, StatusChip } from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import { OperatorScopeNote } from "@/components/operator-scope-note";
import { PageHeader } from "@/components/page-header";
import { operatorGate } from "@/lib/operator-gate";
import { apiGetAdmin } from "@/lib/server-api";

/**
 * MODULE ADOPTION: WHAT WAS SOLD AGAINST WHAT IS USED (doc 49 P11).
 *
 * ── WHY THIS SCREEN EXISTS, AND WHY IT IS UNCOMFORTABLE ─────────────────────
 *
 * The operator console has only ever shown `enabled_modules` - a provisioning
 * decision, made once, by us. On 2026-10-14 that read: four tenants, five
 * distinct modules switched on between them, against 56 API modules and 193
 * migrations. Attendance, org chart, dialer, number vault, agent studio, report
 * builder, the export engine, escalations and offboarding had no production
 * user at all.
 *
 * Doc 49's own words: "complete" is doing two jobs in this project and they
 * have drifted apart - complete in the repo (written, typechecked, tested,
 * migrated) and complete in the world (a real user did a real job with it and
 * the result was right). It predicts this screen will be uncomfortable reading
 * and says that is precisely why it is worth having.
 *
 * ── WHAT IT IS CAREFUL ABOUT ────────────────────────────────────────────────
 *
 * Every date carries the EVIDENCE that produced it, because a cell reading
 * "never used" is a claim, and a claim whose method is invisible gets argued
 * with instead of acted on. Where the measurement is weaker than it looks, the
 * caveat is rendered too - `call_intel` counts somebody pressing play rather
 * than counting transcripts, because transcripts are written for every Aura
 * tenant whether or not a single person opens one, and counting those would
 * report full adoption for a module nobody has looked at.
 *
 * ── THE ROW THAT MATTERS MOST ───────────────────────────────────────────────
 *
 * `ungated` - used while NOT enabled. It should be impossible. If it appears,
 * it is either history from before the module was switched off, or a gate that
 * is not gating, and the second is a security finding rather than a reporting
 * curiosity. It is therefore the only state rendered in the error tone.
 */

interface AdoptionRow {
  module: OrgModule;
  enabled: boolean;
  lastUsedAt: string | null;
  usedInWindow: boolean;
  usesInWindow: number;
  state: AdoptionState;
}

interface AdoptionResponse {
  windowDays: number;
  /**
   * Doc 49 P13b. An adoption table is a book of business read sideways, so it
   * is exactly as scoped as the client roster - and a scoped one has to say so,
   * or "Modules sold: 5 across 4 tenants" reads as a statement about the
   * platform when it is a statement about one operator's clients.
   */
  scope?: string | null;
  scopeNote?: string | null;
  probes: Array<{ module: OrgModule; evidence: string; caveat: string | null }>;
  tenants: Array<{
    orgId: string;
    orgName: string;
    status: string;
    modules: AdoptionRow[];
  }>;
}

/**
 * Colour, under the console's one rule: red means MISSED CALL and nothing else
 * (packages/ui/src/state.tsx, enforced by console-palette.test.ts). So the one
 * state worth alarming about takes the ERROR orange, and everything else is
 * grey - a dormant module is information, not an incident.
 */
const STATE_LABEL: Record<AdoptionState, { text: string; tone: "danger" | "outline" | "muted" }> = {
  adopted: { text: "in use", tone: "outline" },
  dormant: { text: "dormant", tone: "muted" },
  never_used: { text: "never used", tone: "muted" },
  ungated: { text: "USED WHILE OFF", tone: "danger" },
  not_sold: { text: "-", tone: "outline" },
};

export default async function AdoptionPage() {
  const blocked = await operatorGate();
  if (blocked) return blocked;

  const data = await apiGetAdmin<AdoptionResponse>("/v1/admin/module-adoption");

  if (!data) {
    return (
      <>
        <PageHeader title="Module adoption" context="Platform" />
        <Card>
          <MonoLabel>API offline</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            Start the API with <code>pnpm --filter @aura/api dev</code>.
          </p>
        </Card>
      </>
    );
  }

  const modules = ORG_MODULES;
  const rows = data.tenants;

  // The four numbers that make the point before anybody reads the table.
  const pairs = rows.flatMap((t) => t.modules);
  const sold = pairs.filter((m) => m.enabled);
  const adopted = sold.filter((m) => m.state === "adopted");
  const neverUsed = sold.filter((m) => m.state === "never_used");
  const ungated = pairs.filter((m) => m.state === "ungated");

  return (
    <>
      {/*
        `context` is NOT decorative: `console-loading.test.ts` compares the
        eyebrow a page renders against the one its nav item promises, so a
        page that omits it reads as "Workspace" and fails parity. The guard is
        right to - an eyebrow that disagrees with the rail is a page that looks
        like it belongs somewhere else.
      */}
      <PageHeader
        title="Module adoption"
        context="Platform"
        // A LITERAL, not interpolated from `data.windowDays`, and that is a
        // deliberate concession to `console-loading.test.ts`: it compares the
        // loader's header with the page's and can only read literals, so an
        // interpolated description means the loader either omits it (and the
        // heading jumps when the real page arrives) or states something the
        // guard cannot verify. The window is pinned at 30 by
        // `module-adoption.test.ts`, so the two cannot drift silently.
        description="What was switched on, against what has been used in the last 30 days."
      />

      {/* Before the totals, not after: every number below is computed over the
          rows this operator can see, so the qualification has to arrive first
          or it is a correction rather than a caption. */}
      <OperatorScopeNote scope={data.scope} note={data.scopeNote} subject="clients" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Modules sold"
          value={sold.length}
          context={`Across ${rows.length} tenant${rows.length === 1 ? "" : "s"}`}
        />
        <StatCard
          label="In use"
          value={adopted.length}
          context={
            sold.length > 0
              ? `${Math.round((adopted.length / sold.length) * 100)}% of what is sold`
              : "nothing sold yet"
          }
        />
        <StatCard
          label="Never opened"
          value={neverUsed.length}
          context="Sold and used zero times, ever"
          // Orange past zero. Never red: red is a missed call in this console.
          state={neverUsed.length > 0 ? "error" : undefined}
        />
        <StatCard
          label="Used while off"
          value={ungated.length}
          context={ungated.length > 0 ? "A gate may not be gating" : "As it should be"}
          state={ungated.length > 0 ? "error" : undefined}
        />
      </div>

      {/* ── The grid ───────────────────────────────────────────────────────── */}
      <Card className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-2 py-2 font-sans text-xs font-semibold tracking-wide text-text-muted uppercase">
                Client
              </th>
              {modules.map((m) => (
                <th
                  key={m.id}
                  className="px-2 py-2 font-sans text-xs font-semibold tracking-wide text-text-muted uppercase"
                >
                  {m.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((tenant) => (
              <tr key={tenant.orgId} className="border-b border-border last:border-0">
                <td className="px-2 py-2.5 align-top">
                  <span className="text-sm font-semibold text-text">{tenant.orgName}</span>
                  {tenant.status !== "active" ? (
                    <StatusChip tone="muted">{tenant.status}</StatusChip>
                  ) : null}
                </td>
                {modules.map((spec) => {
                  const cell = tenant.modules.find((m) => m.module === spec.id);
                  const state = cell?.state ?? "not_sold";
                  const label = STATE_LABEL[state];
                  return (
                    <td key={spec.id} className="px-2 py-2.5 align-top">
                      {state === "not_sold" ? (
                        <span className="text-xs text-text-muted">-</span>
                      ) : (
                        <div className="space-y-0.5">
                          <StatusChip tone={label.tone}>{label.text}</StatusChip>
                          {cell?.lastUsedAt ? (
                            <span className="block font-sans text-xs text-text-muted">
                              <LocalTime iso={cell.lastUsedAt} />
                              {cell.usesInWindow > 0 ? ` · ${cell.usesInWindow}×` : ""}
                            </span>
                          ) : null}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/*
        ── HOW EACH COLUMN WAS MEASURED ───────────────────────────────────────
        Rendered, not buried in a tooltip. "Never used" is a strong claim about
        a customer, and the first question anybody sensible asks is "measured
        how?". Answering it on the same screen is what makes the table
        actionable rather than arguable.
      */}
      <Card className="mt-4">
        <MonoLabel>What counts as used</MonoLabel>
        <dl className="mt-2 space-y-2">
          {data.probes.map((probe) => {
            const spec = modules.find((m) => m.id === probe.module);
            return (
              <div key={probe.module} className="font-sans text-xs">
                <dt className="font-semibold text-text">{spec?.label ?? probe.module}</dt>
                <dd className="text-text-muted">
                  {probe.evidence}
                  {probe.caveat ? (
                    <span className="block text-text-muted italic">{probe.caveat}</span>
                  ) : null}
                </dd>
              </div>
            );
          })}
        </dl>
      </Card>

      <Card className="mt-4">
        <MonoLabel>Why this screen</MonoLabel>
        <p className="mt-2 font-sans text-sm text-text-muted">
          A module sold and never opened is either churn in progress or an onboarding that skipped
          it, and both are worth a conversation that nobody can start without the number. A feature
          is not finished when it ships; it is finished when a production tenant has used it and the
          result was right.
        </p>
      </Card>
    </>
  );
}
