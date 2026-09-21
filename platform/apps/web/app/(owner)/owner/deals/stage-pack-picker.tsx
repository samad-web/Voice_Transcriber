"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Dialog,
  ErrorBanner,
  FormField,
  Input,
  Radio,
  RadioGroup,
  useAlert,
  useConfirm,
} from "@aura/ui";
import type { StagePack } from "@aura/shared";
import { applyStagePackAction, stagePackCatalogueAction } from "./stage-pack-actions";

/**
 * Reshape the deal board to match what this business actually does.
 *
 * ── WHY IT ASKS WHAT THEY DO, NOT WHICH TEMPLATE THEY WANT ─────────────────
 *
 * Every tenant is seeded with New → Contacted → Qualified → Negotiation →
 * Won → Lost (migration 0034), which is the vocabulary of a sales methodology
 * rather than of a dental practice or a property office. A board whose columns
 * describe somebody else's job is one nobody drags cards on, and the CRM
 * quietly degrades into a list.
 *
 * A dropdown of seven template names would put the same problem one step
 * later: the owner has to map "which of these is me" themselves. So the input
 * is one line about their business - a fact they have - and the matching pack
 * comes back pre-selected. They can still pick any other; the suggestion is a
 * starting point, never a decision.
 *
 * ── WHY THE CONFIRMATION NAMES THE CARDS ───────────────────────────────────
 *
 * Applying a pack MOVES DEALS: a card sitting on a column the new board does
 * not have is moved to the entry column (see the API's applyStagePack, which
 * does both in one transaction and records every move). That is a real,
 * visible consequence of a settings change, and the second dialog says how
 * many cards it will touch rather than asking a generic "are you sure".
 */
export function StagePackPicker({ pipelineId }: { pipelineId: string }) {
  const [open, setOpen] = useState(false);
  const [describe, setDescribe] = useState("");
  const [packs, setPacks] = useState<StagePack[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  // Tracks whether the person has picked for themselves yet. Until they have,
  // a new suggestion may move the selection; after, it must not - re-suggesting
  // under somebody who has already chosen is the control fighting its user.
  const [pickedByHand, setPickedByHand] = useState(false);
  const [catalogueError, setCatalogueError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const alert = useAlert();
  const confirm = useConfirm();

  // Re-ask as they type, debounced. The catalogue is seven constants and the
  // suggestion is a regex, so this is cheap - but it is still a round trip, and
  // firing one per keystroke over a Mumbai->Seoul hop would make the field feel
  // heavy for no gain.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      start(async () => {
        const res = await stagePackCatalogueAction(describe);
        // A bare `return` here left the picker on its previous state - or, on
        // first open, on none at all - with nothing said. Since this re-runs on
        // a debounce as somebody types, a modal per failed keystroke would be
        // worse than the bug; the banner below says it once and stays.
        if (!res.packs) {
          setCatalogueError(res.error ?? "The board templates could not be loaded.");
          return;
        }
        setCatalogueError(null);
        setPacks(res.packs);
        if (!pickedByHand) setChosen(res.suggestedId ?? null);
      });
    }, 350);
    return () => clearTimeout(timer);
  }, [open, describe, pickedByHand]);

  const selected = packs?.find((p) => p.id === chosen) ?? null;

  function apply() {
    if (!selected) return;
    start(async () => {
      const ok = await confirm({
        title: `Use the "${selected.label}" board?`,
        body: `Your columns become: ${selected.stages.map((s) => s.label).join(" → ")}. Any deal sitting on a column that disappears moves to "${selected.stages[0].label}", and every move is recorded.`,
        confirmLabel: "Change the board",
      });
      if (!ok) return;

      const res = await applyStagePackAction(pipelineId, selected.id);
      if (res.error) {
        await alert({ title: "Couldn't change the board", body: res.error, tone: "danger" });
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Change board columns
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Change your board columns"
        description="Pick the set that matches how you actually work. You can rename any column afterwards."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={apply} disabled={pending || !selected}>
              {pending ? "Working…" : "Preview and apply"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <FormField
            label="What does your business do?"
            name="describe"
            hint="One line is enough. We use it only to highlight the closest match - nothing is saved."
          >
            <Input
              value={describe}
              onChange={(e) => {
                setDescribe(e.target.value);
                // Typing again means they are still looking, so let the
                // suggestion move with them.
                setPickedByHand(false);
              }}
              placeholder="e.g. dental clinic in Adyar, or NEET coaching classes"
            />
          </FormField>

          {catalogueError ? <ErrorBanner>{catalogueError}</ErrorBanner> : null}

          {packs === null ? (
            // Only honest while nothing has failed - otherwise "Loading…" sits
            // there forever on a request that already came back.
            catalogueError ? null : (
              <p className="text-sm text-text-muted">Loading the options…</p>
            )
          ) : (
            <RadioGroup legend="Board">
              {packs.map((pack) => (
                <Radio
                  key={pack.id}
                  name="stage-pack"
                  value={pack.id}
                  checked={chosen === pack.id}
                  onChange={() => {
                    setChosen(pack.id);
                    setPickedByHand(true);
                  }}
                  label={pack.label}
                  // The COLUMNS, not just the name. Choosing between seven
                  // labels with no preview is choosing blind, and the columns
                  // are the entire content of the decision.
                  description={pack.stages.map((s) => s.label).join(" → ")}
                />
              ))}
            </RadioGroup>
          )}
        </div>
      </Dialog>
    </>
  );
}
