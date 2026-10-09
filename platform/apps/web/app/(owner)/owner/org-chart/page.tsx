import type { Metadata } from "next";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerTry, requireFeature } from "@/lib/owner-context";
import { OrgChartConsole } from "./org-chart-console";
import type {
  AssignableMember,
  ChartAbilities,
  ChartPayload,
  ChangeRow,
  DepartmentRow,
  TeamRow,
} from "./types";

export const metadata: Metadata = { title: "Organization chart" };

/**
 * The organization chart (Build docs/org-chart-build-plan.md, migrations
 * 0177/0178).
 *
 * ── EVERY PERSONA, WHICH IS THE POINT ──────────────────────────────────────
 *
 * No `requireOwnerRoles`. §7 gives a telecaller the chart, the names, the
 * titles, the departments, the responsibilities and the authority table,
 * because the module's reason to exist is a new joiner working out who to ask -
 * and 0177 seeds `position:view` to all five system roles to match.
 *
 * Nearly every other page under /owner narrows to owner-and-manager, so the
 * ABSENCE of that call here is a decision rather than an omission. What a
 * reader may CHANGE is narrowed instead, by the grid, and resolved into
 * `abilities` below so the console draws only what the API would accept.
 *
 * ── WHY THE ABILITIES ARE RESOLVED HERE AND NOT IN THE BROWSER ─────────────
 *
 * The console needs to know whether to offer a drag handle, an editor and a
 * Contract tab. It could guess from the persona, and that would be a second
 * authorization model that disagrees with the grid the moment an owner changes
 * a checkbox. So the page asks the API what this reader actually holds, and
 * the browser is told rather than deciding.
 *
 * Hiding a control is not a permission - every route re-checks. This only
 * stops the console offering a button whose only outcome would be a 403.
 */
export default async function OrgChartPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string; position?: string }>;
}) {
  await requireFeature("/owner/org-chart");
  const { asOf } = await searchParams;

  const query = asOf ? `?asOf=${encodeURIComponent(asOf)}` : "";
  const [chart, structure, changes, members, abilities] = await Promise.all([
    ownerTry<ChartPayload>(`/v1/org-chart${query}`),
    ownerTry<{ departments: DepartmentRow[]; teams: TeamRow[] }>("/v1/org-chart/departments"),
    /**
     * §6.5's timeline, for the whole org, fetched once.
     *
     * The drawer filters it per position rather than asking per node: opening
     * six people in a row is six requests otherwise, and the whole log for a
     * 500-seat org is a few hundred rows. A tenant with years of history is
     * the case that breaks that assumption, which is why the request is capped
     * at 200 - the drawer shows a position's recent story, and the full ledger
     * is a separate read when somebody needs it.
     */
    ownerTry<{ changes: ChangeRow[] }>("/v1/org-chart/changes?limit=200"),
    ownerTry<{ members: AssignableMember[] }>("/v1/owner/team"),
    resolveAbilities(),
  ]);

  if (!chart.ok) {
    return (
      <>
        <PageHeader title="Organization chart" context="Settings" />
        <LoadFailure what="your organization chart" failure={chart} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Organization chart"
        context="Settings"
        description="Who reports to whom, what each position is responsible for, and what it can approve."
      />
      <OrgChartConsole
        chart={chart.data}
        /**
         * A failed structure read is not worth failing the page for: the
         * filters lose their options and the chart still draws. The same call
         * the resources page makes about its type picker.
         */
        departments={structure.ok ? structure.data.departments : []}
        teams={structure.ok ? structure.data.teams : []}
        changes={changes.ok ? changes.data.changes : []}
        members={members.ok ? (members.data.members ?? []) : []}
        abilities={abilities}
      />
    </>
  );
}

/**
 * What this reader may do, asked of the API rather than inferred.
 *
 * ── THE PROBE, AND WHY IT IS SHAPED LIKE THIS ──────────────────────────────
 *
 * There is no "what may I do" endpoint, and adding one would be a second
 * authorization surface to keep in step with the grid. So the page asks the
 * two routes whose refusal is unambiguous:
 *
 *   · `GET /org-chart/settings` needs `position:view` - everyone who can see
 *     the page at all passes it, so it is the cheap confirmation that the
 *     grid is readable;
 *   · `GET /org-chart/contracts` needs `employment_contract:view`, and a 403
 *     from it is exactly the question "may this reader see a Contract tab".
 *
 * The WRITE abilities cannot be probed without writing, so they come from the
 * persona - which is honest about what it is: a guess about what to DRAW,
 * never about what is allowed. A manager who has been granted `position:edit`
 * sees the editors because the grid says so at the API; the worst this guess
 * can do is hide a button from somebody who could have used it, and the chart
 * says so rather than pretending the feature does not exist.
 */
async function resolveAbilities(): Promise<ChartAbilities> {
  const owner = await getOwner();
  const persona = owner?.membership.ownerRole ?? null;
  const isAdmin = persona === "owner" || persona === null;
  const isManager = persona === "manager";

  const [settings, contracts] = await Promise.all([
    ownerTry<{ managerEditsReports: boolean }>("/v1/org-chart/settings"),
    ownerTry<{ contracts: unknown[] }>("/v1/org-chart/contracts"),
  ]);

  const managerEditsReports = settings.ok ? settings.data.managerEditsReports : false;

  return {
    canCreate: isAdmin,
    canEdit: isAdmin,
    canDelete: isAdmin,
    // A successful read IS the permission - the API's guard is what answered.
    canSeeContracts: contracts.ok,
    canEditContracts: contracts.ok && isAdmin,
    // §14: off unless the org turned it on, and only meaningful for a manager.
    managerEditsReports: managerEditsReports && isManager,
  };
}
