import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { crmShadowReadEnabled } from "@/lib/crm-cutover";
import { ownerNavItemsFor, ownerSettingsGroupsFor } from "@/lib/nav";
import { getOwner } from "@/lib/owner-context";

export const metadata: Metadata = { title: "Settings" };

/**
 * Every set-up page, on one screen, grouped by the question it answers.
 *
 * The rail's Settings entry lands here. The pages behind it used to be sixteen
 * links spread over three rail headings, most of them named for how the code
 * thinks ("Lead Routing", "Call access", "Handsets"); a person had to know a
 * page existed, and what it was called, to find it. Here each one is a card
 * with a plain name and one line saying what it is for, so the page teaches
 * the settings instead of assuming them.
 *
 * Built from the reader's own `ownerNavItemsFor`, so it offers exactly the
 * settings the rail would - a telecaller sees their phone and their connected
 * apps, not the lead-routing rules. The groups and the one-line descriptions
 * live in nav.ts (OWNER_SETTINGS_GROUPS) beside the tabs they also drive.
 */
export default async function SettingsPage() {
  const owner = await getOwner();
  const groups = owner
    ? ownerSettingsGroupsFor(
        ownerNavItemsFor(
          owner.membership.ownerRole,
          crmShadowReadEnabled(),
          owner.membership.enabledModules.includes("crm"),
          owner.membership.enabledModules.includes("call_intel"),
          { modules: owner.membership.enabledModules, features: owner.membership.featureOverrides },
        ),
      )
    : [];

  return (
    <>
      <PageHeader title="Settings" context="Workspace" />
      {groups.map((group) => (
        <section key={group.key} aria-labelledby={`settings-${group.key}`} className="space-y-3">
          <h2 id={`settings-${group.key}`} className="text-sm font-semibold text-text">
            {group.label}
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {group.pages.map(({ item, blurb }) => {
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="flex h-full items-start gap-3 rounded-xl border border-border bg-surface p-4 transition-colors duration-150 ease-out hover:bg-surface-hover"
                  >
                    <Icon className="mt-0.5 h-5 w-5 shrink-0 text-text-muted" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-text">{item.label}</span>
                      <span className="mt-1 block text-xs text-text-muted">{blurb}</span>
                    </span>
                    <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-text-subtle" aria-hidden="true" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}
