"use client";

import { LeadDrawer } from "../lead-drawer";
import { ProjectChip } from "../project-chip";
import { TemperatureChip } from "../temperature-chip";
import { fetchLeadAction, updateLeadAction } from "../actions";
import {
  contactLabel,
  type BoardColumn,
  type Lead,
  type Project,
  type Stage,
} from "../types";
import { KanbanBoard, type KanbanColumn } from "./kanban-board";

/**
 * The lead pipeline board - a thin config over the generic ./kanban-board.tsx,
 * which owns the drag-and-drop / optimistic-update-with-rollback mechanics
 * shared with the deal board (../deals/deals-board.tsx). See that file's own
 * header comment for why the DnD is hand-rolled rather than a library, and
 * why every card is also a button (the touch-device path).
 */
export function Board({
  columns: initial,
  stages,
  projects,
  isMain = true,
}: {
  columns: BoardColumn[];
  stages: Stage[];
  projects: Project[];
  /** The Main board fills from calls; any other board only from routing and New lead (0136). */
  isMain?: boolean;
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
        // `/owner/board?focus=<leadId>` opens that lead's drawer, the same deep
        // link the Deals board has - used by a contact page's "Open the lead"
        // (doc 23, H2).
        loadFocused: async (id) => (await fetchLeadAction(id)).lead ?? null,
        // Two chips share this slot: how warm the lead is, and what it is
        // for. Temperature first - it is the one that decides whether the
        // card is worth opening at all.
        renderBadge: (lead) =>
          lead.temperature || lead.project_name ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <TemperatureChip temperature={lead.temperature} source={lead.temperature_source} />
              {lead.project_name ? (
                <ProjectChip
                  name={lead.project_name}
                  color={lead.project_color}
                  source={lead.project_source}
                />
              ) : null}
            </span>
          ) : null,
        emptyState: isMain
          ? {
              title: "Nothing in the pipeline yet",
              description:
                "Cards appear automatically when a recorded call is transcribed and the AI agent extracts a usable enquiry from it.",
            }
          : {
              title: "Nothing on this board yet",
              description:
                "Send a channel's new leads here in Manage boards → Routing, add one with New lead, or move a lead here from its drawer.",
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
