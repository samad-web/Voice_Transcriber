"use client";

import { useEffect, useState, useTransition } from "react";
import { X } from "lucide-react";
import {
  Button,
  FormField,
  Input,
  MonoLabel,
  StateChip,
  StatusChip,
  callState,
  useAlert,
  useToast,
} from "@aura/ui";
import { LEAD_TEMPERATURE_LABELS, LEAD_TEMPERATURE_ORDER } from "@aura/shared";
import { Time, useOrgTimeZone } from "@/components/org-time";
import { InlineListSkeleton } from "@/components/skeletons";
import { fetchLeadAction, updateLeadAction } from "./actions";
import { CallReadChips, CallTranscript } from "./call-intel";
import { ProjectChip } from "./project-chip";
import {
  contactLabel,
  formatDuration,
  formatValue,
  num,
  relativeTime,
  type Lead,
  type LeadCall,
  type Project,
  type Stage,
} from "./types";

/*
 * The <textarea> chrome, kept identical to the kit's CONTROL_BASE by hand.
 *
 * @aura/ui has no Textarea primitive yet (doc 18 §2 lists it as deliberately
 * deferred under "build only what a page uses"), and control-styles.ts is not
 * exported from the package index. This is the one console textarea, so it is
 * copied rather than left on the old 2px black border - which would be the only
 * brutalist edge left in the drawer. When Textarea lands, delete this.
 */
const TEXTAREA_CLASS =
  "w-full resize-y rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-text " +
  "transition-colors duration-150 ease-out placeholder:text-text-muted hover:border-text-subtle";

/**
 * One lead, opened from either view.
 *
 * The board and the list already hold the row, so the panel renders instantly
 * from what the caller passed and fetches only the call history - which is the
 * part neither list can afford to carry for every card.
 */
