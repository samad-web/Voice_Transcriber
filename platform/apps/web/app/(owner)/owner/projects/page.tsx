import type { Metadata } from "next";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { ownerTry, requireFeature } from "@/lib/owner-context";
import type { Project } from "../types";
import { ProjectsClient } from "./projects-client";

export const metadata: Metadata = { title: "Projects" };

export default async function ProjectsPage() {
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/projects");
  const result = await ownerTry<{ projects: Project[] }>("/v1/projects");

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Projects" context="Pipeline" />
        <LoadFailure what="your projects" failure={result} />
      </>
    );
  }
  const data = result.data;

  return (
    <>
      <PageHeader title="Projects" context="Pipeline" />
      <p className="-mt-2 max-w-2xl text-sm text-text-muted">
        What you sell. Every recorded call is matched against this list, and the lead it produces is
        labelled with whichever project the conversation was about - so a board filtered to one
        project shows only that pipeline. Add the words people actually say on the phone as
        alternatives; that is what the matching runs on.
      </p>
      <ProjectsClient projects={data.projects} />
    </>
  );
}
