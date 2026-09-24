"use client";

import type { Dispatch, SetStateAction } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { Button, Input, StatusChip } from "@aura/ui";

export interface StageValue {
  key: string;
  label: string;
  terminal?: "won" | "lost";
}

/** One row being edited. `key` is null for a stage added in this session. */
export interface StageDraft {
  id: string;
  key: string | null;
  label: string;
  terminal?: "won" | "lost";
}

/** LeadStages and PipelineStages in @aura/shared both cap at 16. */
export const MAX_STAGES = 16;

/**
 * A stage key for a new column, from its label: snake_case, starting with a
 * letter, at most 40 characters, and not already used - the rules both the
 * lead and the deal stage schemas enforce.
 */
export function stageKeyFor(label: string, taken: ReadonlySet<string>): string {
  let base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 34);
  if (!/^[a-z]/.test(base)) base = `stage_${base}`.replace(/_+$/, "").slice(0, 34);
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
  return key;
}

export function draftsFromStages(stages: readonly StageValue[]): StageDraft[] {
  return stages.map((s) => ({ id: s.key, key: s.key, label: s.label, terminal: s.terminal }));
}

/**
 * Check the drafts and turn them into a saveable stage list, minting keys for
 * new columns. Existing columns keep their key - renaming a column changes its
 * words, never what every card, report and history row points at.
 */
export function stagesFromDrafts(rows: readonly StageDraft[]): { stages: StageValue[] } | { error: string } {
  const labels = rows.map((r) => r.label.trim());
  if (labels.some((l) => !l)) return { error: "Every column needs a name." };
  if (labels.some((l) => l.length > 60)) return { error: "Column names can be at most 60 characters." };
  const seen = new Set<string>();
  for (const l of labels) {
    if (seen.has(l.toLowerCase())) return { error: `Two columns are called "${l}". Give each one its own name.` };
    seen.add(l.toLowerCase());
  }
  if (!rows.some((r) => !r.terminal)) return { error: "Keep at least one column that isn't Won or Lost." };

  const taken = new Set(rows.flatMap((r) => (r.key ? [r.key] : [])));
  const stages = rows.map((r) => {
    const key = r.key ?? stageKeyFor(r.label, taken);
    taken.add(key);
    return { key, label: r.label.trim(), ...(r.terminal ? { terminal: r.terminal } : {}) };
  });
  return { stages };
}

const ICON_BUTTON =
  "inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-text-muted transition-colors duration-150 ease-out hover:bg-surface-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-40";

/**
 * The column list of a board being reshaped: rename, reorder, add, remove.
 * Shared by the deal board's "Manage board" and the lead boards dialog, which
 * differ only in what their cards are called and how they save.
 *
 * Remove is refused for a column that still holds cards (the count is shown
 * beside it), and an unknown count is treated as "has cards" - never offer a
 * delete we cannot yet show is safe. Won and Lost markers are not editable: a
 * card's won/lost status is set when it moves INTO a column, so re-marking a
 * column would leave the cards already in it counted wrong.
 */
export function StageListEditor({
  rows,
  setRows,
  counts,
  noun,
}: {
  rows: StageDraft[];
  setRows: Dispatch<SetStateAction<StageDraft[]>>;
  /** Cards per existing stage key; null while still loading. */
  counts: Record<string, number> | null;
  /** Singular name for a card: "deal", "lead". */
  noun: string;
}) {
  const plural = (n: number) => `${n} ${noun}${n === 1 ? "" : "s"}`;

  const move = (i: number, by: -1 | 1) =>
    setRows((prev) => {
      const next = [...prev];
      const j = i + by;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const add = () =>
    setRows((prev) => {
      // New columns go before Won/Lost, where open work lives.
      const at = prev.findIndex((r) => r.terminal);
      const row: StageDraft = { id: `new-${Date.now()}`, key: null, label: "" };
      return at === -1 ? [...prev, row] : [...prev.slice(0, at), row, ...prev.slice(at)];
    });

  return (
    <div className="space-y-3">
      <ol className="space-y-2">
        {rows.map((row, i) => {
          const n = row.key && counts ? (counts[row.key] ?? 0) : 0;
          const blockedBy = n > 0 ? `${plural(n)} still in this column - move them first` : null;
          return (
            <li key={row.id} className="flex items-center gap-2">
              <div className="flex flex-col gap-0.5">
                <button
                  type="button"
                  className={ICON_BUTTON}
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  aria-label={`Move "${row.label || "new column"}" up`}
                >
                  <ChevronUp aria-hidden="true" className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  className={ICON_BUTTON}
                  onClick={() => move(i, 1)}
                  disabled={i === rows.length - 1}
                  aria-label={`Move "${row.label || "new column"}" down`}
                >
                  <ChevronDown aria-hidden="true" className="h-4 w-4" />
                </button>
              </div>
              <div className="min-w-0 flex-1">
                <Input
                  value={row.label}
                  onChange={(e) =>
                    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, label: e.target.value } : r)))
                  }
                  placeholder="Column name"
                  maxLength={60}
                  aria-label={`Column ${i + 1} name`}
                  autoFocus={row.key === null}
                />
              </div>
              <span className="w-20 shrink-0 text-right text-xs text-text-muted tabular-nums">
                {row.terminal ? (
                  <StatusChip tone="outline">{row.terminal === "won" ? "Won" : "Lost"}</StatusChip>
                ) : row.key === null ? (
                  "New"
                ) : counts === null ? (
                  "…"
                ) : (
                  plural(n)
                )}
              </span>
              <button
                type="button"
                className={ICON_BUTTON}
                onClick={() => setRows((prev) => prev.filter((r) => r.id !== row.id))}
                disabled={Boolean(blockedBy) || (row.key !== null && counts === null) || rows.length <= 1}
                title={blockedBy ?? undefined}
                aria-label={
                  blockedBy ? `Can't remove "${row.label}": ${blockedBy}` : `Remove "${row.label || "new column"}"`
                }
              >
                <Trash2 aria-hidden="true" className="h-4 w-4" />
              </button>
            </li>
          );
        })}
      </ol>

      <Button variant="secondary" size="sm" onClick={add} disabled={rows.length >= MAX_STAGES}>
        <Plus aria-hidden="true" className="h-4 w-4" />
        Add column
      </Button>
      {rows.length >= MAX_STAGES ? (
        <p className="text-xs text-text-muted">A board can have at most {MAX_STAGES} columns.</p>
      ) : null}
    </div>
  );
}
