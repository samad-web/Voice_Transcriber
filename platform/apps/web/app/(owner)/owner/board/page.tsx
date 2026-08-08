import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import type { BoardColumn, Stage } from "../types";
import { Board } from "./board";

export const metadata: Metadata = { title: "Lead Board — Aura" };

interface BoardResponse {
  columns: BoardColumn[];
  stages: Stage[];
  orphaned: number;
}

export default async function BoardPage() {
  const data = await ownerGet<BoardResponse>("/v1/leads/board?perStage=50");

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

  return (
    <>
      <PageHeader title="Lead Board" context="Pipeline" />
      <p className="-mt-2 text-sm text-text-muted">
        Drag a card to move it, or open one to edit. On a phone, tap a card and
        pick a stage.
      </p>
      <Board columns={data.columns} stages={data.stages} />
    </>
  );
}
