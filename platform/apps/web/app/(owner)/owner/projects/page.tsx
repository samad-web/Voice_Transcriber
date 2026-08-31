import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import type { Project } from "../types";
import { ProjectsClient } from "./projects-client";

export const metadata: Metadata = { title: "Projects — Aura" };

export default async function ProjectsPage() {
  const data = await ownerGet<{ projects: Project[] }>("/v1/projects");

  if (!data) {
    return (
      <>
        <PageHeader title="Projects" context="Pipeline" />
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
      <PageHeader title="Projects" context="Pipeline" />
      <p className="-mt-2 max-w-2xl text-sm text-text-muted">
        What you sell. Every recorded call is matched against this list, and the
        lead it produces is labelled with whichever project the conversation was
        about — so a board filtered to one project shows only that pipeline. Add
        the words people actually say on the phone as alternatives; that is what
        the matching runs on.
      </p>
      <ProjectsClient projects={data.projects} />
    </>
  );
}
