"use client";

import { useState } from "react";
import { GripVertical, Phone } from "lucide-react";
import { MonoLabel } from "@aura/ui";
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
      {error ? (
        <p className="text-xs font-mono font-bold uppercase text-red-600 border-2 border-red-600 bg-red-50 p-3">
          {error}
        </p>
      ) : null}

      {total === 0 ? (
        <div className="border-2 border-black bg-white p-10 text-center space-y-2">
          <p className="text-xs font-mono font-bold uppercase text-neutral-400">
            Nothing in the pipeline yet
          </p>
          <p className="text-xs text-neutral-500 font-sans max-w-md mx-auto leading-relaxed">
            Cards appear automatically when a recorded call is transcribed and
            the AI agent extracts a usable enquiry from it.
          </p>
        </div>
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
            className={`w-[17rem] shrink-0 flex flex-col border-2 border-black bg-neutral-50 transition-colors ${
              over === column.key ? "bg-neutral-200" : ""
            }`}
          >
            <header className="px-3 py-2.5 border-b-2 border-black bg-white flex items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="text-xs font-display font-bold uppercase tracking-wider truncate block">
                  {column.label}
                </span>
                {column.value > 0 ? (
                  <span className="text-[10px] font-mono text-neutral-400 font-bold">
                    {formatValue(column.value)}
                  </span>
                ) : null}
              </div>
              <span
                className={`text-[10px] font-mono font-bold px-2 py-0.5 border border-black shrink-0 ${
                  column.terminal === "won"
                    ? "bg-black text-white"
                    : column.terminal === "lost"
                      ? "bg-neutral-200 text-black"
                      : "bg-white text-black"
                }`}
              >
                {column.count}
              </span>
            </header>

            <div className="flex-1 p-2 space-y-2 min-h-[8rem] max-h-[calc(100dvh-16rem)] overflow-y-auto">
              {column.leads.length === 0 ? (
                <p className="text-[10px] font-mono font-bold uppercase text-neutral-300 text-center py-6">
                  Empty
                </p>
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
                  className={`bg-white border-2 border-black p-2.5 cursor-grab active:cursor-grabbing ${
                    dragging === lead.id ? "opacity-40" : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setOpen(lead)}
                    className="w-full text-left"
                    aria-label={`Open ${lead.title}`}
                  >
                    <div className="flex items-start gap-1.5">
                      <GripVertical className="h-3.5 w-3.5 text-neutral-300 shrink-0 mt-0.5" />
                      <span className="font-display font-bold text-sm text-black leading-tight break-words min-w-0">
                        {lead.title}
                      </span>
                    </div>

                    {lead.next_action ? (
                      <p className="text-[11px] font-sans text-neutral-600 mt-1.5 line-clamp-2 leading-snug">
                        {lead.next_action}
                      </p>
                    ) : lead.summary ? (
                      <p className="text-[11px] font-sans text-neutral-500 mt-1.5 line-clamp-2 leading-snug">
                        {lead.summary}
                      </p>
                    ) : null}

                    <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-neutral-200">
                      <span className="text-[9px] font-mono font-bold uppercase tracking-wider text-neutral-400 truncate">
                        {lead.telecaller ?? contactLabel(lead)}
                      </span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        {lead.call_count > 1 ? (
                          <span className="flex items-center gap-0.5 text-[9px] font-mono font-bold text-neutral-400">
                            <Phone className="h-2.5 w-2.5" />
                            {lead.call_count}
                          </span>
                        ) : null}
                        {num(lead.value_num) === null ? null : (
                          <span className="text-[10px] font-mono font-bold text-black">
                            {formatValue(lead.value_num)}
                          </span>
                        )}
                      </span>
                    </div>
                    <span className="text-[9px] font-mono text-neutral-300 block mt-1">
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
