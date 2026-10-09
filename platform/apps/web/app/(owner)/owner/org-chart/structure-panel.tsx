"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, ErrorBanner, FormField, Input, Select, useConfirm, useToast } from "@aura/ui";
import { AVATAR_TONES, avatarToneFor } from "@aura/shared";
import {
  createDepartmentAction,
  createTeamAction,
  deleteDepartmentAction,
  deleteTeamAction,
  updateDepartmentAction,
  updateTeamAction,
} from "./actions";
import type { DepartmentRow, TeamRow } from "./types";

/**
 * The tone swatches, as STATIC class strings.
 *
 * `bg-label-${tone}` would be invisible to Tailwind, which scans source text
 * for complete class names and generates nothing for one assembled at
 * runtime - so every swatch would render transparent. `project-chip.tsx`
 * keeps the same kind of map for the same reason.
 */
const TONE_SWATCH: Record<string, string> = {
  violet: "bg-label-violet",
  plum: "bg-label-plum",
  teal: "bg-label-teal",
  steel: "bg-label-steel",
};

/**
 * Departments and teams — the configuration the chart's filters and pickers
 * read (Build docs/org-chart-build-plan.md §4.1).
 *
 * ── A PANEL ON THE CHART, NOT A PAGE OF ITS OWN ────────────────────────────
 *
 * Both are optional on a position, deliberately: §13's M4 is "an owner can
 * build a 3-level org from scratch", and demanding a department first would
 * put a taxonomy decision between somebody and their first seat. A nine-person
 * business has no departments and should never be asked to invent them.
 *
 * So this is not a destination. It opens from the chart's toolbar, beside the
 * filters it feeds, and closes again — which is also why it needs no nav
 * entry, no `loading.tsx` and no feature href of its own.
 *
 * ── DELETING A DEPARTMENT DOES NOT DELETE ITS POSITIONS ────────────────────
 *
 * 0177's foreign key is `ON DELETE SET NULL`, so the seats survive with no
 * department. That is the only safe default — a CASCADE would mean deleting
 * "Commercial" removed forty seats, their reporting lines and their assignment
 * history on one click — and the confirm below says so in those words, because
 * it is the one thing somebody pressing it needs to know and cannot guess.
 */

export interface StructurePanelProps {
  departments: DepartmentRow[];
  teams: TeamRow[];
  /** `position:create` / `:edit` / `:delete`. The API re-checks all three. */
  canEdit: boolean;
  canDelete: boolean;
  /** The seats a team's lead can be chosen from. */
  positions: { id: string; title: string }[];
  onClose: () => void;
}

