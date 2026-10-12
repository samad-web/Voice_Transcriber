"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { Button, Card, Checkbox, Input, MonoLabel, Select, StatusChip } from "@aura/ui";
import { saveKpiConfigAction } from "./actions";

export interface CatalogKpi {
  key: string;
  label: string;
  blurb: string;
  category: string;
  unit: string;
  direction: "higher" | "lower";
  identity: "telecaller" | "user";
  minBase: number | null;
  dataNeeded: string;
  status: "ready" | "partial" | "missing";
  selected: boolean;
}

export interface ExistingConfig {
  kpi_key: string;
  scope_kind: string;
  target_value: string | null;
  period: string;
  weight_pct: number;
  effective_from: string;
  effective_to: string | null;
}

interface Draft {
  kpiKey: string;
  targetValue: string;
  period: "daily" | "weekly" | "monthly";
  weightPct: number;
}

/**
 * The KPI setup wizard (§8.5, doc 41 F4).
 *
 * ── THE FIVE RULES, CHECKED HERE AND ENFORCED AT THE API ────────────────────
 *
 * This form refuses to submit an invalid set so the owner gets a decent
 * message without a round trip. It is NOT where the rules live - the API
 * re-checks every one, because a server action and a direct PUT are the same
 * route. See `actions.ts`.
 *
 *   1. between 4 and the plan's ceiling (4 on Starter, 6 above);
 *   2. weights total exactly 100;
 *   3. at least one Result and one Activity, so the set cannot be all-activity
 *      and gameable;
 *   4. nothing is selectable that this tenant cannot source;
 *   5. a KPI with no data needs an explicit tick.
 *
 * ── "DATA NEEDED" IS NOT A WARNING, IT IS THE POINT ─────────────────────────
 *
 * §7: "Only KPIs computable from sent data are offered." Each row says what
 * has to be sent for it to work, in the field names the integrator uses, and
 * whether it has arrived - `ready`, `partial` or `missing`. An owner choosing
 * a KPI whose data is missing is allowed to; being surprised by a dash on the
 * dashboard next week is not.
 *
 * ── EFFECTIVE FROM IS ON THE CONFIRM STEP, NOT HIDDEN ───────────────────────
 *
 * Saving closes the previous set at this date and starts the new one, so last
 * month keeps the targets it was judged against. Doc 41 F2: that is what makes
 * recomputing a past day idempotent across a target change.
 */
