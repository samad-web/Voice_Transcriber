"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Settings2 } from "lucide-react";
import { Button, Dialog, ErrorBanner } from "@aura/ui";
import {
  StageListEditor,
  draftsFromStages,
  stagesFromDrafts,
  type StageDraft,
} from "@/components/stage-list-editor";
import type { Stage } from "../types";
import { saveStagesAction, stageCountsAction } from "./board-actions";

/**
 * "Manage board": rename, reorder, add and remove the columns of the board on
 * screen.
 *
 * ── WHAT IT WILL NOT DO, AND WHY ────────────────────────────────────────────
 *
 * It saves with a plain PATCH of the stage list, and that route does not move
 * cards. So every edit here is one that cannot strand a deal:
 *
 *   rename   keeps the stage's key - only the words on the column change, and
 *            every deal, report and history row still points at it;
 *   reorder  moves columns, not cards;
 *   remove   is refused for a column that still holds deals (the count is
 *            shown beside it) - move them first, or use "Change board
 *            columns", which moves them for you in one transaction.
 *
 * One Save for the whole board rather than a Save per row: a reorder touches
 * two rows at once, and half-saved boards are how columns go missing.
 */
export function ManageBoardDialog({ pipelineId, stages }: { pipelineId: string; stages: Stage[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<StageDraft[]>([]);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    setRows(draftsFromStages(stages));
    setError(null);
    setCounts(null);
    void stageCountsAction(pipelineId).then((r) => {
      if (r.error) setError(`Couldn't read how many deals are in each column: ${r.error}`);
      setCounts(r.counts ?? {});
    });
  }, [open, pipelineId, stages]);

  const save = () => {
    setError(null);
    const result = stagesFromDrafts(rows);
    if ("error" in result) return setError(result.error);

    startTransition(async () => {
      const saved = await saveStagesAction(pipelineId, result.stages);
      if (saved.error) {
        setError(saved.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Settings2 aria-hidden="true" className="h-4 w-4" />
        Manage board
      </Button>

      <Dialog
        open={open}
        onClose={() => {
          if (!pending) setOpen(false);
        }}
        title="Manage board"
        description="Rename, reorder, add or remove the columns deals move through."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={save} loading={pending}>
              Save board
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <StageListEditor rows={rows} setRows={setRows} counts={counts} noun="deal" />
          {error ? <ErrorBanner>{error}</ErrorBanner> : null}
        </div>
      </Dialog>
    </>
  );
}
