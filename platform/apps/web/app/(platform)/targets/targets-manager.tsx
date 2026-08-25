"use client";

import { useState, useTransition } from "react";
import { Button, Card, FormField, Input, MonoLabel, Select, StatusChip } from "@aura/ui";
import { createTargetAction, deleteTargetAction, type SalesTarget } from "./actions";

export interface TeamMember {
  userId: string;
  name: string | null;
  email: string;
}

export interface AttainmentRow {
  targetId: string;
  ownerName: string | null;
  metric: "won_value" | "won_count";
  target: number;
  actual: number;
  ratio: number;
  periodElapsed: number;
  status: string;
}

/** Quarter and month shortcuts, computed in UTC to match the API's date handling. */
function periodFor(kind: "month" | "quarter", now = new Date()): { start: string; end: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (kind === "month") {
    return {
      start: iso(Date.UTC(y, m, 1)),
      // Day 0 of the NEXT month is the last day of this one — no month-length
      // table, and February and leap years come out right for free.
      end: iso(Date.UTC(y, m + 1, 0)),
    };
  }
  const q = Math.floor(m / 3) * 3;
  return { start: iso(Date.UTC(y, q, 1)), end: iso(Date.UTC(y, q + 3, 0)) };
}

const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Set what a person, or the team, is expected to close in a period.
 *
 * ── WHY THE FORM DEFAULTS TO THE WHOLE TEAM ───────────────────────────────
 *
 * Per-person targets only mean anything once deals actually have owners, and
 * `deals.owner_user_id` is nullable and mostly unset on a system whose deals
 * arrive from the call pipeline. A team number works from day one and is the
 * one most people set first; the person picker is there for when ownership is
 * being used.
 */
export function TargetsManager({
  orgId,
  targets,
  members,
  attainment,
}: {
  orgId: string;
  targets: SalesTarget[];
  members: TeamMember[];
  attainment: AttainmentRow[];
}) {
  const quarter = periodFor("quarter");
  const [draft, setDraft] = useState({
    ownerUserId: "",
    periodStart: quarter.start,
    periodEnd: quarter.end,
    metric: "won_value" as "won_value" | "won_count",
    targetValue: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const byTarget = new Map(attainment.map((a) => [a.targetId, a]));

  const submit = () => {
    const value = Number(draft.targetValue);
    if (!Number.isFinite(value) || value <= 0) {
      setError("Give the target a number greater than zero");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await createTargetAction({
        orgId,
        ownerUserId: draft.ownerUserId || null,
        periodStart: draft.periodStart,
        periodEnd: draft.periodEnd,
        metric: draft.metric,
        targetValue: value,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      setDraft({ ...draft, targetValue: "" });
    });
  };

  const remove = (id: string) => {
    startTransition(async () => {
      const result = await deleteTargetAction(id, orgId);
      if (result.error) setError(result.error);
    });
  };

  const setPeriod = (kind: "month" | "quarter") => {
    const p = periodFor(kind);
    setDraft({ ...draft, periodStart: p.start, periodEnd: p.end });
  };

  return (
    <div className="space-y-6">
      <Card>
        <MonoLabel>New target</MonoLabel>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <FormField label="Who" name="target-owner">
            <Select
              value={draft.ownerUserId}
              onChange={(e) => setDraft({ ...draft, ownerUserId: e.target.value })}
            >
              <option value="">The whole team</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name ?? m.email}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField label="Measure" name="target-metric">
            <Select
              value={draft.metric}
              onChange={(e) =>
                setDraft({ ...draft, metric: e.target.value as "won_value" | "won_count" })
              }
            >
              <option value="won_value">Value closed</option>
              <option value="won_count">Deals closed</option>
            </Select>
          </FormField>

          <FormField label="Target" name="target-value">
            <Input
              type="number"
              min={0}
              inputMode="decimal"
              value={draft.targetValue}
              onChange={(e) => setDraft({ ...draft, targetValue: e.target.value })}
              placeholder={draft.metric === "won_count" ? "12" : "500000"}
            />
          </FormField>

          <FormField label="From" name="target-start">
            <Input
              type="date"
              value={draft.periodStart}
              onChange={(e) => setDraft({ ...draft, periodStart: e.target.value })}
            />
          </FormField>

          <FormField label="To" name="target-end">
            <Input
              type="date"
              value={draft.periodEnd}
              onChange={(e) => setDraft({ ...draft, periodEnd: e.target.value })}
            />
          </FormField>

          <div className="flex items-end gap-2">
            {/* Shortcuts rather than a fixed quarter picker: fiscal years start
                in April here and October elsewhere, so the CRM stores two dates
                and offers the common ones instead of having an opinion. */}
            <Button type="button" variant="ghost" size="sm" onClick={() => setPeriod("month")}>
              This month
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setPeriod("quarter")}>
              This quarter
            </Button>
          </div>
        </div>

        {error ? (
          <p
            role="alert"
            className="mt-3 rounded-md border border-danger bg-danger-subtle p-2 text-xs font-medium text-danger-text"
          >
            {error}
          </p>
        ) : null}

        <div className="mt-3">
          <Button type="button" onClick={submit} loading={pending}>
            Set target
          </Button>
        </div>
      </Card>

      <Card>
        <MonoLabel>Current targets</MonoLabel>
        {targets.length === 0 ? (
          <p className="mt-3 text-sm text-text-muted">
            No targets set. Until there is one, every number on the reports page is uncalibrated.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border rounded-md border border-border">
            {targets.map((target) => {
              const hit = byTarget.get(target.id);
              return (
                <li key={target.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-text">
                      {target.owner_name ?? "Whole team"}
                    </span>
                    <span className="mt-0.5 block text-xs text-text-muted tabular-nums">
                      {target.metric === "won_count" ? "Deals" : "Value"} ·{" "}
                      {Number(target.target_value).toLocaleString()} · {target.period_start} →{" "}
                      {target.period_end}
                    </span>
                  </div>
                  {hit ? (
                    <>
                      <span className="text-xs text-text-muted tabular-nums">
                        {Math.round(hit.ratio * 100)}% of {Math.round(hit.periodElapsed * 100)}%
                        elapsed
                      </span>
                      <StatusChip tone={hit.status === "behind" ? "muted" : "solid"}>
                        {hit.status}
                      </StatusChip>
                    </>
                  ) : null}
                  <Button type="button" variant="ghost" size="sm" onClick={() => remove(target.id)}>
                    Delete
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
