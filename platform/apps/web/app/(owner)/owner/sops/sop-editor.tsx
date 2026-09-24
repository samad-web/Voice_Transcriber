"use client";

import { useState, useTransition } from "react";
import { useDraftState } from "@/lib/use-server-state";
import type { SopStep } from "@aura/shared";
import { Button, Card, Input, Label, MonoLabel, StatusChip, useAlert } from "@aura/ui";
import { deactivateSopAction, saveSopAction } from "./actions";

interface ActiveSop {
  id: string;
  version: number;
  name: string;
  steps: SopStep[];
}

/** Derive a stable key from a label, for a step the user just added. */
function keyFor(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^([0-9])/, "s$1")
      .slice(0, 60) || "step";
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}_${n++}`;
  return key;
}

/**
 * Edit the call procedure.
 *
 * ── WHY THE KEY IS NOT EDITABLE ─────────────────────────────────────────────
 *
 * A step's `key` is what every past verdict is stored against
 * (`call_sop_results.step_results`). Renaming a LABEL is free and re-renders
 * old reviews under the new wording; renaming a KEY orphans every score that
 * step ever produced. So the label is a text field and the key is derived once,
 * on creation, and then left alone - there is no interface here for changing
 * it, deliberately.
 *
 * Removing a step is allowed and is the same trade made visible: the score
 * stops counting it, and old reviews still show it because they carry their own
 * version's step list.
 */
export function SopEditor({
  active,
  maxSteps,
  defaultSteps,
  canDeactivate,
}: {
  active: ActiveSop | null;
  maxSteps: number;
  defaultSteps: SopStep[];
  canDeactivate: boolean;
}) {
  const [name, setName] = useDraftState(active?.name ?? "Outbound sales call");
  const [steps, setSteps] = useState<SopStep[]>(active?.steps ?? []);
  const [pending, startTransition] = useTransition();
  const alert = useAlert();

  const update = (i: number, patch: Partial<SopStep>) =>
    setSteps((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const remove = (i: number) => setSteps((prev) => prev.filter((_, j) => j !== i));

  const add = () =>
    setSteps((prev) =>
      prev.length >= maxSteps
        ? prev
        : [
            ...prev,
            {
              key: keyFor("new step", new Set(prev.map((s) => s.key))),
              label: "",
              description: "",
              required: true,
            },
          ],
    );

  const save = () => {
    // Keys are only minted for steps that never had one - an existing step
    // keeps the key its past verdicts are filed under, even after a relabel.
    const taken = new Set<string>();
    const prepared = steps.map((s) => {
      const key = s.key && !s.key.startsWith("new_step") ? s.key : keyFor(s.label, taken);
      taken.add(key);
      return { ...s, key, label: s.label.trim(), description: s.description.trim() };
    });

    startTransition(async () => {
      const res = await saveSopAction({ sopId: active?.id, name, steps: prepared });
      if (res.error) {
        await alert({ title: "Couldn't save the procedure", body: res.error, tone: "danger" });
        return;
      }
      setSteps(prepared);
      await alert({
        title: active ? `Saved as version ${active.version + 1}` : "Procedure saved",
        // Says what happens NEXT, because the thing people get wrong here is
        // expecting yesterday's calls to be re-scored. They cannot be - the
        // audio would have to be transcribed a second time.
        body: "Calls from now on are scored against it. Earlier calls keep the score they already had.",
      });
    });
  };

  const stopScoring = () => {
    startTransition(async () => {
      const res = await deactivateSopAction();
      if (res.error) {
        await alert({ title: "Couldn't stop scoring", body: res.error, tone: "danger" });
        return;
      }
      await alert({
        title: "Scoring is off for new calls",
        body: "Existing reviews are unchanged - they record what was judged at the time.",
      });
    });
  };

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <MonoLabel>Steps</MonoLabel>
        <div className="flex items-center gap-2">
          {active ? <StatusChip tone="solid">Active · v{active.version}</StatusChip> : null}
          <span className="text-xs text-text-muted">
            {steps.length} of {maxSteps}
          </span>
        </div>
      </div>

      <div className="max-w-md">
        <Label htmlFor="sop-name">Name</Label>
        <Input
          id="sop-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Outbound sales call"
        />
      </div>

      {steps.length === 0 ? (
        <div className="space-y-3 rounded-md border border-border bg-bg-subtle p-4">
          <p className="max-w-prose text-sm leading-relaxed text-text-muted">
            No procedure yet. Start from a seven-step outbound sales script and edit it — every step
            is a suggestion, not a rule you have to keep.
          </p>
          <Button type="button" onClick={() => setSteps(defaultSteps)}>
            Start from the default
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {steps.map((s, i) => (
            <div key={s.key} className="space-y-2 rounded-md border border-border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-2">
                  <Input
                    aria-label={`Step ${i + 1} name`}
                    value={s.label}
                    onChange={(e) => update(i, { label: e.target.value })}
                    placeholder="Introduced themselves and the company"
                  />
                  <textarea
                    aria-label={`Step ${i + 1} instruction`}
                    value={s.description}
                    onChange={(e) => update(i, { description: e.target.value })}
                    rows={2}
                    placeholder="What has to be observable in the transcript for this to count."
                    className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-to"
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => remove(i)}
                  aria-label={`Remove step ${i + 1}`}
                >
                  Remove
                </Button>
              </div>
              <label className="flex items-center gap-2 text-xs text-text-muted">
                <input
                  type="checkbox"
                  checked={s.required}
                  onChange={(e) => update(i, { required: e.target.checked })}
                />
                Counts towards the score. Turn this off for a step that only applies to some calls.
              </label>
            </div>
          ))}

          <Button
            type="button"
            variant="secondary"
            onClick={add}
            disabled={steps.length >= maxSteps}
          >
            Add a step
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Button type="button" onClick={save} disabled={pending || steps.length === 0}>
          {active ? "Save as a new version" : "Save and start scoring"}
        </Button>
        {canDeactivate ? (
          <Button type="button" variant="ghost" onClick={stopScoring} disabled={pending}>
            Stop scoring new calls
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
