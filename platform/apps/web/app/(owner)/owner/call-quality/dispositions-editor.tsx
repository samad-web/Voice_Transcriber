"use client";

import { useState, useTransition } from "react";
import { useDraftState } from "@/lib/use-server-state";
import { DispositionColor, overQualified, QUALITY_ASSERTING_WARN_AT } from "@aura/shared";
import { Button, Card, Input, MonoLabel, Select, StatusChip, useAlert } from "@aura/ui";
import {
  createDispositionAction,
  updateDispositionAction,
  type Disposition,
} from "./disposition-actions";

const QUALITIES = [
  { value: "", label: "Says nothing about the lead" },
  { value: "hot", label: "Marks the lead Hot" },
  { value: "medium", label: "Marks the lead Medium" },
  { value: "cold", label: "Marks the lead Cold" },
];

/**
 * The tenant's own words for how a call ended (migration 0097).
 *
 * ── WHAT THE WARNING IS FOR ─────────────────────────────────────────────────
 *
 * Every outcome here CAN carry a lead quality, and it is tempting to set one
 * on all of them. That breaks the rating rather than enriching it: on a
 * telecalling floor the most-pressed buttons are "no answer" and "busy", so if
 * those imply cold, the board re-rates itself to cold by Wednesday and
 * temperature becomes a measure of how hard people are to reach.
 *
 * The warning is advisory, not enforced. It is a judgement about how a tenant
 * runs its floor, and this console does not get to overrule that - but it does
 * get to say so once, where the decision is being made.
 *
 * ── AND WHY NOTHING IS DELETED ──────────────────────────────────────────────
 *
 * Retiring hides an outcome from the pickers and leaves it readable on every
 * call that carried it. `calls.disposition_key` stores the key rather than a
 * foreign key for exactly this: a settings edit must not rewrite history.
 */
export function DispositionsEditor({ initial }: { initial: Disposition[] }) {
  const [rows, setRows] = useDraftState(initial);
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const alert = useAlert();

  const warn = overQualified(rows.filter((r) => r.is_active).map((r) => ({ leadQuality: r.lead_quality })));

  const patch = (row: Disposition, update: Record<string, unknown>) => {
    const previous = rows;
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, ...toRow(update) } : r)));
    startTransition(async () => {
      const result = await updateDispositionAction(row.id, update);
      if (result.error) {
        setRows(previous);
        await alert({ title: "Couldn't save that", body: result.error, tone: "danger" });
      }
    });
  };

  const add = () => {
    const label = draft.trim();
    if (!label) return;
    startTransition(async () => {
      const result = await createDispositionAction({ label, sortOrder: rows.length + 1 });
      if (result.error || !result.disposition) {
        await alert({
          title: "Couldn't add that outcome",
          body: result.error ?? "No answer from the API.",
          tone: "danger",
        });
        return;
      }
      setRows((prev) => [...prev, result.disposition!]);
      setDraft("");
    });
  };

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <MonoLabel>Call outcomes</MonoLabel>
        <span className="text-xs text-text-muted">
          {rows.filter((r) => r.is_active).length} in use
        </span>
      </div>

      <p className="max-w-prose text-sm leading-relaxed text-text-muted">
        What your team marks a call as, in your own words. The AI already reads every call and
        proposes an outcome — this is what a person agreed to, and it is the one the reports count.
      </p>

      {warn ? (
        <p className="max-w-prose rounded-md border border-border-strong bg-bg-subtle p-3 text-sm leading-relaxed text-text-muted">
          More than {QUALITY_ASSERTING_WARN_AT} of your outcomes change the lead&rsquo;s rating.
          That usually works out badly: &ldquo;no answer&rdquo; and &ldquo;busy&rdquo; are the
          buttons pressed most on a phone floor, so if those move the rating, the board becomes a
          measure of how hard people are to reach rather than of how good they are.
        </p>
      ) : null}

      <ul className="space-y-1.5">
        {rows.map((row) => (
          <li
            key={row.id}
            className={`flex flex-wrap items-center gap-2 rounded-md border border-border p-2.5 ${
              row.is_active ? "" : "opacity-60"
            }`}
          >
            <Input
              aria-label={`Name for ${row.key}`}
              defaultValue={row.label}
              onBlur={(e) => {
                const label = e.target.value.trim();
                if (label && label !== row.label) patch(row, { label });
              }}
              className="w-48"
            />
            <Select
              aria-label={`What ${row.label} means for the lead`}
              value={row.lead_quality ?? ""}
              onChange={(e) => patch(row, { leadQuality: e.target.value || null })}
              className="w-56"
            >
              {QUALITIES.map((q) => (
                <option key={q.value} value={q.value}>
                  {q.label}
                </option>
              ))}
            </Select>
            <Select
              aria-label={`Colour for ${row.label}`}
              value={row.color ?? "grey"}
              onChange={(e) => patch(row, { color: e.target.value })}
              className="w-28"
            >
              {DispositionColor.options.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
            <span className="flex-1" />
            {!row.is_active ? <StatusChip tone="outline">retired</StatusChip> : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => patch(row, { isActive: !row.is_active })}
            >
              {row.is_active ? "Retire" : "Bring back"}
            </Button>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Add an outcome — e.g. Asked for a quote"
          className="min-w-0 flex-1"
          aria-label="New outcome"
        />
        <Button type="button" onClick={add} disabled={pending || !draft.trim()}>
          Add
        </Button>
      </div>
      <p className="text-xs text-text-muted">
        Retiring an outcome hides it from the buttons and leaves it readable on every call that was
        already marked with it.
      </p>
    </Card>
  );
}

/** Map the API's camelCase patch back onto the row's snake_case shape. */
function toRow(update: Record<string, unknown>): Partial<Disposition> {
  const row: Partial<Disposition> = {};
  if ("label" in update) row.label = update.label as string;
  if ("leadQuality" in update) row.lead_quality = update.leadQuality as Disposition["lead_quality"];
  if ("color" in update) row.color = update.color as string;
  if ("isActive" in update) row.is_active = update.isActive as boolean;
  return row;
}
