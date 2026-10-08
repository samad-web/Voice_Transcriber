import type { Metadata } from "next";
import type { DialCampaignView, DialSettingsView } from "@aura/shared/dist/dialer";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerTry, requireFeature, requireOwnerRoles } from "@/lib/owner-context";
import { loadSavedViews } from "../saved-views/load";
import { DialerConsole } from "./dialer-console";

export const metadata: Metadata = { title: "Dialer" };

/**
 * The dialer console (Build docs/40 §B1, migrations 0159-0162).
 *
 * ── WHY THIS PAGE DID NOT EXIST FOR TWO WEEKS ──────────────────────────────
 *
 * Doc 39's P1 built the whole dialer and stopped at the API: the queue, the
 * 120s lease, the claim protocol, the eight block reasons and 86 passing tests,
 * with no screen anywhere. An audit found it (doc 40, F3) along with the thing
 * that made it worse - `dialer_max_calls_per_person_per_day` had no route
 * either, so the per-person ceiling was NULL for every tenant that has ever
 * existed and could not be set by anybody.
 *
 * ── OWNER AND MANAGER ──────────────────────────────────────────────────────
 *
 * Narrower than the grants, on purpose. `dial_campaign:view` reaches every
 * console role including `viewer` (a campaign is a name, a source and some
 * counts - nothing in those three tables is a phone number), and
 * `dial_campaign:edit` reaches `workspace_member` so an agent can SKIP the
 * record in front of them. But an agent works a queue on a HANDSET; this page
 * is where the queue is chosen, built and started, which is a supervisor's job.
 * A telecaller offered the entry would reach a screen whose Create and Activate
 * the API refuses.
 *
 * `canEdit` still comes from the route rather than being inferred from the
 * persona, because `dial_campaign:create` is regrantable per role on Team &
 * permissions - so the persona this page is gated on does not answer "may they
 * change the dial policy".
 *
 * Off means off, not merely hidden: `requireFeature` runs before any fetch, and
 * `dialer` defaults OFF with `suppression` as a hard requirement (doc 40 §A1),
 * so a workspace that switched do-not-call lists off finds this blocked rather
 * than dialling with a list it cannot maintain.
 */
export default async function DialerPage() {
  await requireFeature("/owner/dialer");
  await requireOwnerRoles(["owner", "manager"]);

  // Two reads in parallel. They are independent - the policy is org-wide and
  // the campaigns are rows - and this console is one navigation away from a
  // database ~125ms off, so sequencing them would cost a quarter second for
  // nothing.
  const [campaigns, settings, savedViews, owner] = await Promise.all([
    ownerTry<{ campaigns: DialCampaignView[] }>("/v1/dialer/campaigns"),
    ownerTry<{ settings: DialSettingsView }>("/v1/dialer/settings"),
    // The source picker's options. `leads`, because a dial campaign rings
    // people and the lead list is where a supervisor has already described the
    // group they mean ("my hot Chennai leads"). A failure here degrades to
    // "everyone in this workspace" rather than failing the page.
    loadSavedViews("leads"),
    getOwner(),
  ]);

  if (!campaigns.ok) {
    return (
      <>
        <PageHeader title="Dialer" context="Conversations" />
        <LoadFailure what="your call campaigns" failure={campaigns} />
      </>
    );
  }
  if (!settings.ok) {
    // Deliberately a hard failure rather than rendering the campaigns with the
    // policy card missing. Every number on this page is read against the
    // calling window and the ceiling; a campaign list shown beside a blank
    // policy invites somebody to set `maxAttempts: 5` with no idea whether a
    // cross-campaign ceiling is in force.
    return (
      <>
        <PageHeader title="Dialer" context="Conversations" />
        <LoadFailure what="your dial settings" failure={settings} />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Dialer" context="Conversations" />
      <DialerConsole
        campaigns={campaigns.data.campaigns}
        settings={settings.data.settings}
        savedViews={savedViews}
        workspaceId={owner?.membership.workspaceId ?? null}
      />
    </>
  );
}
