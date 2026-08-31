"use client";

import { KanbanBoard, type KanbanColumn } from "./kanban-board";
import { LeadDrawer } from "../lead-drawer";
import { ProjectChip } from "../project-chip";
import { updateLeadAction } from "../actions";
import {
  contactLabel,
  type BoardColumn,
  type Lead,
  type Project,
  type Stage,
} from "../types";

/**
 * The lead pipeline board — a thin config over the generic ./kanban-board.tsx,
 * which owns the drag-and-drop / optimistic-update-with-rollback mechanics
 * shared with the deal board (../deals/deals-board.tsx). See that file's own
 * header comment for why the DnD is hand-rolled rather than a library, and
 * why every card is also a button (the touch-device path).
 */
export function Board({
  columns: initial,
  stages,
  projects,
}: {
  columns: BoardColumn[];
  stages: Stage[];
  projects: Project[];
}) {
  const columns: KanbanColumn<Lead>[] = initial.map((c) => ({
    key: c.key,
    label: c.label,
    terminal: c.terminal,
    count: c.count,
    value: c.value,
    items: c.leads,
  }));

  return (
    <KanbanBoard
      columns={columns}
      config={{
        getId: (lead) => lead.id,
        getValue: (lead) => lead.value_num,
        getTitle: (lead) => lead.title,
        getSubtitle: (lead) => lead.telecaller ?? contactLabel(lead),
        getSecondary: (lead) => lead.next_action ?? lead.summary,
        getCallCount: (lead) => lead.call_count,
        getLastActivityAt: (lead) => lead.last_activity_at,
        dragDataKey: "text/lead-id",
        renderBadge: (lead) =>
          lead.project_name ? (
            <ProjectChip
              name={lead.project_name}
              color={lead.project_color}
              source={lead.project_source}
            />
          ) : null,
        emptyState: {
          title: "Nothing in the pipeline yet",
          description:
            "Cards appear automatically when a recorded call is transcribed and the AI agent extracts a usable enquiry from it.",
        },
        moveOnServer: async (id, stage) => {
          const result = await updateLeadAction(id, { stage });
          return { error: result.error, record: result.lead };
        },
        renderDrawer: ({ open, onClose, onChanged }) => (
          <LeadDrawer
            lead={open}
            stages={stages}
            projects={projects}
            onClose={onClose}
            onChanged={onChanged}
          />
        ),
      }}
    />
  );
}
