"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Plus, X } from "lucide-react";
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  FormField,
  Input,
  MonoLabel,
  Select,
  StatusChip,
  useAlert,
} from "@aura/ui";
import { ProjectChip, PROJECT_COLORS } from "../project-chip";
import { formatValue } from "../types";
import type { Project } from "../types";
import { createProjectAction, updateProjectAction } from "./actions";

const BLANK = { name: "", description: "", color: "", aliases: [""] };

/**
 * The project catalogue.
 *
 * Archiving rather than deleting is the only lifecycle offered, and that is
 * deliberate: `crm_projects` is referenced by every lead, deal and call it has
 * ever labelled, so a delete would either cascade away history or leave the
 * label dangling. Archiving stops a project being detected or offered on new
 * work and leaves every record that already carries it intact.
 */
export function ProjectsClient({ projects: initial }: { projects: Project[] }) {
  const [projects, setProjects] = useState(initial);
  const [editing, setEditing] = useState<Project | "new" | null>(null);
  const [draft, setDraft] = useState(BLANK);
  const [pending, startTransition] = useTransition();
  const alert = useAlert();

  useEffect(() => setProjects(initial), [initial]);

  const open = (project: Project | "new") => {
    setEditing(project);
    setDraft(
      project === "new"
        ? BLANK
        : {
            name: project.name,
            description: project.description ?? "",
            color: project.color ?? "",
            // A trailing blank row so there is always somewhere to type,
            // rather than making the user find an "add" button first.
            aliases: [...project.aliases, ""],
          },
    );
  };

  const save = () => {
    const name = draft.name.trim();
    if (!name) {
      void alert({
        title: "Couldn't save the project",
        body: "A project needs a name",
        tone: "danger",
      });
      return;
    }
    const payload = {
      name,
      description: draft.description.trim() || null,
      color: draft.color || null,
      aliases: draft.aliases.map((a) => a.trim()).filter(Boolean),
    };

    startTransition(async () => {
      const result =
        editing === "new"
          ? await createProjectAction(payload)
          : await updateProjectAction((editing as Project).id, payload);

      if (result.error || !result.project) {
        await alert({
          title: "Couldn't save the project",
          body: result.error ?? "Save failed",
          tone: "danger",
        });
        return;
      }
      const saved = result.project;
      setProjects((prev) => {
        const without = prev.filter((p) => p.id !== saved.id);
        // The POST/PATCH response has no counts on it - it is the row, not the
        // list - so the previous row's totals are carried over rather than
        // being shown as zero until the next full load.
        const previous = prev.find((p) => p.id === saved.id);
        return [
          ...without,
          {
            ...saved,
            lead_count: previous?.lead_count ?? 0,
            open_count: previous?.open_count ?? 0,
            won_value: previous?.won_value ?? 0,
            call_count: previous?.call_count ?? 0,
          },
        ].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
      });
      setEditing(null);
    });
  };

  const toggleActive = (project: Project) => {
    startTransition(async () => {
      const result = await updateProjectAction(project.id, { active: !project.active });
      if (result.error) {
        await alert({
          title: project.active
            ? "Couldn't archive the project"
            : "Couldn't restore the project",
          body: result.error,
          tone: "danger",
        });
        return;
      }
      setProjects((prev) =>
        prev.map((p) => (p.id === project.id ? { ...p, active: !p.active } : p)),
      );
    });
  };

  const setAlias = (index: number, value: string) => {
    setDraft((d) => {
      const aliases = [...d.aliases];
      aliases[index] = value;
      // Keep exactly one empty row at the end, so the list grows as it is
      // filled instead of needing a button per row.
      if (index === aliases.length - 1 && value.trim()) aliases.push("");
      return { ...d, aliases };
    });
  };

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <MonoLabel>{projects.length} project{projects.length === 1 ? "" : "s"}</MonoLabel>
        <Button type="button" onClick={() => open("new")}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          New project
        </Button>
      </div>

      {projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Add the things you sell - a 3D website, an analytics agent - and calls will start being labelled with whichever one they were about."
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <Card key={project.id} className={`space-y-3 ${project.active ? "" : "opacity-60"}`}>
              <div className="flex items-start justify-between gap-2">
                <ProjectChip name={project.name} color={project.color} />
                <StatusChip tone={project.active ? "outline" : "muted"}>
                  {project.active ? "Active" : "Archived"}
                </StatusChip>
              </div>

              {project.description ? (
                <p className="line-clamp-2 text-xs leading-relaxed text-text-muted">
                  {project.description}
                </p>
              ) : null}

              {project.aliases.length > 0 ? (
                <p className="text-xs text-text-subtle">
                  Also heard as: {project.aliases.join(", ")}
                </p>
              ) : null}

              <dl className="grid grid-cols-3 gap-2 border-t border-border pt-3 text-xs">
                <div>
                  <dt className="text-text-muted">Leads</dt>
                  <dd className="mt-0.5 font-medium text-text tabular-nums">
                    {project.lead_count}
                  </dd>
                </div>
                <div>
                  <dt className="text-text-muted">Open</dt>
                  <dd className="mt-0.5 font-medium text-text tabular-nums">
                    {project.open_count}
                  </dd>
                </div>
                <div>
                  <dt className="text-text-muted">Won</dt>
                  <dd className="mt-0.5 font-medium text-text tabular-nums">
                    {formatValue(project.won_value)}
                  </dd>
                </div>
              </dl>

              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="secondary" size="sm" onClick={() => open(project)}>
                  Edit
                </Button>
                {project.lead_count > 0 ? (
                  <Link
                    href={`/owner/leads?projectId=${project.id}`}
                    className="text-xs font-medium text-accent-text underline underline-offset-2"
                  >
                    View leads
                  </Link>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => toggleActive(project)}
                  className="ml-auto"
                >
                  {project.active ? "Archive" : "Restore"}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "New project" : "Edit project"}
        description="The name and the alternatives below are what call transcripts are matched against."
        footer={
          <div className="flex items-center gap-2">
            <Button type="button" onClick={save} loading={pending}>
              Save
            </Button>
            <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <FormField label="Name" name="project-name">
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              maxLength={120}
              placeholder="3D Website"
            />
          </FormField>

          <FormField label="Description" name="project-description">
            <Input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              maxLength={2000}
              placeholder="Immersive product pages with a 3D viewer"
            />
          </FormField>

          <FormField label="Colour" name="project-color">
            <Select
              value={draft.color}
              onChange={(e) => setDraft({ ...draft, color: e.target.value })}
            >
              <option value="">Automatic</option>
              {PROJECT_COLORS.map((c) => (
                <option key={c} value={c}>
                  {c[0].toUpperCase() + c.slice(1)}
                </option>
              ))}
            </Select>
          </FormField>

          <div className="space-y-2">
            <MonoLabel>Also heard as</MonoLabel>
            <p className="text-xs text-text-muted">
              The name is matched automatically. Add anything else people say -
              &ldquo;3d site&rdquo;, &ldquo;three d website&rdquo; - one per row.
            </p>
            {draft.aliases.map((alias, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={alias}
                  onChange={(e) => setAlias(i, e.target.value)}
                  maxLength={80}
                  aria-label={`Alternative name ${i + 1}`}
                  placeholder="3d site"
                />
                {alias ? (
                  <button
                    type="button"
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        aliases: d.aliases.filter((_, j) => j !== i),
                      }))
                    }
                    aria-label={`Remove ${alias}`}
                    className="rounded-sm p-1.5 text-text-muted transition-colors duration-150 ease-out hover:text-text"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </Dialog>
    </>
  );
}
