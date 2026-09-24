import type { Metadata } from "next";
import { Card, EmptyState, MonoLabel } from "@aura/ui";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { ownerGet, ownerTry } from "@/lib/owner-context";
import { boardRef, type BoardColumn, type LeadBoardGrants, type LeadBoardRef, type Project, type Stage } from "../types";
import { FilterLink } from "../filter-link";
import { Board } from "./board";
import { ManageLeadBoardsDialog } from "./manage-lead-boards-dialog";
import { NewLeadDialog } from "./new-lead-dialog";

export const metadata: Metadata = { title: "Lead board" };

interface BoardResponse {
  columns: BoardColumn[];
  stages: Stage[];
  orphaned: number;
  board: LeadBoardRef;
  boards: LeadBoardRef[];
}

const one = (raw: string | string[] | undefined) => (Array.isArray(raw) ? raw[0] : raw);

/** `/owner/board` with the board and project filters, each dropped when it is the default. */
function boardHref(boardId: string | null, projectId?: string) {
  const q = new URLSearchParams();
  if (boardId) q.set("boardId", boardId);
  if (projectId) q.set("projectId", projectId);
  const s = q.toString();
  return s ? `/owner/board?${s}` : "/owner/board";
}

/**
 * The lead board - now one of several (0136).
 *
 * `?boardId=` picks the board (absent is the Main board, the org's original
 * one); `?projectId=` narrows it, as before. Both are links rather than
 * buttons, so every view is a URL an owner can bookmark or send on, and each
 * board is re-fetched with honest column counts.
 *
 * The board switcher only appears once there is more than one board, so an
 * org that never makes a second one sees the page it always had.
 */
export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const projectId = one(sp.projectId);
  const requestedBoard = one(sp.boardId);
  const boardId = requestedBoard && requestedBoard !== "main" ? requestedBoard : null;

  const query = new URLSearchParams({ perStage: "50", boardId: boardRef(boardId) });
  if (projectId) query.set("projectId", projectId);

  // Concurrent, and the catalogue and the grants are allowed to fail on their
  // own: losing the filter row or the Manage button is survivable, losing the
  // board is not.
  const [result, projects, boardsInfo] = await Promise.all([
    ownerTry<BoardResponse>(`/v1/leads/board?${query}`),
    ownerGet<{ projects: Project[] }>("/v1/projects"),
    ownerGet<{ can: LeadBoardGrants }>("/v1/lead-boards"),
  ]);

  const can = boardsInfo?.can;
  const canManage = Boolean(can && (can.createBoard || can.editBoards || can.deleteBoards));

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Lead board" context="Leads" />
        {result.kind === "notfound" && boardId ? (
          <Card>
            <EmptyState
              title="That board doesn't exist"
              description="It may have been deleted - its leads were moved to another board when it was."
              action={<FilterLink active={false} href="/owner/board">Open the Main board</FilterLink>}
            />
          </Card>
        ) : (
          <LoadFailure what="the lead board" failure={result} />
        )}
      </>
    );
  }
  const data = result.data;
  const catalogue = projects?.projects ?? [];

  return (
    <>
      <PageHeader title="Lead board" context="Leads" />

      <div className="-mt-2 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-text-muted">
          Drag a card to move it, or open one to edit. On a phone, tap a card and pick a stage.
        </p>
        {/* Beside the board rather than in a settings page: the moment somebody
            wants a second board is the moment they are looking at the first. */}
        <div className="flex flex-wrap items-center gap-2">
          {canManage && can ? <ManageLeadBoardsDialog grants={can} /> : null}
          {can?.createLead ? <NewLeadDialog boards={data.boards} /> : null}
        </div>
      </div>

      {data.boards.length > 1 ? (
        <div>
          <MonoLabel>Board</MonoLabel>
          <nav aria-label="Choose a board" className="mt-1.5 flex flex-wrap gap-1.5">
            {data.boards.map((b) => (
              <FilterLink
                key={boardRef(b.id)}
                active={b.id === data.board.id}
                // The project filter travels: "Aura enquiries" means the same
                // thing on every board.
                href={boardHref(b.id, projectId)}
              >
                {b.name}
              </FilterLink>
            ))}
          </nav>
        </div>
      ) : null}

      {catalogue.length > 0 ? (
        <div>
          <MonoLabel>Project</MonoLabel>
          <nav aria-label="Filter by project" className="mt-1.5 flex flex-wrap gap-1.5">
            <FilterLink active={!projectId} href={boardHref(boardId)}>
              All
            </FilterLink>
            {catalogue
              .filter((p) => p.active)
              .map((p) => (
                <FilterLink key={p.id} active={projectId === p.id} href={boardHref(boardId, p.id)}>
                  {p.name}
                </FilterLink>
              ))}
            <FilterLink active={projectId === "none"} href={boardHref(boardId, "none")}>
              Unlabelled
            </FilterLink>
          </nav>
        </div>
      ) : null}

      <Board
        key={boardRef(data.board.id)}
        columns={data.columns}
        stages={data.stages}
        projects={catalogue}
        isMain={data.board.id === null}
      />
    </>
  );
}
