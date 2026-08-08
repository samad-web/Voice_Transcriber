"use client";

import { useState } from "react";
import { GripVertical, Phone } from "lucide-react";
import { EmptyState, MonoLabel } from "@aura/ui";
import { LeadDrawer } from "../lead-drawer";
import { updateLeadAction } from "../actions";
import {
  contactLabel,
  formatValue,
  num,
  relativeTime,
  type BoardColumn,
  type Lead,
  type Stage,
} from "../types";

/**
 * The pipeline board.
 *
 * Drag-and-drop is the browser's own HTML5 API rather than a library: a card
 * carries its lead id, a column accepts the drop and the move is applied
 * optimistically, then confirmed by the server action. If the API rejects it
 * the card returns to where it was and the error is shown — a card that
 * silently snaps back with no explanation is the worst version of this.
 *
 * Every card is also a button that opens the drawer, where the same move can be
 * made by tapping a stage. That is the path on touch devices, where HTML5 drag
 * events do not fire.
 */
export function Board({ columns: initial, stages }: { columns: BoardColumn[]; stages: Stage[] }) {
  const [columns, setColumns] = useState(initial);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [open, setOpen] = useState<Lead | null>(null);
  const [error, setError] = useState<string | null>(null);

  const findLead = (leadId: string) =>
    columns.flatMap((c) => c.leads).find((l) => l.id === leadId) ?? null;

  /** Move a card between columns in local state, returning the previous stage. */
  const applyLocal = (leadId: string, toStage: string): string | null => {
    const lead = findLead(leadId);
    if (!lead || lead.stage === toStage) return null;
    const from = lead.stage;
    const moved = { ...lead, stage: toStage };

    setColumns((prev) =>
      prev.map((column) => {
        if (column.key === from) {
          return {
            ...column,
            count: Math.max(0, column.count - 1),
            value: column.value - (num(lead.value_num) ?? 0),
            leads: column.leads.filter((l) => l.id !== leadId),
          };
        }
        if (column.key === toStage) {
          return {
            ...column,
            count: column.count + 1,
            value: column.value + (num(lead.value_num) ?? 0),
            leads: [moved, ...column.leads],
          };
        }
        return column;
      }),
    );
    return from;
  };

  const move = async (leadId: string, toStage: string) => {
    setError(null);
    const from = applyLocal(leadId, toStage);
    if (!from) return;

    const result = await updateLeadAction(leadId, { stage: toStage });
    if (result.error) {
      applyLocal(leadId, from);
      setError(result.error);
      return;
    }
    // The server decides won/lost from the stage; reflect it on the card.
    if (result.lead?.status) {
      setColumns((prev) =>
        prev.map((column) => ({
          ...column,
          leads: column.leads.map((l) =>
            l.id === leadId ? { ...l, status: result.lead!.status as Lead["status"] } : l,
          ),
        })),
      );
    }
  };

  const patchOpen = (leadId: string, update: Partial<Lead>) => {
    setColumns((prev) =>
      prev.map((column) => ({
        ...column,
        leads: column.leads.map((l) => (l.id === leadId ? { ...l, ...update } : l)),
      })),
    );
    // A stage change from inside the drawer has to move the card too.
    if (update.stage) void applyLocal(leadId, update.stage);
    setOpen((current) => (current && current.id === leadId ? { ...current, ...update } : current));
  };

  const total = columns.reduce((n, c) => n + c.count, 0);

  return (
    <>
      {/* role=alert: a rejected drop has already snapped the card back, so this
          text is the only account of why — it has to be announced, not just
          shown. The danger border is a second channel on top of the words. */}
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-danger bg-danger-subtle p-3 text-sm font-medium text-danger-text"
        >
          {error}
        </p>
      ) : null}

      {total === 0 ? (
        <EmptyState
          title="Nothing in the pipeline yet"
          description="Cards appear automatically when a recorded call is transcribed and the AI agent extracts a usable enquiry from it."
        />
      ) : null}

      {/* One horizontal scroller; columns keep a fixed width so a busy stage
          does not squeeze the rest of the board into slivers. */}
      <div className="flex gap-4 overflow-x-auto pb-4 -mx-1 px-1">
        {columns.map((column) => (
          <section
            key={column.key}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(column.key);
            }}
            onDragLeave={() => setOver((c) => (c === column.key ? null : c))}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const leadId = e.dataTransfer.getData("text/lead-id") || dragging;
              if (leadId) void move(leadId, column.key);
              setDragging(null);
            }}
            // The drop target is a "selected" state, which doc 16 §1.1 lists as
            // a sanctioned accent use. It is also the only feedback a dragging
            // user gets, so it needs the accent border as well as the tint —
            // a tint alone is nearly invisible in dark mode.
            className={`flex w-[17rem] shrink-0 flex-col rounded-md border transition-colors duration-150 ease-out ${
              over === column.key
                ? "border-accent bg-accent-subtle"
                : "border-border bg-bg-subtle"
            }`}
          >
            <header className="flex items-center justify-between gap-2 rounded-t-md border-b border-border bg-surface px-3 py-2.5">
              <div className="min-w-0">
                <span className="block truncate text-sm font-medium text-text">
                  {column.label}
                </span>
                {column.value > 0 ? (
                  <span className="text-xs text-text-muted tabular-nums">
                    {formatValue(column.value)}
                  </span>
                ) : null}
              </div>
              <span
                className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium tabular-nums ${
                  // Won is the one stage worth marking in colour; lost is
                  // deliberately quiet rather than red, because a lost lead is
                  // a normal outcome and not an error to be flagged.
                  column.terminal === "won"
                    ? "border-transparent bg-success-subtle text-success-text"
                    : column.terminal === "lost"
                      ? "border-border bg-surface-hover text-text-muted"
                      : "border-border bg-surface text-text"
                }`}
              >
                {column.count}
              </span>
            </header>

            <div className="max-h-[calc(100dvh-16rem)] min-h-[8rem] flex-1 space-y-2 overflow-y-auto p-2">
              {column.leads.length === 0 ? (
                <p className="py-6 text-center text-xs text-text-subtle">Empty</p>
              ) : null}

              {column.leads.map((lead) => (
                <article
                  key={lead.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/lead-id", lead.id);
                    e.dataTransfer.effectAllowed = "move";
                    setDragging(lead.id);
                  }}
                  onDragEnd={() => setDragging(null)}
                  className={`cursor-grab rounded-md border border-border bg-surface p-2.5 shadow-sm transition-opacity duration-150 ease-out active:cursor-grabbing ${
                    dragging === lead.id ? "opacity-40" : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setOpen(lead)}
                    className="w-full rounded-sm text-left"
                    aria-label={`Open ${lead.title}`}
                  >
                    <div className="flex items-start gap-1.5">
                      <GripVertical
                        aria-hidden="true"
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-subtle"
                      />
                      <span className="min-w-0 text-sm font-medium leading-snug break-words text-text">
                        {lead.title}
                      </span>
                    </div>

                    {lead.next_action ? (
                      <p className="mt-1.5 line-clamp-2 text-xs leading-snug text-text-muted">
                        {lead.next_action}
                      </p>
                    ) : lead.summary ? (
                      <p className="mt-1.5 line-clamp-2 text-xs leading-snug text-text-muted">
                        {lead.summary}
                      </p>
                    ) : null}

                    <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
                      <span className="truncate text-xs text-text-muted">
                        {lead.telecaller ?? contactLabel(lead)}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {lead.call_count > 1 ? (
                          <span className="flex items-center gap-0.5 text-xs text-text-muted tabular-nums">
                            <Phone aria-hidden="true" className="h-3 w-3" />
                            {lead.call_count}
                          </span>
                        ) : null}
                        {num(lead.value_num) === null ? null : (
                          <span className="text-xs font-medium text-text tabular-nums">
                            {formatValue(lead.value_num)}
                          </span>
                        )}
                      </span>
                    </div>
                    <span className="mt-1 block text-xs text-text-subtle">
                      {relativeTime(lead.last_activity_at)}
                    </span>
                  </button>
                </article>
              ))}

              {column.count > column.leads.length ? (
                <MonoLabel className="text-center py-2">
                  +{column.count - column.leads.length} more
                </MonoLabel>
              ) : null}
            </div>
          </section>
        ))}
      </div>

      <LeadDrawer
        lead={open}
        stages={stages}
        onClose={() => setOpen(null)}
        onChanged={patchOpen}
      />
    </>
  );
}
