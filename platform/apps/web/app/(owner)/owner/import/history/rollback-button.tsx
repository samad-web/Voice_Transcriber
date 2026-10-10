"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, useAlert, useConfirm } from "@aura/ui";
import { rollbackImportAction } from "../actions";

/**
 * §3 step 11's undo, as a button that asks for a reason first.
 *
 * ── WHY IT ASKS, WHEN §3 SAYS "ONE-CLICK" ───────────────────────────────────
 *
 * Because a finance rollback is not a delete. A payment is REVERSED - §6.3's
 * MUST is "never edit or delete a posted payment or ledger row" - and the
 * reversal writes a ledger entry that stays on the books forever. The reason
 * goes onto that entry and into `audit_log`. A blank one leaves an auditor
 * looking at a correction nobody can account for, which is the thing an audit
 * trail exists to prevent. The API agrees: `rollback` requires a reason of at
 * least three characters.
 *
 * ── THE REASON IS AN INLINE FIELD, NOT A DIALOG ─────────────────────────────
 *
 * The kit has `useConfirm` (yes/no, with a type-to-confirm gate) and
 * `useAlert`, and no text-prompt hook. Rather than add a third dialog
 * primitive for one call site, the field opens in place and `useConfirm`
 * still provides the destructive gate - so this inherits the same
 * type-CONFIRM behaviour every other irreversible action in the console has.
 *
 * ── AND WHY IT REPORTS WHAT IT COULD NOT DO ─────────────────────────────────
 *
 * A rollback is allowed to be partial: an approved expense is left alone, a
 * reconciled statement line is left alone, and a locked period refuses
 * outright. A button that said "undone" and left eleven rows in place would be
 * worse than one that refused everything, because nobody would go looking.
 */
export function RollbackButton({
  jobId,
  entityLabel,
  rowCount,
}: {
  jobId: string;
  entityLabel: string;
  rowCount: number;
}) {
  const router = useRouter();
  const alert = useAlert();
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [done, setDone] = useState(false);

  const tooShort = reason.trim().length < 3;

  async function run() {
    if (tooShort) return;
    const ok = await confirm({
      title: `Undo this import of ${rowCount} ${entityLabel.toLowerCase()}?`,
      body:
        "Payments are reversed rather than deleted, so the ledger keeps both entries. " +
        "Anything already approved, already reconciled, or in a locked month is left alone.",
      confirmLabel: "Undo the import",
      tone: "danger",
    });
    if (!ok) return;

    start(async () => {
      const res = await rollbackImportAction(jobId, reason.trim());
      if (res.error) {
        await alert({ title: "Couldn't undo that import", body: res.error, tone: "danger" });
        return;
      }
      setDone(true);
      setOpen(false);
      const kept = res.kept ?? 0;
      const undone = res.undone ?? 0;
      await alert({
        title: kept === 0 ? "Import undone" : "Import partly undone",
        body:
          kept === 0
            ? `${undone} record${undone === 1 ? "" : "s"} undone.`
            : `${undone} undone, ${kept} left in place.` +
              (res.problems && res.problems.length > 0 ? ` ${res.problems.join(" ")}` : ""),
        tone: kept === 0 ? "default" : "danger",
      });
      router.refresh();
    });
  }

  if (done) return <span className="text-xs text-text-muted">Undone</span>;

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)} disabled={pending}>
        Undo
      </Button>
    );
  }

  return (
    <div className="space-y-2">
      <label className="block">
        <span className="sr-only">Why is this import being undone?</span>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why? e.g. wrong file"
          className="w-44 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text placeholder:text-text-subtle"
          autoFocus
        />
      </label>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
        <Button onClick={() => void run()} disabled={pending || tooShort}>
          {pending ? "Undoing…" : "Undo"}
        </Button>
      </div>
    </div>
  );
}