export function LeadDrawer({
  lead,
  stages,
  projects = [],
  onClose,
  onChanged,
}: {
  lead: Lead | null;
  stages: Stage[];
  /** The catalogue, for the project picker. Empty = no projects configured. */
  projects?: Project[];
  onClose: () => void;
  /** Lets the board patch its own copy without a full refetch. */
  onChanged?: (leadId: string, update: Partial<Lead>) => void;
}) {
  const [calls, setCalls] = useState<LeadCall[] | null>(null);
  const [draft, setDraft] = useState({ nextAction: "", notes: "", value: "" });
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const toast = useToast();
  const zone = useOrgTimeZone();

  const leadId = lead?.id ?? null;

  useEffect(() => {
    if (!lead) return;
    setCalls(null);
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
    startTransition(async () => {
      const result = await updateLeadAction(lead.id, update);
      if (result.error) {
        await alert({ title: "Couldn't save the lead", body: result.error, tone: "danger" });
        return;
      }
      toast("Saved");
      onChanged?.(lead.id, result.lead ?? {});
    });
  };

  const saveDetails = () => {
    const parsedValue = draft.value.trim() === "" ? null : Number(draft.value);
    if (parsedValue !== null && !Number.isFinite(parsedValue)) {
      void alert({
        title: "Enter a valid deal value",
        body: "The value has to be a number - leave it empty if there isn't one yet.",
        tone: "danger",
      });
      return;
    }
    apply({
      nextAction: draft.nextAction.trim() || null,
      notes: draft.notes.trim() || null,
      valueNum: parsedValue,
    });
  };

  /**
   * The PATCH returns project_id and project_source but not the joined name
   * and colour, so the chip is re-derived here from the catalogue the caller
   * already holds. Without this the card would lose its label until the next
   * full refetch and look like the save had failed.
   */
  const setProject = (projectId: string | null) => {
    const picked = projects.find((p) => p.id === projectId) ?? null;
    startTransition(async () => {
      const result = await updateLeadAction(lead.id, { projectId });
      if (result.error) {
        await alert({ title: "Couldn't set the project", body: result.error, tone: "danger" });
        return;
      }
      toast("Saved");
      onChanged?.(lead.id, {
        ...(result.lead ?? {}),
        project_id: picked?.id ?? null,
        project_name: picked?.name ?? null,
        project_color: picked?.color ?? null,
        project_source: "human",
      });
    });
  };

  const facts = Object.entries(lead.facts ?? {}).filter(
    ([, value]) => value !== null && value !== "",
  );

  return (
    <>
      {/* The scrim is a shadow over the page, not a surface: it stays a literal
          black wash in both modes rather than flipping with the theme. */}
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label={`Lead ${lead.title}`}
        className="fixed right-0 top-0 z-50 flex h-dvh w-full flex-col overflow-y-auto border-l border-border bg-surface shadow-lg sm:w-[30rem]"
      >
        <div className="sticky top-0 flex items-start justify-between gap-3 border-b border-border bg-surface p-4 sm:p-5">
          <div className="min-w-0">
            <MonoLabel>{contactLabel(lead)}</MonoLabel>
            <h2 className="mt-1 text-xl leading-tight font-semibold break-words text-text">
              {lead.title}
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusChip tone={lead.status === "won" ? "solid" : "muted"}>
                {lead.status}
              </StatusChip>
              <span className="text-xs text-text-muted tabular-nums">
                {lead.call_count} call{lead.call_count === 1 ? "" : "s"} ·{" "}
                {relativeTime(lead.last_activity_at, zone)}
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
                  disabled={pending || stage.key === lead.stage}
                  // aria-pressed, not colour alone: the current stage is also
                  // the disabled one, and "disabled" is not a synonym for
                  // "selected" to a screen reader.
                  aria-pressed={stage.key === lead.stage}
                  onClick={() => apply({ stage: stage.key })}
                  className={`inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors duration-150 ease-out disabled:cursor-default ${
                    stage.key === lead.stage
                      ? "border-transparent bg-accent-subtle text-accent-text"
                      : "border-border-strong bg-surface text-text-muted hover:bg-surface-hover hover:text-text"
                  }`}
                >
                  {stage.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <MonoLabel>How warm</MonoLabel>
              {lead.temperature && lead.temperature_source === "auto" ? (
                // The same disclosure the project label makes, for the same
                // reason: this was the AI's read of the call, and picking one
                // yourself takes the rating off the AI permanently. Someone
                // correcting a wrong rating deserves to know it sticks.
                <span className="text-xs text-text-muted">
                  Rated from the call - choosing one makes it yours
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {LEAD_TEMPERATURE_ORDER.map((t) => (
                <button
                  key={t}
                  type="button"
                  disabled={pending}
                  aria-pressed={t === lead.temperature}
                  // Clicking the current rating clears it, which is the only
                  // way to hand it back to the AI - so this is a toggle, not
                  // a radio, and unlike Stage the selected one stays enabled.
                  onClick={() => apply({ temperature: t === lead.temperature ? null : t })}
                  className={`inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors duration-150 ease-out disabled:cursor-default ${
                    t === lead.temperature
                      ? "border-transparent bg-accent-subtle text-accent-text"
                      : "border-border-strong bg-surface text-text-muted hover:bg-surface-hover hover:text-text"
                  }`}
                >
                  {LEAD_TEMPERATURE_LABELS[t]}
                </button>
              ))}
            </div>
          </div>

          {projects.length > 0 ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <MonoLabel>Project</MonoLabel>
                {lead.project_source === "extraction" && lead.project_name ? (
                  // Say plainly that a machine chose this and that changing it
                  // is final. Anyone correcting a wrong label deserves to know
                  // the correction sticks - otherwise they will correct it
                  // again next week and assume the system is broken.
                  <span className="text-xs text-text-subtle">
                    Detected from the call - picking one below makes it yours
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {projects
                  // An archived project stays offered while it is the one
                  // currently on this lead: hiding it would make the chip row
                  // silently disagree with the label above it.
                  .filter((p) => p.active || p.id === lead.project_id)
                  .map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      disabled={pending}
                      aria-pressed={p.id === lead.project_id}
                      onClick={() => setProject(p.id === lead.project_id ? null : p.id)}
                      className="rounded-full disabled:opacity-60"
                    >
                      <ProjectChip
                        name={p.name}
                        color={p.color}
                        className={
                          p.id === lead.project_id
                            ? "ring-2 ring-accent ring-offset-1 ring-offset-surface"
                            : "opacity-60"
                        }
                      />
                    </button>
                  ))}
              </div>
            </div>
          ) : null}

          {lead.summary ? (
            <div className="space-y-1.5">
              <MonoLabel>What the call was about</MonoLabel>
              <p className="text-sm leading-relaxed text-text">{lead.summary}</p>
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
            {/* FormField, not a bare <label> wrapper: it owns the for/id pairing
                and the aria-describedby wiring, which is exactly the part that
                was missing from the hand-rolled version. */}
            <FormField label="Deal value" name="lead-value">
              <Input
                value={draft.value}
                onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                inputMode="decimal"
                placeholder="-"
                className="tabular-nums"
              />
            </FormField>
            <FormField label="Next action" name="lead-next-action">
              <Input
                value={draft.nextAction}
                onChange={(e) => setDraft({ ...draft, nextAction: e.target.value })}
                maxLength={500}
                placeholder="Call back Tuesday with a quote"
              />
            </FormField>
            <FormField label="Notes" name="lead-notes">
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

          <div className="space-y-2">
            <MonoLabel>Call history</MonoLabel>
            {calls === null ? (
              <InlineListSkeleton rows={2} label="Loading call history" />
            ) : calls.length === 0 ? (
              <p className="py-3 text-xs text-text-muted">No calls on record</p>
            ) : (
              <div className="divide-y divide-border rounded-md border border-border">
                {calls.map((call) => (
                  <div key={call.id} className="px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <span className="block text-xs text-text">
                          <Time iso={call.started_at} mode="datetime" />
                        </span>
                        <span className="text-xs text-text-muted">
                          {call.direction} · {call.telecaller ?? "unknown handset"}
                        </span>
                      </div>
                      {/* A call this customer made that nobody picked up
                          (0133) - on a lead, the clearest sign they are
                          chasing. The chip rather than "0m", which reads as a
                          very short conversation. */}
                      {callState(call) === "missed" ? (
                        <StateChip state="missed" className="shrink-0" />
                      ) : (
                        <span className="shrink-0 text-xs text-text-muted tabular-nums">
                          {formatDuration(call.duration_s)}
                        </span>
                      )}
                    </div>
                    {/* Both render nothing without the `call_intel` module: the
                        API leaves the fields out, so a tenant that does not have
                        it sees exactly the row it saw before. */}
                    <div className="mt-1.5 empty:mt-0">
                      <CallReadChips
                        intent={call.intent}
                        sentiment={call.sentiment}
                        outcome={call.outcome}
                        qualityScore={call.quality_score}
                      />
                    </div>
                    {call.has_transcript ? <CallTranscript leadId={lead.id} call={call} /> : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          <dl className="grid grid-cols-2 gap-3 border-t border-border pt-4 text-xs">
            <div>
              <dt className="text-text-muted">Value</dt>
              <dd className="mt-0.5 font-medium text-text tabular-nums">
                {formatValue(lead.value_num)}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Telecaller</dt>
              <dd className="mt-0.5 font-medium break-words text-text">{lead.telecaller ?? "-"}</dd>
            </div>
            <div>
              <dt className="text-text-muted">First seen</dt>
              <dd className="mt-0.5 font-medium text-text tabular-nums">
                <Time iso={lead.created_at} mode="date" />
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Confidence</dt>
              <dd className="mt-0.5 font-medium text-text tabular-nums">
                {num(lead.score) === null ? "-" : `${Math.round(num(lead.score)! * 100)}%`}
              </dd>
            </div>
          </dl>
        </div>
      </aside>
    </>
  );
}
