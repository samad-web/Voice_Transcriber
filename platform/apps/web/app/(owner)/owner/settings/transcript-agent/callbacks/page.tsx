import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { CallbackPolicy } from "@aura/shared";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerTry } from "@/lib/owner-context";
import { CallbackWizard } from "./callback-wizard";

export const metadata: Metadata = { title: "Call-back rules" };

/**
 * §10A.6: Settings → Features → Transcript Agent → Callbacks.
 *
 * ── THE POLICY COMES FROM THE API, DEFAULTS AND ALL ─────────────────────
 *
 * `GET /callbacks/policy/current` returns the stored policy or, when nothing
 * has been saved, §18's defaults with `isDefault: true`. The console does not
 * carry its own copy of the defaults: they are what the resolvers and the
 * sweeps actually use, and a second set here would be the numbers an owner
 * reads while a different set decides when somebody's phone rings.
 *
 * ── WHY THIS PAGE IS NOT GATED ON THE FEATURE ITSELF ────────────────────
 *
 * It is gated on the MODULE and on being an owner, not on `transcript_agent`
 * being switched on. The order an owner works in is: read the rules, decide
 * they are right, then switch it on. A page that only opened once the feature
 * was live would make them turn it on to find out what it would do.
 */

interface PolicyResponse {
  policy: CallbackPolicy;
  timeZone: string;
  isDefault: boolean;
  rulesVersion: string;
}

export default async function CallbackRulesPage() {
  const owner = await getOwner();
  if (!owner?.membership) notFound();
  // §18: "who can change toggles: owner and admin only." A manager may read
  // the rules their floor runs on - the wizard's Save is what they lose.
  const persona = owner.membership.ownerRole;
  if (persona !== "owner" && persona !== "manager") notFound();
  if (!owner.membership.enabledModules.includes("call_intel")) notFound();

  const result = await ownerTry<PolicyResponse>("/v1/callbacks/policy/current");

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Call-back rules" context="Settings" />
        <LoadFailure failure={result} what="your call-back rules" />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Call-back rules"
        context="Settings"
        description="What happens when a customer asks to be rung back: when, who, how they are reminded, and who hears about it if it is missed."
      />
      <CallbackWizard
        initial={result.data.policy}
        timeZone={result.data.timeZone}
        isDefault={result.data.isDefault}
        canEdit={persona === "owner"}
      />
    </>
  );
}
