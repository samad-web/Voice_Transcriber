"use client";

import { useEffect, useState, useTransition } from "react";
import { Loader2, X } from "lucide-react";
import { BrutalButton, MonoLabel, StatusChip } from "@aura/ui";
import { fetchLeadAction, updateLeadAction } from "./actions";
import {
  contactLabel,
  formatDuration,
  formatValue,
  num,
  relativeTime,
  type Lead,
  type LeadCall,
  type Stage,
} from "./types";

/**
 * One lead, opened from either view.
 *
 * The board and the list already hold the row, so the panel renders instantly
 * from what the caller passed and fetches only the call history — which is the
 * part neither list can afford to carry for every card.
 */
export function LeadDrawer({
  lead,
  stages,
  onClose,
  onChanged,
}: {
  lead: Lead | null;
  stages: Stage[];
  onClose: () => void;
  /** Lets the board patch its own copy without a full refetch. */
  onChanged?: (leadId: string, update: Partial<Lead>) => void;
}) {
  const [calls, setCalls] = useState<LeadCall[] | null>(null);
  const [draft, setDraft] = useState({ nextAction: "", notes: "", value: "" });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const leadId = lead?.id ?? null;

  useEffect(() => {
    if (!lead) return;
    setCalls(null);
    setError(null);
    setSaved(false);
    setDraft({
      nextAction: lead.next_action ?? "",
      notes: lead.notes ?? "",
      value: num(lead.value_num)?.toString() ?? "",
    });
  }, [lead]);

  useEffect(() => {
    if (!leadId) return;
    let cancelled = false;
    void fetchLeadAction(leadId).then((result) => {
      if (!cancelled) setCalls(result.calls ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [leadId]);

  // Escape closes, and the page behind must not scroll under the panel.
  useEffect(() => {
    if (!lead) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [lead, onClose]);

  if (!lead) return null;

  const apply = (update: Parameters<typeof updateLeadAction>[1]) => {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateLeadAction(lead.id, update);
      if (result.error) {
        setError(result.error);
        return;
      }
      setSaved(true);
      onChanged?.(lead.id, result.lead ?? {});
    });
  };

  const saveDetails = () => {
    const parsedValue = draft.value.trim() === "" ? null : Number(draft.value);
    if (parsedValue !== null && !Number.isFinite(parsedValue)) {
      setError("Value must be a number");
      return;
    }
    apply({
      nextAction: draft.nextAction.trim() || null,
      notes: draft.notes.trim() || null,
      valueNum: parsedValue,
    });
  };

  const facts = Object.entries(lead.facts ?? {}).filter(
    ([, value]) => value !== null && value !== "",
  );

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label={`Lead ${lead.title}`}
        className="fixed right-0 top-0 h-dvh w-full sm:w-[30rem] bg-white border-l-4 border-black z-50 flex flex-col overflow-y-auto"
      >
        <div className="sticky top-0 bg-white border-b-2 border-black p-4 sm:p-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <MonoLabel>{contactLabel(lead)}</MonoLabel>
            <h2 className="text-xl font-display font-black uppercase tracking-tight leading-tight mt-1 break-words">
              {lead.title}
            </h2>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <StatusChip tone={lead.status === "won" ? "solid" : "muted"}>
                {lead.status}
              </StatusChip>
              <span className="text-[10px] font-mono text-neutral-400 font-bold uppercase tracking-wider">
                {lead.call_count} call{lead.call_count === 1 ? "" : "s"} ·{" "}
                {relativeTime(lead.last_activity_at)}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 border-2 border-black text-black rounded-none hover:bg-black hover:text-white shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 sm:p-5 space-y-5">
          <div className="space-y-2">
            <MonoLabel>Stage</MonoLabel>
            <div className="flex flex-wrap gap-1.5">
              {stages.map((stage) => (
                <button
                  key={stage.key}
                  type="button"
                  disabled={pending || stage.key === lead.stage}
                  onClick={() => apply({ stage: stage.key })}
                  className={`text-[10px] font-mono font-bold uppercase tracking-wider px-2.5 py-1.5 border-2 border-black transition-colors ${
                    stage.key === lead.stage
                      ? "bg-black text-white"
                      : "bg-white text-neutral-500 hover:text-black hover:bg-neutral-50"
                  } disabled:cursor-default`}
                >
                  {stage.label}
                </button>
              ))}
            </div>
          </div>

          {lead.summary ? (
            <div className="space-y-1.5">
              <MonoLabel>What the call was about</MonoLabel>
              <p className="text-sm font-sans text-neutral-700 leading-relaxed">{lead.summary}</p>
            </div>
          ) : null}

          {facts.length > 0 ? (
            <div className="space-y-2">
              <MonoLabel>Extracted details</MonoLabel>
              <dl className="divide-y-2 divide-neutral-100 border-2 border-neutral-200">
                {facts.map(([key, value]) => (
                  <div key={key} className="flex items-start justify-between gap-3 px-3 py-2">
                    <dt className="text-[10px] font-mono font-bold uppercase tracking-wider text-neutral-400">
                      {key.replace(/_/g, " ")}
                    </dt>
                    <dd className="text-xs font-sans text-black text-right break-words min-w-0">
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
            <label className="block">
              <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-neutral-400">
                Deal value
              </span>
              <input
                value={draft.value}
                onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                inputMode="decimal"
                placeholder="—"
                className="mt-1 w-full px-3 py-2 text-sm font-mono border-2 border-black rounded-none focus:outline-none focus:ring-2 focus:ring-black"
              />
            </label>
            <label className="block">
              <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-neutral-400">
                Next action
              </span>
              <input
                value={draft.nextAction}
                onChange={(e) => setDraft({ ...draft, nextAction: e.target.value })}
                maxLength={500}
                placeholder="Call back Tuesday with a quote"
                className="mt-1 w-full px-3 py-2 text-sm font-sans border-2 border-black rounded-none focus:outline-none focus:ring-2 focus:ring-black"
              />
            </label>
            <label className="block">
              <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-neutral-400">
                Notes
              </span>
              <textarea
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                rows={4}
                maxLength={5000}
                className="mt-1 w-full px-3 py-2 text-sm font-sans border-2 border-black rounded-none focus:outline-none focus:ring-2 focus:ring-black resize-y"
              />
            </label>
            <div className="flex items-center gap-3">
              <BrutalButton onClick={saveDetails} disabled={pending} shadow>
                {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Save
              </BrutalButton>
              {saved && !pending ? (
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-neutral-500">
                  Saved
                </span>
              ) : null}
            </div>
            {error ? (
              <p className="text-xs font-mono font-bold text-red-600 border-2 border-red-600 bg-red-50 p-2">
                {error}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <MonoLabel>Call history</MonoLabel>
            {calls === null ? (
              <p className="text-[10px] font-mono font-bold uppercase text-neutral-400 py-3">
                Loading…
              </p>
            ) : calls.length === 0 ? (
              <p className="text-[10px] font-mono font-bold uppercase text-neutral-400 py-3">
                No calls on record
              </p>
            ) : (
              <div className="divide-y-2 divide-neutral-100 border-2 border-neutral-200">
                {calls.map((call) => (
                  <div key={call.id} className="px-3 py-2 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <span className="text-xs font-sans text-black block">
                        {new Date(call.started_at).toLocaleString()}
                      </span>
                      <span className="text-[10px] font-mono text-neutral-400 uppercase tracking-wider">
                        {call.direction} · {call.telecaller ?? "unknown handset"}
                      </span>
                    </div>
                    <span className="text-[10px] font-mono font-bold text-neutral-500 shrink-0">
                      {formatDuration(call.duration_s)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <dl className="grid grid-cols-2 gap-3 pt-2 border-t-2 border-neutral-200 text-[10px] font-mono">
            <div>
              <dt className="text-neutral-400 uppercase tracking-wider font-bold">Value</dt>
              <dd className="text-black font-bold mt-0.5">{formatValue(lead.value_num)}</dd>
            </div>
            <div>
              <dt className="text-neutral-400 uppercase tracking-wider font-bold">Telecaller</dt>
              <dd className="text-black font-bold mt-0.5 break-words">
                {lead.telecaller ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-neutral-400 uppercase tracking-wider font-bold">First seen</dt>
              <dd className="text-black font-bold mt-0.5">
                {new Date(lead.created_at).toLocaleDateString()}
              </dd>
            </div>
            <div>
              <dt className="text-neutral-400 uppercase tracking-wider font-bold">Confidence</dt>
              <dd className="text-black font-bold mt-0.5">
                {num(lead.score) === null ? "—" : `${Math.round(num(lead.score)! * 100)}%`}
              </dd>
            </div>
          </dl>
        </div>
      </aside>
    </>
  );
}
