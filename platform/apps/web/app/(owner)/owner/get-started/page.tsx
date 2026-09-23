import type { Metadata } from "next";
import type { SetupState } from "@aura/shared";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { accountPageRoles } from "@/lib/account-menu";
import { ownerTry, requireOwnerRoles } from "@/lib/owner-context";
import { GetStarted } from "./get-started-client";

export const metadata: Metadata = { title: "Get started" };

type GuideState = SetupState & { guideDismissedAt: string | null };

/**
 * Get started (doc 27 §7.2) - every setup step that applies to this
 * workspace, grouped, each with a measured tick.
 *
 * Not a nav item: the sidebar's "Finish your setup" widget is its entry point
 * while the guide is open, and after that it stays reachable from the setup
 * modal's "See all setup steps" and by URL. Owner and manager, the pair the
 * API's setup routes allow; everyone else goes home before anything loads.
 */
export default async function GetStartedPage() {
  const owner = await requireOwnerRoles(accountPageRoles("get_started"));
  const result = await ownerTry<{ setup: GuideState | null }>("/v1/owner/setup");

  return (
    <>
      <PageHeader title="Get started" context="Workspace" />
      {!result.ok ? (
        <LoadFailure what="your setup steps" failure={result} />
      ) : result.data.setup ? (
        <GetStarted
          setup={result.data.setup}
          isOwner={owner.membership.ownerRole === "owner"}
          dismissed={Boolean(result.data.setup.guideDismissedAt)}
        />
      ) : (
        <LoadFailure
          what="your setup steps"
          failure={{ ok: false, kind: "notfound", status: 404, message: "no workspace" }}
        />
      )}
    </>
  );
}