export function StructurePanel({
  departments,
  teams,
  canEdit,
  canDelete,
  positions,
  onClose,
}: StructurePanelProps) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const [newDepartment, setNewDepartment] = useState("");
  const [newDepartmentTone, setNewDepartmentTone] = useState("");
  const [newTeam, setNewTeam] = useState("");
  const [newTeamDepartment, setNewTeamDepartment] = useState("");

  const run = (work: () => Promise<{ error?: string }>, done: string) =>
    start(async () => {
      const result = await work();
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      toast(done);
      router.refresh();
    });

  return (
    <section
      aria-label="Departments and teams"
      className="space-y-5 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-text">Departments and teams</h2>
          <p className="mt-0.5 text-xs text-text-muted">
            Optional. They group the chart and drive its filters — a small business can leave both
            empty.
          </p>
        </div>
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {/* ── Departments ──────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">
          Departments
        </h3>

        {departments.length === 0 ? (
          <p className="text-sm text-text-muted">None yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {departments.map((department) => (
              <DepartmentRowEditor
                key={department.id}
                department={department}
                departments={departments}
                canEdit={canEdit}
                canDelete={canDelete}
                pending={pending}
                onSave={(patch) =>
                  run(() => updateDepartmentAction(department.id, patch), "Department saved.")
                }
                onDelete={async () => {
                  const ok = await confirm({
                    title: `Delete ${department.name}?`,
                    body:
                      department.positions > 0
                        ? `${department.positions} position${department.positions === 1 ? "" : "s"} will stay on the chart with no department. Nothing is removed from the chart itself.`
                        : "Nothing is using it.",
                    confirmLabel: "Delete it",
                    tone: "danger",
                    // Not an irreversible wipe - the positions survive with no
                    // department - so the type-to-confirm gate `danger` turns on
                    // by default is more friction than the act deserves.
                    requireTyped: false,
                  });
                  if (ok) {
                    run(() => deleteDepartmentAction(department.id), "Department deleted.");
                  }
                }}
              />
            ))}
          </ul>
        )}

        {canEdit ? (
          <div className="flex flex-wrap items-end gap-2">
            <FormField label="New department" name="newDepartment">
              <Input
                value={newDepartment}
                maxLength={120}
                placeholder="Commercial"
                onChange={(event) => setNewDepartment(event.target.value)}
              />
            </FormField>
            <FormField
              label="Colour"
              name="newDepartmentTone"
              hint="Left to itself, one is picked from the name."
            >
              <Select
                value={newDepartmentTone}
                onChange={(event) => setNewDepartmentTone(event.target.value)}
              >
                <option value="">Automatic</option>
                {AVATAR_TONES.map((tone) => (
                  <option key={tone} value={tone}>
                    {tone}
                  </option>
                ))}
              </Select>
            </FormField>
            <Button
              disabled={pending || !newDepartment.trim()}
              onClick={() =>
                run(async () => {
                  const result = await createDepartmentAction({
                    name: newDepartment.trim(),
                    colorTag: newDepartmentTone || null,
                  });
                  if (!result.error) {
                    setNewDepartment("");
                    setNewDepartmentTone("");
                  }
                  return result;
                }, "Department added.")
              }
            >
              Add
            </Button>
          </div>
        ) : null}
      </div>

      {/* ── Teams ────────────────────────────────────────────────────────── */}
      <div className="space-y-2 border-t border-border pt-4">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">Teams</h3>

        {teams.length === 0 ? (
          <p className="text-sm text-text-muted">None yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {teams.map((team) => (
              <TeamRowEditor
                key={team.id}
                team={team}
                departments={departments}
                positions={positions}
                canEdit={canEdit}
                canDelete={canDelete}
                pending={pending}
                onSave={(patch) => run(() => updateTeamAction(team.id, patch), "Team saved.")}
                onDelete={async () => {
                  const ok = await confirm({
                    title: `Delete ${team.name}?`,
                    body:
                      team.positions > 0
                        ? `${team.positions} position${team.positions === 1 ? "" : "s"} will stay on the chart with no team.`
                        : "Nothing is using it.",
                    confirmLabel: "Delete it",
                    tone: "danger",
                    // Not an irreversible wipe - the positions survive with no
                    // department - so the type-to-confirm gate `danger` turns on
                    // by default is more friction than the act deserves.
                    requireTyped: false,
                  });
                  if (ok) run(() => deleteTeamAction(team.id), "Team deleted.");
                }}
              />
            ))}
          </ul>
        )}

        {canEdit ? (
          <div className="flex flex-wrap items-end gap-2">
            <FormField label="New team" name="newTeam">
              <Input
                value={newTeam}
                maxLength={120}
                placeholder="South region"
                onChange={(event) => setNewTeam(event.target.value)}
              />
            </FormField>
            <FormField label="In department" name="newTeamDepartment">
              <Select
                value={newTeamDepartment}
                onChange={(event) => setNewTeamDepartment(event.target.value)}
              >
                <option value="">None</option>
                {departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <Button
              disabled={pending || !newTeam.trim()}
              onClick={() =>
                run(async () => {
                  const result = await createTeamAction({
                    name: newTeam.trim(),
                    departmentId: newTeamDepartment || null,
                  });
                  if (!result.error) {
                    setNewTeam("");
                    setNewTeamDepartment("");
                  }
                  return result;
                }, "Team added.")
              }
            >
              Add
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────────────────

function DepartmentRowEditor({
  department,
  departments,
  canEdit,
  canDelete,
  pending,
  onSave,
  onDelete,
}: {
  department: DepartmentRow;
  departments: DepartmentRow[];
  canEdit: boolean;
  canDelete: boolean;
  pending: boolean;
  onSave: (patch: Record<string, unknown>) => void;
  onDelete: () => Promise<void>;
}) {
  const [name, setName] = useState(department.name);
  const [parent, setParent] = useState(department.parentDepartmentId ?? "");
  const tone = department.colorTag ?? avatarToneFor(department.name);
  const dirty = name !== department.name || parent !== (department.parentDepartmentId ?? "");

  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <span
        aria-hidden
        className={`size-3 shrink-0 rounded-full border border-border ${TONE_SWATCH[tone] ?? TONE_SWATCH.steel}`}
        title={tone}
      />
      {canEdit ? (
        <>
          <Input
            aria-label={`Rename ${department.name}`}
            className="w-40"
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
          />
          <Select
            aria-label={`Parent department of ${department.name}`}
            className="w-40"
            value={parent}
            onChange={(event) => setParent(event.target.value)}
          >
            <option value="">No parent</option>
            {departments
              // A department cannot be its own parent, which the API also
              // refuses - offering it would be a picker whose only effect is a
              // 400.
              .filter((candidate) => candidate.id !== department.id)
              .map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
          </Select>
        </>
      ) : (
        <span className="w-40 truncate text-sm text-text">{department.name}</span>
      )}
      <span className="text-xs text-text-muted">
        {department.positions} position{department.positions === 1 ? "" : "s"}
      </span>
      <span className="ml-auto flex gap-1">
        {canEdit && dirty ? (
          <Button
            variant="secondary"
            disabled={pending || !name.trim()}
            onClick={() => onSave({ name: name.trim(), parentDepartmentId: parent || null })}
          >
            Save
          </Button>
        ) : null}
        {canDelete ? (
          <Button variant="ghost" disabled={pending} onClick={() => void onDelete()}>
            Delete
          </Button>
        ) : null}
      </span>
    </li>
  );
}

function TeamRowEditor({
  team,
  departments,
  positions,
  canEdit,
  canDelete,
  pending,
  onSave,
  onDelete,
}: {
  team: TeamRow;
  departments: DepartmentRow[];
  positions: { id: string; title: string }[];
  canEdit: boolean;
  canDelete: boolean;
  pending: boolean;
  onSave: (patch: Record<string, unknown>) => void;
  onDelete: () => Promise<void>;
}) {
  const [name, setName] = useState(team.name);
  const [departmentId, setDepartmentId] = useState(team.departmentId ?? "");
  const [leadPositionId, setLeadPositionId] = useState(team.leadPositionId ?? "");
  const dirty =
    name !== team.name ||
    departmentId !== (team.departmentId ?? "") ||
    leadPositionId !== (team.leadPositionId ?? "");

  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      {canEdit ? (
        <>
          <Input
            aria-label={`Rename ${team.name}`}
            className="w-36"
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
          />
          <Select
            aria-label={`Department of ${team.name}`}
            className="w-36"
            value={departmentId}
            onChange={(event) => setDepartmentId(event.target.value)}
          >
            <option value="">No department</option>
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </Select>
          {/*
            The team's lead is a SEAT, not a person - same §1.1 reasoning as
            everything else here: a team whose lead resigned still has a lead
            position, now vacant.
          */}
          <Select
            aria-label={`Lead position of ${team.name}`}
            className="w-44"
            value={leadPositionId}
            onChange={(event) => setLeadPositionId(event.target.value)}
          >
            <option value="">No lead position</option>
            {positions.map((position) => (
              <option key={position.id} value={position.id}>
                {position.title}
              </option>
            ))}
          </Select>
        </>
      ) : (
        <span className="w-36 truncate text-sm text-text">{team.name}</span>
      )}
      <span className="text-xs text-text-muted">
        {team.positions} position{team.positions === 1 ? "" : "s"}
      </span>
      <span className="ml-auto flex gap-1">
        {canEdit && dirty ? (
          <Button
            variant="secondary"
            disabled={pending || !name.trim()}
            onClick={() =>
              onSave({
                name: name.trim(),
                departmentId: departmentId || null,
                leadPositionId: leadPositionId || null,
              })
            }
          >
            Save
          </Button>
        ) : null}
        {canDelete ? (
          <Button variant="ghost" disabled={pending} onClick={() => void onDelete()}>
            Delete
          </Button>
        ) : null}
      </span>
    </li>
  );
}
