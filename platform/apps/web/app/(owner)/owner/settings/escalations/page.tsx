import type { Metadata } from "next";
import type { CallEscalationSettingsView } from "@aura/shared";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { ownerTry, requireOwnerRoles } from "@/lib/owner-context";
import { EscalationRouting } from "./routing-editor";
import { EscalationSwitch } from "./settings-form";

export const metadata: Metadata = { title: "Escalation settings" };

/**
 * Settings → Calls & AI → Escalations (0151, Build docs/38).
 *
 * Owner and manager, matching the settings controller; anybody else is sent
 * home by `requireOwnerRoles` before a fetch, the console's usual courtesy.
 * The switch inside is narrower - owners only - and the API says so on the
 * payload (`canEditSwitch`) rather than this page guessing from the persona.
 *
 * Deliberately NOT hidden while the switch is off, unlike the queue: this is
 * where it is turned on.
 */
export default async function EscalationSettingsPage() {
  await requireOwnerRoles(["owner", "manager"]);

  const settings = await ownerTry<CallEscalationSettingsView>("/v1/owner/call-escalation-settings");

  if (!settings.ok) {
    return (
      <>
        <PageHeader title="Escalation settings" context="Settings" />
        <LoadFailure what="escalation settings" failure={settings} />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Escalation settings" context="Settings" />
      <EscalationSwitch initial={settings.data} />
      <EscalationRouting initial={settings.data} />
    </>
  );
}
