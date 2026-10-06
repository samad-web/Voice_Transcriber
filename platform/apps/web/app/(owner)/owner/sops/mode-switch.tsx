"use client";

import { useTransition } from "react";
import { Check } from "lucide-react";
import { SCRIPT_ADHERENCE_MODES, type ScriptAdherenceMode } from "@aura/shared";
import { Card, MonoLabel, useAlert, useToast } from "@aura/ui";
import { setAdherenceModeAction } from "./actions";

/**
 * The switch the owner asked for: score calls with AI, or against the script
 * the owner or manager wrote (migration 0155).
 *
 * ── TWO BUTTONS, NOT A TOGGLE ───────────────────────────────────────────────
 *
 * A toggle would have to be labelled for one of the two states ("AI scoring:
 * off"), which says nothing about what is happening instead - and what is
 * happening instead is the whole decision. So both choices are on screen with
 * their consequence under them, and the one in force is marked. It is the
 * radio-group idea drawn as cards, because the blurbs are a sentence each and
 * a <Radio> row would push them off the line.
 *
 * Real buttons rather than inputs: picking one is a write, not a form field,
 * and there is no Save - the same immediacy the Features board has.
 */
export function AdherenceModeSwitch({
  mode,
  hasChecklist,
}: {
  mode: ScriptAdherenceMode;
  /** Whether a checklist is activated - 'sop' is refused without one. */
  hasChecklist: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const toast = useToast();

  const choose = (next: ScriptAdherenceMode) => {
    if (next === mode) return;
    startTransition(async () => {
      const result = await setAdherenceModeAction(next);
      if (result.error) {
        await alert({ title: "Couldn't change the scoring", body: result.error, tone: "danger" });
        return;
      }
      toast(next === "sop" ? "Scoring against your checklist" : "Scoring with AI");
    });
  };

  return (
    <Card className="space-y-3">
      <MonoLabel>How calls are scored</MonoLabel>
      <p className="max-w-prose text-sm leading-relaxed text-text-muted">
        Pick one. Both measures exist, they disagree with each other routinely, and a number nobody
        knows the source of is a number nobody acts on — so this is the one that counts, everywhere
        the console reports script adherence.
      </p>
      <ul className="grid gap-3 sm:grid-cols-2">
        {SCRIPT_ADHERENCE_MODES.map((option) => {
          const on = option.value === mode;
          // Offered even with no checklist written: the refusal says what to do
          // ("write and save your checklist first"), which teaches more than a
          // disabled button that explains nothing. The one exception is while a
          // write is in flight.
          const unwritable = option.value === "sop" && !hasChecklist;
          return (
            <li key={option.value}>
              <button
                type="button"
                aria-pressed={on}
                disabled={pending}
                onClick={() => choose(option.value)}
                className={`flex h-full w-full flex-col items-start gap-1.5 rounded-xl border p-4 text-left transition-colors duration-150 ease-out ${
                  on ? "border-border-strong bg-bg-subtle" : "border-border bg-surface hover:bg-surface-hover"
                } ${pending ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="text-sm font-medium text-text">{option.label}</span>
                  {on ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-text-muted">
                      <Check aria-hidden="true" className="h-3.5 w-3.5" />
                      In use
                    </span>
                  ) : null}
                </span>
                <span className="text-xs leading-relaxed text-text-muted">{option.blurb}</span>
                {unwritable ? (
                  <span className="text-xs text-text-subtle">
                    Write your steps below and save them first.
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      {mode === "ai" ? (
        <p className="max-w-prose text-xs leading-relaxed text-text-muted">
          Your checklist below is not being used while AI scoring is on. Saving it switches over.
        </p>
      ) : null}
    </Card>
  );
}
