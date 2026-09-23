"use client";

import { useEffect, useState, useTransition } from "react";
import { X } from "lucide-react";
import { Button, FormField, Input, MonoLabel, StatusChip, useAlert, useToast } from "@aura/ui";
import { Time, useOrgTimeZone } from "@/components/org-time";
import { updateDealAction } from "./crm-actions";
import { CustomFieldEditor } from "./custom-field-editor";
import { InteractionTimeline } from "./interaction-timeline";
import { StageHistory } from "./stage-history";
import { TaskList } from "./task-list";
import { formatValue, num, relativeTime, type Deal, type Stage } from "./types";

/** Same hand-copied textarea chrome as lead-drawer.tsx - see that file's note. */
const TEXTAREA_CLASS =
  "w-full resize-y rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-text " +
  "transition-colors duration-150 ease-out placeholder:text-text-muted hover:border-text-subtle";

/**
 * One deal, opened from the board.
 *
 * CRM Phase 1 foundation (E0.1) - deliberately the same shape as
 * lead-drawer.tsx: instant render from the row the caller already holds, and
 * patches reported upward via onChanged rather than owning source-of-truth
 * state.
 *
 * The one thing it does fetch is the interaction timeline (Track A2), which
 * the board row cannot carry: a deal's history is unbounded, so paying for it
 * on every card in the list query would be the wrong trade.
 */
