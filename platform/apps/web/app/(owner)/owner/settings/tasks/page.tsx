import type { Metadata } from "next";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { ownerTry, requireOwnerRoles } from "@/lib/owner-context";
import { OwnerSelfTasksSwitch } from "./settings-form";
import type { TaskSettingsView } from "./actions";

export const metadata: Metadata = { title: "Task settings" };

/**
 * Settings → Team → Tasks (migration 0156).
 *
 * Owner and manager, matching the settings controller; anybody else is sent
 * home by `requireOwnerRoles` before a fetch, the console's usual courtesy.
 * The switch itself is narrower - owners only - and the API says so on the
 * payload (`canEdit`) rather than this page guessing from the persona.
 */
export default async function TaskSettingsPage() {
  await requireOwnerRoles(["owner", "manager"]);

  const settings = await ownerTry<TaskSettingsView>("/v1/owner/task-settings");

  if (!settings.ok) {
    return (
      <>
        <PageHeader title="Task settings" context="Settings" />
        <LoadFailure what="task settings" failure={settings} />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Task settings" context="Settings" />
      <OwnerSelfTasksSwitch initial={settings.data} />
    </>
  );
}
