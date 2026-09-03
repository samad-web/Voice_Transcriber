"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileSpreadsheet, LayoutTemplate, Plus } from "lucide-react";
import { Button, Card, Dialog, FormField, Input, MonoLabel, Select, StatusChip } from "@aura/ui";
import { createDatasetAction, createReportAction } from "./actions";
import type { CatalogueEntry, DatasetRow, TemplateRow } from "./types";

/**
 * Starting a report.
 *
 * ── WHY THIS IS NOT A "NEW REPORT" BUTTON ───────────────────────────────
 *
 * The prompt (3.5.1) is blunt about it: "A blank drag-and-drop canvas is not a
 * workable starting point for a first-time user." So the primary affordance is
 * the template gallery, and Blank is one card in it rather than the default.
 *
 * ── THE ONE-CLICK PATH (ACCEPTANCE CRITERION 18) ────────────────────────
 *
 * Each template declares the dataset ROLES it needs, and each role names a
 * `suggestedSourceKey` - a CRM source that is already there, live, needing no
 * upload. So picking "Lead funnel" pre-fills its `leads` role with the CRM
 * leads source, and Create produces a populated report immediately. The user
 * can still swap any role for an uploaded CSV before creating; the point is
 * that the zero-decision path ends in real numbers rather than in an empty
 * canvas.
 *
 * A CRM source only becomes bindable once it exists as a `report_datasets`
 * row, so choosing one the tenant has not saved yet creates it on the way
 * through - the user should not have to understand that distinction.
 */
export function NewReportLauncher({
  templates,
  datasets,
  catalogue,
}: {
  templates: TemplateRow[];
  datasets: DatasetRow[];
  catalogue: CatalogueEntry[];
}) {
  const router = useRouter();
  const [picked, setPicked] = useState<TemplateRow | null>(null);
  const [name, setName] = useState("");
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /** A saved dataset for this CRM source key, if the tenant already has one. */
  const existingFor = (sourceKey: string) =>
    datasets.find((d) => d.kind === "crm" && d.source_key === sourceKey);

  const open = (template: TemplateRow) => {
    setError(null);
    setPicked(template);
    setName(template.name);
    // Pre-fill each role with a dataset the tenant already has, or with the
    // literal source key - resolved into a real dataset on create.
    const initial: Record<string, string> = {};
    for (const role of template.dataset_roles ?? []) {
      const suggested = role.suggestedSourceKey;
      if (!suggested) continue;
      initial[role.role] = existingFor(suggested)?.id ?? `crm:${suggested}`;
    }
    setBindings(initial);
  };

  const create = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the report a name");
      return;
    }
    setError(null);

    startTransition(async () => {
      // Resolve any `crm:<key>` placeholder into a real dataset first. Done
      // here rather than server-side because it is a UI convenience, not a
      // contract - the API's create endpoint takes dataset ids, and keeping it
      // that way means a template cannot be used to conjure datasets.
      const resolved: Record<string, string> = {};
      for (const [role, value] of Object.entries(bindings)) {
        if (!value) continue;
        if (!value.startsWith("crm:")) {
          resolved[role] = value;
          continue;
        }
        const sourceKey = value.slice(4);
        const created = await createDatasetAction({ kind: "crm", sourceKey });
        if (created.error || !created.data) {
          setError(created.error ?? "Could not connect that data source");
          return;
        }
        resolved[role] = created.data.dataset.id;
      }

      const result = await createReportAction({
        name: trimmed,
        templateId: picked?.key === "blank" ? picked.id : picked?.id,
        datasetByRole: resolved,
      });
      if (result.error || !result.data) {
        setError(result.error ?? "Could not create the report");
        return;
      }
      setPicked(null);
      router.push(`/owner/reports/builder/${result.data.report.id}`);
    });
  };

  const roles = picked?.dataset_roles ?? [];

  return (
    <>
      <Card>
        <MonoLabel>Start from a template</MonoLabel>
        <p className="mt-1 text-xs text-text-muted">
          Each one arrives with its widgets laid out and labelled with the kind of column they
          want. Pick the closest fit and change it - that is faster than starting from nothing.
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {templates.map((template) => (
            <button
              key={template.id}
              type="button"
              onClick={() => open(template)}
              className="group flex h-full flex-col rounded-md border border-border bg-surface p-3 text-left transition-colors hover:border-border-strong hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <span className="flex items-center gap-2">
                {template.key === "blank" ? (
                  <Plus className="size-4 text-text-muted" aria-hidden="true" />
                ) : (
                  <LayoutTemplate className="size-4 text-accent-text" aria-hidden="true" />
                )}
                <span className="text-sm font-medium text-text">{template.name}</span>
              </span>
              {template.description ? (
                <span className="mt-1 flex-1 text-xs leading-snug text-text-muted">
                  {template.description}
                </span>
              ) : null}
              <span className="mt-2 flex flex-wrap gap-1">
                {template.is_global ? null : <StatusChip tone="muted">yours</StatusChip>}
                {(template.dataset_roles ?? []).map((role) => (
                  <StatusChip key={role.role} tone="outline">
                    {role.label}
                  </StatusChip>
                ))}
              </span>
            </button>
          ))}
        </div>
      </Card>

      <Dialog
        open={picked !== null}
        onClose={() => setPicked(null)}
        title={picked ? `New report from "${picked.name}"` : "New report"}
        description={
          roles.length > 0
            ? "Point each part of the template at your data. The suggested source is live CRM data - nothing to upload."
            : "A blank page. You can add widgets and connect data once it opens."
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setPicked(null)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={create} disabled={pending}>
              {pending ? "Creating…" : "Create report"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <FormField label="Report name" name="report-name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Weekly pipeline review"
            />
          </FormField>

          {roles.map((role) => (
            <FormField
              key={role.role}
              label={role.label}
              name={`role-${role.role}`}
              hint={role.hint}
            >
              <Select
                value={bindings[role.role] ?? ""}
                onChange={(e) =>
                  setBindings((prev) => ({ ...prev, [role.role]: e.target.value }))
                }
              >
                <option value="">Choose later</option>
                {role.suggestedSourceKey &&
                !existingFor(role.suggestedSourceKey) &&
                catalogue.some((c) => c.key === role.suggestedSourceKey) ? (
                  <option value={`crm:${role.suggestedSourceKey}`}>
                    {catalogue.find((c) => c.key === role.suggestedSourceKey)?.name} (live CRM data)
                  </option>
                ) : null}
                {datasets.map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>
                    {dataset.name}
                    {dataset.kind === "upload" ? ` (${dataset.row_count} rows)` : " (live CRM data)"}
                  </option>
                ))}
              </Select>
            </FormField>
          ))}

          {roles.length > 0 ? (
            <p className="flex items-start gap-2 rounded-md bg-bg-subtle p-2 text-xs text-text-muted">
              <FileSpreadsheet className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>
                Need to chart something that is not in the CRM? Create the report first, then add a
                CSV under <span className="font-medium text-text">Manage data sources</span> and
                re-point any widget at it.
              </span>
            </p>
          ) : null}

          {error ? <p className="text-xs text-danger-text">{error}</p> : null}
        </div>
      </Dialog>
    </>
  );
}