export function DealDrawer({
  deal,
  stages,
  onClose,
  onChanged,
}: {
  deal: Deal | null;
  stages: Stage[];
  onClose: () => void;
  onChanged?: (dealId: string, update: Partial<Deal>) => void;
}) {
  const [draft, setDraft] = useState({ nextAction: "", notes: "", amount: "" });
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const toast = useToast();
  const zone = useOrgTimeZone();

  useEffect(() => {
    if (!deal) return;
    setDraft({
      nextAction: deal.next_action ?? "",
      notes: deal.notes ?? "",
      amount: num(deal.amount)?.toString() ?? "",
    });
  }, [deal]);

  useEffect(() => {
    if (!deal) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [deal, onClose]);

  if (!deal) return null;

  const apply = (update: Parameters<typeof updateDealAction>[1]) => {
    startTransition(async () => {
      const result = await updateDealAction(deal.id, update);
      if (result.error) {
        await alert({ title: "Couldn't save the deal", body: result.error, tone: "danger" });
        return;
      }
      toast("Saved");
      onChanged?.(deal.id, result.deal ?? {});
    });
  };

  const saveDetails = () => {
    const parsedAmount = draft.amount.trim() === "" ? null : Number(draft.amount);
    if (parsedAmount !== null && !Number.isFinite(parsedAmount)) {
      void alert({
        title: "Enter a valid deal amount",
        body: "The amount has to be a number - leave it empty if there isn't one yet.",
        tone: "danger",
      });
      return;
    }
    apply({
      nextAction: draft.nextAction.trim() || null,
      notes: draft.notes.trim() || null,
      amount: parsedAmount,
    });
  };

  const facts = Object.entries(deal.facts ?? {}).filter(
    ([, value]) => value !== null && value !== "",
  );

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label={`Deal ${deal.name}`}
        className="fixed right-0 top-0 z-50 flex h-dvh w-full flex-col overflow-y-auto border-l border-border bg-surface shadow-lg sm:w-[30rem]"
      >
        <div className="sticky top-0 flex items-start justify-between gap-3 border-b border-border bg-surface p-4 sm:p-5">
          <div className="min-w-0">
            <MonoLabel>{deal.account_name ?? deal.contact_name ?? "No contact"}</MonoLabel>
            <h2 className="mt-1 text-xl leading-tight font-semibold break-words text-text">
              {deal.name}
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusChip tone={deal.status === "won" ? "solid" : "muted"}>
                {deal.status}
              </StatusChip>
              <span className="text-xs text-text-muted tabular-nums">
                {deal.call_count} call{deal.call_count === 1 ? "" : "s"} ·{" "}
                {relativeTime(deal.last_activity_at, zone)}
              </span>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 px-2"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="space-y-5 p-4 sm:p-5">
          <div className="space-y-2">
            <MonoLabel>Stage</MonoLabel>
            <div className="flex flex-wrap gap-1.5">
              {stages.map((stage) => (
                <button
                  key={stage.key}
                  type="button"
                  disabled={pending || stage.key === deal.stage}
                  aria-pressed={stage.key === deal.stage}
                  onClick={() => apply({ stage: stage.key })}
                  className={`inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors duration-150 ease-out disabled:cursor-default ${
                    stage.key === deal.stage
                      ? "border-transparent bg-accent-subtle text-accent-text"
                      : "border-border-strong bg-surface text-text-muted hover:bg-surface-hover hover:text-text"
                  }`}
                >
                  {stage.label}
                </button>
              ))}
            </div>
          </div>

          {deal.summary ? (
            <div className="space-y-1.5">
              <MonoLabel>What the call was about</MonoLabel>
              <p className="text-sm leading-relaxed text-text">{deal.summary}</p>
            </div>
          ) : null}

          {facts.length > 0 ? (
            <div className="space-y-2">
              <MonoLabel>Extracted details</MonoLabel>
              <dl className="divide-y divide-border rounded-md border border-border">
                {facts.map(([key, value]) => (
                  <div key={key} className="flex items-start justify-between gap-3 px-3 py-2">
                    <dt className="text-xs text-text-muted">{key.replace(/_/g, " ")}</dt>
                    <dd className="min-w-0 text-right text-xs break-words text-text">
                      {typeof value === "boolean"
                        ? value
                          ? "Yes"
                          : "No"
                        : String(value).replace(/_/g, " ")}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}

          <div className="space-y-3">
            <MonoLabel>Owner notes</MonoLabel>
            <FormField label="Deal amount" name="deal-amount">
              <Input
                value={draft.amount}
                onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
                inputMode="decimal"
                placeholder="-"
                className="tabular-nums"
              />
            </FormField>
            <FormField label="Next action" name="deal-next-action">
              <Input
                value={draft.nextAction}
                onChange={(e) => setDraft({ ...draft, nextAction: e.target.value })}
                maxLength={500}
                placeholder="Send the quote by Friday"
              />
            </FormField>
            <FormField label="Notes" name="deal-notes">
              <textarea
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                rows={4}
                maxLength={5000}
                className={TEXTAREA_CLASS}
              />
            </FormField>
            <Button type="button" onClick={saveDetails} loading={pending}>
              Save
            </Button>
          </div>

          <div className="border-t border-border pt-4">
            <StageHistory dealId={deal.id} stages={stages} />
          </div>

          {/* The org's own defined fields, distinct from "Extracted details"
              above: that block prints the raw `facts` blob, this one is the
              typed values an admin declared and a rep can correct. */}
          <div className="border-t border-border pt-4">
            <CustomFieldEditor parent="deals" parentId={deal.id} />
          </div>

          <div className="border-t border-border pt-4">
            <TaskList dealId={deal.id} title="Follow-ups" />
          </div>

          <div className="border-t border-border pt-4">
            <InteractionTimeline parent="deals" parentId={deal.id} />
          </div>

          <dl className="grid grid-cols-2 gap-3 border-t border-border pt-4 text-xs">
            <div>
              <dt className="text-text-muted">Amount</dt>
              <dd className="mt-0.5 font-medium text-text tabular-nums">
                {formatValue(deal.amount)}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Contact</dt>
              <dd className="mt-0.5 font-medium break-words text-text">
                {deal.contact_name ?? "-"}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Account</dt>
              <dd className="mt-0.5 font-medium break-words text-text">
                {deal.account_name ?? "-"}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Created</dt>
              <dd className="mt-0.5 font-medium text-text tabular-nums">
                <Time iso={deal.created_at} mode="date" />
              </dd>
            </div>
          </dl>
        </div>
      </aside>
    </>
  );
}
