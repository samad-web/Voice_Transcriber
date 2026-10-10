"use client";

import { useState } from "react";
import { Button, StatusChip } from "@aura/ui";
import { toolLabel, type AgentToolName } from "@aura/shared";
import type { ReviewAgentAction } from "@/lib/review-queue";
import { bulkApproveAgentActionsAction } from "./actions";

/**
 * §12's "bulk approve for high-confidence similar items".
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  "SIMILAR" AND "HIGH-CONFIDENCE" ARE BOTH LOAD-BEARING
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A checkbox on every card and one Approve button would also be "bulk
 * approve", and it would be the wrong thing: it invites a reviewer to clear
 * the queue without reading it, which turns the review step into a formality
 * and takes the accuracy measurement down with it (§13.3 counts an approval as
 * a success).
 *
 * So the gesture offered here is narrow on purpose:
 *
 *   SIMILAR         - one button per TOOL. "Record the call outcome × 12" is a
 *                     judgement a person can actually make in one go; "approve
 *                     these 12 unrelated things" is not.
 *   HIGH-CONFIDENCE - only items at or above the intent's own AUTOMATIC
 *                     threshold, which is the score at which the org has
 *                     already said it would not need a person if autonomy were
 *                     switched on. Anything below that is exactly what the
 *                     queue exists for, and is left to be read one at a time.
 *
 * ── CUSTOMER-VISIBLE WORK IS NEVER OFFERED HERE ──────────────────────────
 *
 * T2 and T3 tools are excluded whatever they scored. §8.2's tiers say a
 * customer-visible action needs human confirmation; "I pressed one button for
 * eleven of them" is not that, and a wrongly-sent message cannot be taken
 * back the way a wrong disposition can.
 *
 * The API decides each item separately regardless (the same gate re-check, the
 * same frozen check, the same audit row per item), so this cannot approve
 * something a single Approve would have refused - it can only be refused in
 * bulk, which is why the failures come back per item and are shown.
 */

export function AgentBulkApprove({ items }: { items: readonly ReviewAgentAction[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(() => new Set());
  const [note, setNote] = useState<string | null>(null);

  const groups = eligibleGroups(items).filter((group) => !done.has(group.tool));
  if (groups.length === 0) return note ? <Note text={note} /> : null;

  const run = async (tool: string, ids: string[]) => {
    setBusy(tool);
    setNote(null);
    const res = await bulkApproveAgentActionsAction(ids);
    setBusy(null);
    if (res.error) {
      setNote(res.error);
      return;
    }
    setDone((prev) => new Set(prev).add(tool));
    const failed = res.failures?.length ?? 0;
    setNote(
      failed === 0
        ? `Approved ${res.approved ?? 0}. They will run in the next few minutes.`
        : `Approved ${res.approved ?? 0}; ${failed} could not be and are still in the list below.`,
    );
  };

  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <p className="text-sm font-medium text-text">Approve a batch</p>
      <p className="mt-0.5 text-xs text-text-muted">
        Only the ones that scored high enough to have run on their own, and only internal work —
        anything the customer would see stays one at a time.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {groups.map((group) => (
          <Button
            key={group.tool}
            type="button"
            size="sm"
            variant="secondary"
            loading={busy === group.tool}
            disabled={busy !== null}
            onClick={() => void run(group.tool, group.ids)}
          >
            {toolLabel(group.tool as AgentToolName)}
            <StatusChip tone="muted">{group.ids.length}</StatusChip>
          </Button>
        ))}
      </div>
      {note ? <Note text={note} /> : null}
    </div>
  );
}

function Note({ text }: { text: string }) {
  return (
    <p role="status" className="mt-2 text-xs text-text-muted">
      {text}
    </p>
  );
}

interface Group {
  tool: string;
  ids: string[];
}

/**
 * One group per tool, for the items that qualify. Exported for the test: the
 * eligibility rule is the whole safety property of this component, and it is
 * the sort of condition that gets loosened by accident.
 */
export function eligibleGroups(items: readonly ReviewAgentAction[]): Group[] {
  const byTool = new Map<string, string[]>();
  for (const item of items) {
    if (!isBulkEligible(item)) continue;
    const existing = byTool.get(item.tool);
    if (existing) existing.push(item.id);
    else byTool.set(item.tool, [item.id]);
  }
  // Two or more: a single item is not a batch, and offering "Approve 1" next to
  // the card's own Approve button is two buttons for one decision.
  return [...byTool.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([tool, ids]) => ({ tool, ids: ids.slice(0, 100) }));
}

export function isBulkEligible(item: ReviewAgentAction): boolean {
  if (item.state !== "pending_review") return false;
  // T0 and T1 only. See the header.
  if (item.tier !== "T0" && item.tier !== "T1") return false;
  // The intent's OWN automatic threshold, served by the API alongside the
  // score. Not a constant here: an org can raise it per intent (§8.2), and a
  // number hard-coded in the console would ignore that.
  if (item.final_score === null || item.thresholds === null) return false;
  return item.final_score >= item.thresholds.auto;
}
