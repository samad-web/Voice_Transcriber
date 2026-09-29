import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { operatorGate } from "@/lib/operator-gate";
import { loadOrg } from "../instance-data";
import { KeysTab } from "./keys-tab";
import { RolesTab } from "./roles-tab";
import { TeamTab } from "./team-tab";

export const metadata: Metadata = { title: "Client Configuration - Aura" };

const TABS = [
  { key: "team", label: "Team" },
  { key: "roles", label: "Roles & permissions" },
  { key: "keys", label: "API keys" },
] as const;

type Tab = (typeof TABS)[number]["key"];

/**
 * One client's team, roles and API keys - in one place, per client.
 *
 * ── WHY THESE THREE STOPPED BEING TOP-LEVEL PAGES ───────────────────────────
 *
 * They were three entries in the operator rail, filed under a section called
 * "Access", beside Superadmins. That filing said they were PLATFORM entities,
 * and every one of them is the opposite: `memberships`, `roles` and `api_keys`
 * all carry an `org_id`, all live behind RLS, and all three pages already
 * rendered a `<TenantSwitcher>` because there was never a platform-wide answer
 * to show. The nav and the data disagreed, and the nav is what people read - so
 * "whose roles am I editing?" was a question you answered by noticing a row of
 * pills halfway down the page.
 *
 * The first fix merged them into one page under Clients, still with a switcher.
 * Doc 34 Part B finished it: the tenant is a PATH SEGMENT now, so the question
 * is answered by the URL and by the instance header above this page, and the
 * switcher is gone entirely. A page whose subject is one client should not
 * carry a control for being about a different one.
 *
 * ── AND WHY ONE PAGE RATHER THAN THREE UNDER A NEW HEADING ──────────────────
 *
 * The three are one job. Adding somebody to a client's team means picking the
 * role they get; auditing what a client can reach means reading their people
 * AND their keys. Split across three rail entries, each of those tasks began by
 * navigating with a client id held in your head - which is exactly the trap
 * `(owner)/owner/staff` was built to remove on the customer side, by merging
 * that console's Team and Roles pages into tabs. This is the same move on the
 * provider side, and it deliberately copies that page's shape: tabs in the URL,
 * one server component per tab, each fetching only its own data.
 *
 * ── THE TAB IS IN THE URL ───────────────────────────────────────────────────
 *
 * So a link to a client's keys is a link to their keys, and so the three old
 * routes have somewhere exact to redirect to (see ../api-keys/page.tsx). It
 * also means switching tab re-runs only the active tab's fetch instead of all
 * five this page would otherwise issue at once.
 *
 * ── THIS PAGE IS NOT THE SECURITY BOUNDARY ──────────────────────────────────
 *
 * `operatorGate()` gates the render; every write behind these tabs is a Server
 * Action that calls `requireOperator()` as its first statement, because a
 * Server Action is its own POST endpoint and never runs this function. See
 * lib/operator-guard.ts. The API side is `@RequireOrgRole("org_admin")` on all
 * four controllers (members, workspaces, roles, apikeys).
 */
export default async function InstanceAccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const blocked = await operatorGate();
  if (blocked) return blocked;

  const { id: orgId } = await params;
  const { tab: tabParam } = await searchParams;
  const org = await loadOrg(orgId);
  const tab: Tab = TABS.some((t) => t.key === tabParam) ? (tabParam as Tab) : "team";

  return (
    <>
      <PageHeader title="Access" context={org.name} />

      <p className="max-w-prose text-sm leading-relaxed text-text-muted">
        Everything on this page belongs to{" "}
        <strong className="font-medium text-text">{org.name}</strong> -
        their people, the roles those people hold, and the keys their integrations authenticate
        with. Nothing here is shared with another client.
      </p>

      <nav className="flex flex-wrap gap-1" aria-label="Configuration sections">
        {TABS.map((t) => {
          const active = t.key === tab;
          return (
            <Link
              key={t.key}
              href={`/instances/${orgId}/access?tab=${t.key}`}
              aria-current={active ? "page" : undefined}
              className={`rounded-md border px-3 py-1.5 text-sm transition-colors duration-150 ease-out ${
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

      {tab === "team" ? <TeamTab orgId={orgId} /> : null}
      {tab === "roles" ? <RolesTab orgId={orgId} /> : null}
      {tab === "keys" ? <KeysTab orgId={orgId} /> : null}
    </>
  );
}
