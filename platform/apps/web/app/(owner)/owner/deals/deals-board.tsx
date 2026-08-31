"use client";

import { KanbanBoard, type KanbanColumn } from "../board/kanban-board";
import { DealDrawer } from "../deal-drawer";
import { updateDealAction } from "../crm-actions";
import type { Deal, DealBoardColumn, Stage } from "../types";

/**
 * The deal pipeline board — a thin config over ../board/kanban-board.tsx, the
 * generic board factored out of this file and the lead board
 * (../board/board.tsx) once the two turned out to be near-verbatim copies of
 * the same drag-and-drop / optimistic-update mechanics. See that file's own
 * header comment for the DnD rationale.
 */
export function DealsBoard({
  columns: initial,
  stages,
}: {
  columns: DealBoardColumn[];
  stages: Stage[];
}) {
  const columns: KanbanColumn<Deal>[] = initial.map((c) => ({
    key: c.key,
    label: c.label,
    terminal: c.terminal,
    count: c.count,
    value: c.value,
    items: c.deals,
  }));

  return (
    <KanbanBoard
      columns={columns}
      config={{
        getId: (deal) => deal.id,
        getValue: (deal) => deal.amount,
        getTitle: (deal) => deal.name,
        getSubtitle: (deal) => deal.account_name ?? deal.contact_name ?? "no contact",
        getSecondary: (deal) => deal.next_action ?? deal.summary,
        getCallCount: (deal) => deal.call_count,
        getLastActivityAt: (deal) => deal.last_activity_at,
        dragDataKey: "text/deal-id",
        emptyState: {
          title: "No deals yet",
          description:
            "Deals appear automatically alongside the lead board when a recorded call is transcribed and the AI agent extracts a usable enquiry, or when one is created by hand.",
        },
        moveOnServer: async (id, stage) => {
          const result = await updateDealAction(id, { stage });
          return { error: result.error, record: result.deal };
        },
        renderDrawer: ({ open, onClose, onChanged }) => (
          <DealDrawer deal={open} stages={stages} onClose={onClose} onChanged={onChanged} />
        ),
      }}
    />
  );
}
