import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { ownerNavLabel } from "@/lib/nav";
import { getOwner } from "@/lib/owner-context";
import { PerformanceTab } from "./performance-tab";
import { RolesTab } from "./roles-tab";
import { TeamTab } from "./team-tab";

/** "Staff" to an owner, "Team" to a manager - whatever the rail called it (nav.ts). */
async function sectionName(): Promise<string> {
  const owner = await getOwner();
  return owner ? ownerNavLabel("/owner/staff", owner.membership.ownerRole, "Staff") : "Staff";
}

export async function generateMetadata(): Promise<Metadata> {
  return { title: await sectionName() };
}

const TABS = [
  { key: "team", label: "Team" },
  { key: "roles", label: "Roles & permissions" },
  { key: "performance", label: "Performance" },
] as const;

type Tab = (typeof TABS)[number]["key"];

/**
 * Staff - the people who work this workspace, in three tabs.
 *
 * ── WHY THREE TABS AND NOT THREE PAGES ────────────────────────────────────
 *
 * They are three answers about one person. "Who is Priya, what may she do, and
 * how is she doing" is a single question a manager asks while looking at a
 * single row, and splitting it across three sidebar entries would mean holding
 * a name in your head while navigating between them.
 *
 * The tab lives in the URL rather than in component state so a link to the
 * scorecard is a link to the scorecard - which matters because that is the tab
 * people share.
 *
 * ── WHY /owner/team STILL EXISTS ──────────────────────────────────────────
 *
 * As a redirect, one directory over. Every bookmark, every link in an older
 * notification and the dashboard's own panel pointed there, and a 404 for a
 * page that was renamed is a worse outcome than one extra hop. The API stayed
 * at `/v1/owner/team` throughout - the table really is `memberships`, and
 * renaming a route to match a tab would have been churn with no reader.
 *
 * ── THE REDIRECT BELOW IS NOT THE SECURITY BOUNDARY ───────────────────────
 *
 * Every route behind these tabs carries `@RequireOwnerRole`, resolved from
 * `memberships` rather than from anything this tier sends. A telecaller who
 * follows a stale link is sent home rather than shown a permission they were
 * never told they lacked; remove this and they still read nothing.
 */
export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const owner = await getOwner();
  if (!owner) redirect("/dashboard");

  const role = owner.membership.ownerRole;
  if (role !== "owner" && role !== "manager") redirect("/owner");

  const { tab: tabParam } = await searchParams;
  const tab: Tab = TABS.some((t) => t.key === tabParam) ? (tabParam as Tab) : "team";

  return (
    <>
      <PageHeader title={ownerNavLabel("/owner/staff", role, "Staff")} context="Workspace" />

      <nav className="flex flex-wrap gap-1" aria-label="Sections">
        {TABS.map((t) => {
          const active = t.key === tab;
          return (
            <Link
              key={t.key}
              href={`/owner/staff?tab=${t.key}`}
              aria-current={active ? "page" : undefined}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                active
                  ? "border-border-strong bg-surface-hover font-medium text-text"
                  : "border-border text-text-muted hover:text-text"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>

      {tab === "team" ? <TeamTab role={role} selfUserId={owner.userId} /> : null}
      {tab === "roles" ? <RolesTab canEdit={role === "owner"} /> : null}
      {tab === "performance" ? <PerformanceTab /> : null}
    </>
  );
}
