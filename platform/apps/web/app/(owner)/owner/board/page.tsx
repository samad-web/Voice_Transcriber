import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import type { BoardColumn, Project, Stage } from "../types";
import { FilterLink } from "../filter-link";
import { Board } from "./board";

export const metadata: Metadata = { title: "Lead Board" };

interface BoardResponse {
  columns: BoardColumn[];
  stages: Stage[];
  orphaned: number;
}

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const raw = sp.projectId;
  const projectId = Array.isArray(raw) ? raw[0] : raw;

  const query = new URLSearchParams({ perStage: "50" });
  if (projectId) query.set("projectId", projectId);

  // Concurrent, and the catalogue is allowed to fail on its own: losing the
  // filter row is survivable, losing the board is not.
  const [data, projects] = await Promise.all([
    ownerGet<BoardResponse>(`/v1/leads/board?${query}`),
    ownerGet<{ projects: Project[] }>("/v1/projects"),
  ]);

  if (!data) {
    return (
      <>
        <PageHeader title="Lead Board" context="Pipeline" />
        <Card>
          <MonoLabel>Data unavailable</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The platform API did not answer. If this persists, contact your provider.
          </p>
        </Card>
      </>
    );
  }

  const catalogue = projects?.projects ?? [];

  return (
    <>
      <PageHeader title="Lead Board" context="Pipeline" />
      <p className="-mt-2 text-sm text-text-muted">
        Drag a card to move it, or open one to edit. On a phone, tap a card and
        pick a stage.
      </p>

      {/* Links rather than buttons: the filter is server-side, so each option
          is a real URL an owner can bookmark or send on, and the board is
          re-fetched with honest per-column counts instead of the full board
          being filtered in the browser. */}
      {catalogue.length > 0 ? (
        <div>
          <MonoLabel>Project</MonoLabel>
          <nav aria-label="Filter by project" className="mt-1.5 flex flex-wrap gap-1.5">
            <FilterLink active={!projectId} href="/owner/board">
              All
            </FilterLink>
            {catalogue
              .filter((p) => p.active)
              .map((p) => (
                <FilterLink
                  key={p.id}
                  active={projectId === p.id}
                  href={`/owner/board?projectId=${p.id}`}
                >
                  {p.name}
                </FilterLink>
              ))}
            <FilterLink active={projectId === "none"} href="/owner/board?projectId=none">
              Unlabelled
            </FilterLink>
          </nav>
        </div>
      ) : null}

      <Board columns={data.columns} stages={data.stages} projects={catalogue} />
    </>
  );
}