export function KpiWizard({
  catalog,
  existing,
  maxSelectable,
  identity,
  today,
}: {
  catalog: CatalogKpi[];
  existing: ExistingConfig[];
  maxSelectable: number | null;
  identity: { activeTelecallers: number; withoutLogin: number };
  today: string;
}) {
  const live = useMemo(
    () => existing.filter((c) => c.scope_kind === "org" && c.effective_to === null),
    [existing],
  );

  const [drafts, setDrafts] = useState<Draft[]>(() =>
    live.length > 0
      ? live.map((c) => ({
          kpiKey: c.kpi_key,
          targetValue: c.target_value === null ? "" : formatTargetForInput(c, catalog),
          period: (c.period as Draft["period"]) ?? "monthly",
          weightPct: c.weight_pct,
        }))
      : [],
  );
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [acknowledge, setAcknowledge] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const [pending, start] = useTransition();

  const ceiling = maxSelectable ?? 6;
  const byKey = useMemo(() => new Map(catalog.map((k) => [k.key, k])), [catalog]);
  const chosen = drafts.map((d) => byKey.get(d.kpiKey)).filter(Boolean) as CatalogKpi[];
  const total = drafts.reduce((sum, d) => sum + (Number.isFinite(d.weightPct) ? d.weightPct : 0), 0);
  const missingData = chosen.filter((k) => k.status === "missing");
  const userKeyed = chosen.filter((k) => k.identity === "user");

  const problems: string[] = [];
  if (drafts.length < 4) problems.push("Choose at least 4 KPIs.");
  if (drafts.length > ceiling) {
    problems.push(
      maxSelectable === null
        ? `At most ${ceiling} KPIs.`
        : `Your plan covers ${ceiling} KPIs at a time.`,
    );
  }
  if (total !== 100) problems.push(`Weights must total exactly 100 — these total ${total}.`);
  if (!chosen.some((k) => k.category === "result")) {
    problems.push("Include at least one Result KPI — activity alone is gameable.");
  }
  if (!chosen.some((k) => k.category === "activity")) {
    problems.push("Include at least one Activity KPI.");
  }
  if (missingData.length > 0 && !acknowledge) {
    problems.push("Confirm you want to track a KPI no data has arrived for.");
  }

  function toggle(kpi: CatalogKpi): void {
    setSaved(null);
    setDrafts((current) => {
      const found = current.find((d) => d.kpiKey === kpi.key);
      if (found) return current.filter((d) => d.kpiKey !== kpi.key);
      if (current.length >= ceiling) return current;
      // Weights are NOT auto-balanced to 100. An owner's weighting is a
      // judgement about what matters, and silently redistributing it when they
      // add a KPI would quietly change the meaning of every other one. The
      // total is shown and the save is blocked until they decide.
      return [...current, { kpiKey: kpi.key, targetValue: "", period: "monthly", weightPct: 0 }];
    });
  }

  function update(key: string, patch: Partial<Draft>): void {
    setSaved(null);
    setDrafts((current) => current.map((d) => (d.kpiKey === key ? { ...d, ...patch } : d)));
  }

  function submit(): void {
    setError(null);
    start(async () => {
      const result = await saveKpiConfigAction({
        effectiveFrom,
        kpis: drafts.map((d) => ({
          kpiKey: d.kpiKey,
          targetValue: parseTarget(d.targetValue, byKey.get(d.kpiKey)),
          period: d.period,
          weightPct: d.weightPct,
        })),
        acknowledgeMissingData: acknowledge,
      });
      if (result.error) setError(result.error);
      else setSaved(result.saved ?? drafts.length);
    });
  }

  const grouped = ["activity", "result", "quality", "discipline"] as const;

  return (
    <div className="space-y-6">
      {grouped.map((category) => {
        const rows = catalog.filter((k) => k.category === category);
        if (rows.length === 0) return null;
        return (
          <Card key={category}>
            <MonoLabel>{CATEGORY_LABEL[category]}</MonoLabel>
            <p className="mt-1 text-sm text-text-muted">{CATEGORY_BLURB[category]}</p>
            <ul className="mt-3 divide-y divide-border">
              {rows.map((kpi) => {
                const draft = drafts.find((d) => d.kpiKey === kpi.key);
                const atCeiling = !draft && drafts.length >= ceiling;
                return (
                  <li key={kpi.key} className="py-3">
                    <div className="space-y-2">
                      {/* The label goes INTO the Checkbox rather than beside
                          it: `CheckboxProps.label` is required because an
                          unlabelled checkbox is a WCAG failure, and a sibling
                          `<span>` with an `aria-label` on the input gives a
                          screen reader one name and a sighted reader another. */}
                      <Checkbox
                        checked={Boolean(draft)}
                        disabled={atCeiling}
                        onChange={() => toggle(kpi)}
                        label={
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-text">{kpi.label}</span>
                            <DataStatus status={kpi.status} />
                            {kpi.direction === "lower" ? (
                              <span className="text-xs text-text-muted">lower is better</span>
                            ) : null}
                          </span>
                        }
                        description={
                          <>
                            <span className="block text-sm text-text-muted">{kpi.blurb}</span>
                            <span className="mt-0.5 block text-xs text-text-muted">
                              <span className="font-medium">Needs:</span> {kpi.dataNeeded}
                            </span>
                          </>
                        }
                      />
                      {/* Indented under the checkbox it belongs to, so a row's
                          controls read as part of that row rather than as a
                          free-standing form. */}
                      <div className="min-w-0 pl-6">
                        {draft ? (
                          <div className="flex flex-wrap items-end gap-3">
                            <label className="text-xs text-text-muted">
                              Target
                              <Input
                                value={draft.targetValue}
                                inputMode="decimal"
                                placeholder={targetPlaceholder(kpi)}
                                onChange={(e) => update(kpi.key, { targetValue: e.target.value })}
                                className="mt-0.5 w-28"
                              />
                            </label>
                            <label className="text-xs text-text-muted">
                              Per
                              <Select
                                value={draft.period}
                                onChange={(e) =>
                                  update(kpi.key, { period: e.target.value as Draft["period"] })
                                }
                                className="mt-0.5 w-28"
                              >
                                <option value="daily">day</option>
                                <option value="weekly">week</option>
                                <option value="monthly">month</option>
                              </Select>
                            </label>
                            <label className="text-xs text-text-muted">
                              Weight %
                              <Input
                                value={String(draft.weightPct)}
                                inputMode="numeric"
                                onChange={(e) =>
                                  update(kpi.key, { weightPct: Number(e.target.value) || 0 })
                                }
                                className="mt-0.5 w-24"
                              />
                            </label>
                          </div>
                        ) : null}

                        {draft && draft.targetValue.trim() === "" ? (
                          <p className="mt-1 text-xs text-text-muted">
                            No target: this will be measured and shown, and will count nothing
                            towards the score.
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        );
      })}

      <Card>
        <MonoLabel>Confirm</MonoLabel>
        <dl className="mt-2 space-y-1 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-text-muted">KPIs chosen</dt>
            <dd className="tabular-nums text-text">
              {drafts.length} of {ceiling}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-text-muted">Weights</dt>
            <dd className={`tabular-nums ${total === 100 ? "text-text" : "text-text-muted"}`}>
              {total} / 100
            </dd>
          </div>
        </dl>

        <label className="mt-3 block text-xs text-text-muted">
          Changes apply from
          <Input
            type="date"
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
            className="mt-0.5 w-44"
          />
        </label>
        <p className="mt-1 text-xs text-text-muted">
          Earlier periods keep the targets they were judged against — changing a target now never
          rewrites last month.
        </p>

        {userKeyed.length > 0 && identity.withoutLogin > 0 ? (
          <p className="mt-3 rounded-md border border-border bg-surface-hover p-2 text-sm text-text-muted">
            {identity.withoutLogin} of {identity.activeTelecallers} active telecallers have no login
            behind them, so {userKeyed.map((k) => k.label).join(", ")} cannot be computed for them.
            They will show a dash with the reason.{" "}
            <Link href="/owner/staff" className="underline underline-offset-2">
              Team & permissions
            </Link>
          </p>
        ) : null}

        {missingData.length > 0 ? (
          <div className="mt-3">
            <Checkbox
              checked={acknowledge}
              onChange={() => setAcknowledge((v) => !v)}
              label={`Track ${missingData.map((k) => k.label).join(", ")} anyway`}
              description="No data has arrived for it yet, so the card will show a dash with the reason until some does."
            />
          </div>
        ) : null}

        {problems.length > 0 ? (
          <ul className="mt-3 space-y-1 text-sm text-text-muted">
            {problems.map((p) => (
              <li key={p}>· {p}</li>
            ))}
          </ul>
        ) : null}

        {error ? <p className="mt-3 text-sm text-text">{error}</p> : null}
        {saved !== null ? (
          <p className="mt-3 text-sm text-text-muted">
            Saved {saved} KPIs. The figures fill in on the next recompute, within fifteen minutes.{" "}
            <Link href="/owner/kpi" className="underline underline-offset-2">
              Performance
            </Link>
          </p>
        ) : null}

        <div className="mt-4">
          <Button onClick={submit} disabled={pending || problems.length > 0}>
            {pending ? "Saving…" : "Save KPIs"}
          </Button>
        </div>
      </Card>
    </div>
  );
}

const CATEGORY_LABEL: Record<string, string> = {
  activity: "Activity — how much work happened",
  result: "Result — what the work produced",
  quality: "Quality — how well it was done",
  discipline: "Discipline — whether the process was followed",
};

const CATEGORY_BLURB: Record<string, string> = {
  activity: "Volume and effort. At least one of these is required.",
  result: "Outcomes and value. At least one of these is required, so the set cannot be gamed.",
  quality: "Scored by your own reviewers. No AI is involved on this plan.",
  discipline: "The habits every other number depends on.",
};

function DataStatus({ status }: { status: CatalogKpi["status"] }) {
  if (status === "ready") return <StatusChip tone="muted">Data arriving</StatusChip>;
  if (status === "partial") return <StatusChip tone="outline">Partial data</StatusChip>;
  return <StatusChip tone="outline">No data yet</StatusChip>;
}

/**
 * A percent target is entered as a percent and stored as a fraction.
 *
 * The API and the engine work in fractions (`connect_rate` of 0.45), and an
 * owner types 45. Converting at the edge rather than storing percents keeps
 * one representation in the database and one in the UI, instead of a column
 * whose meaning depends on which KPI it belongs to.
 */
function parseTarget(raw: string, kpi: CatalogKpi | undefined): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  if (kpi?.unit === "percent") return value / 100;
  if (kpi?.unit === "currency") return Math.round(value * 100);
  return value;
}

function formatTargetForInput(config: ExistingConfig, catalog: CatalogKpi[]): string {
  const kpi = catalog.find((k) => k.key === config.kpi_key);
  const value = Number(config.target_value);
  if (!Number.isFinite(value)) return "";
  if (kpi?.unit === "percent") return String(Math.round(value * 1000) / 10);
  if (kpi?.unit === "currency") return String(Math.round(value / 100));
  return String(value);
}

function targetPlaceholder(kpi: CatalogKpi): string {
  switch (kpi.unit) {
    case "percent":
      return "45 (%)";
    case "currency":
      return "500000 (₹)";
    case "seconds":
      return "7200 (s)";
    default:
      return "620";
  }
}
