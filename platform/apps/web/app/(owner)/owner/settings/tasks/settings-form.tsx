"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, ErrorBanner, useToast } from "@aura/ui";
import { useServerState } from "@/lib/use-server-state";
import { Toggle } from "../attendance/toggle";
import { setOwnerSelfTasksAction, type TaskSettingsView } from "./actions";

/**
 * "Let owners and managers give themselves tasks" (migration 0156).
 *
 * Off by default, which is the point: the owner console's task section is
 * where the floor's work is handed out, and an owner was being offered their
 * own name in the picker alongside everybody else's. The switch is the "button
 * for us to be able to create a task" - the ability is not taken away, it is
 * put behind something an owner can find.
 *
 * No confirmation on either direction, unlike the escalation switch next door.
 * Nothing is taken from anybody: tasks already assigned stay assigned and stay
 * answerable, and flipping it back costs one click.
 *
 * A manager sees it in the state it is in, disabled, with the line that says
 * why - `canEdit` comes from the API so this never guesses.
 */
export function OwnerSelfTasksSwitch({ initial }: { initial: TaskSettingsView }) {
  const toast = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useServerState(initial);

  const flip = (next: boolean) => {
    setError(null);
    startTransition(async () => {
      const result = await setOwnerSelfTasksAction(next);
      if (result.error) {
        setError(result.error);
        return;
      }
      setSettings((s) => result.settings ?? { ...s, ownerSelfTasks: next });
      toast(next ? "Owners can take their own tasks" : "Tasks are for the floor");
      // The "Assign to" list is server-fetched on the task pages.
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      <Card className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text">
              Let owners and managers take their own tasks
            </h3>
            <p className="mt-1 max-w-2xl text-sm text-text-muted">
              When this is off, the task section is for handing work to the floor: an owner or a
              manager is not offered their own name under &ldquo;Assign to&rdquo;. Turn it on if you
              want to keep your own follow-ups here alongside everybody else&rsquo;s.
            </p>
            <p className="mt-1 max-w-2xl text-sm text-text-muted">
              Either way, a telecaller can still hand a task up to you, and anything already
              assigned to you stays on your list.
            </p>
            {settings.canEdit ? null : (
              <p className="mt-1 text-sm text-text-muted">
                Only an owner of this workspace can change this.
              </p>
            )}
          </div>
          <Toggle
            on={settings.ownerSelfTasks}
            label="Let owners and managers take their own tasks"
            disabled={pending || !settings.canEdit}
            onChange={flip}
          />
        </div>
      </Card>
    </div>
  );
}
