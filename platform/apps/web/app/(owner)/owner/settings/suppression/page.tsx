import type { Metadata } from "next";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { ownerTry, requireFeature, requireOwnerRoles } from "@/lib/owner-context";
import { SuppressionLists } from "./lists-panel";
import type { DncGrants, DncList } from "./actions";

export const metadata: Metadata = { title: "Do-not-call lists" };

/**
 * Settings → Calls & AI → Do-not-call lists (migration 0158, Build docs/39 §4.2).
 *
 * The registries a tenant must honour and the numbers they have decided for
 * themselves nobody here may ring. Both are lists of KEYS -
 * `sha256(phoneMatchDigits(n))` - so nothing on this page is a phone number and
 * there is nothing on it to reveal; what it shows is how many, from where, and
 * whether the list is still in force.
 *
 * Owner and manager, matching the sibling settings pages and the write grants:
 * `dnc:create` and `dnc:edit` are seeded to the three admin roles only (0158),
 * so a telecaller offered this page could read it and be refused every control
 * on it. `dnc:view` reaching everybody is for the dialer, which renders
 * "on a do-not-call list" as a block reason - not for this screen.
 *
 * Off means off, not merely hidden - `requireFeature` first, before a fetch.
 */
export default async function SuppressionSettingsPage() {
  await requireFeature("/owner/settings/suppression");
  await requireOwnerRoles(["owner", "manager"]);

  // `can` comes from the route rather than being inferred here. 0158 seeds
  // `dnc:view` to every role but `dnc:create`/`dnc:edit` to the admin roles
  // only, and both are regrantable per role on Team & permissions - so the
  // persona this page was gated on does not answer "may they change it".
  // Guessing would give somebody a Create button that 403s on press.
  const lists = await ownerTry<{ lists: DncList[]; can: DncGrants }>("/v1/dnc/lists");

  if (!lists.ok) {
    return (
      <>
        <PageHeader title="Do-not-call lists" context="Settings" />
        <LoadFailure what="do-not-call lists" failure={lists} />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Do-not-call lists" context="Settings" />
      <SuppressionLists
        initial={lists.data.lists}
        // An older API that predates the `can` block would omit it. Default
        // to able: this page is already behind owner/manager, and a silent
        // read-only render would look like a bug rather than a permission.
        can={lists.data.can ?? { create: true, edit: true }}
      />
    </>
  );
}
