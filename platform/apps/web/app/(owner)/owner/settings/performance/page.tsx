import type { Metadata } from "next";
import Link from "next/link";
import { Card, MonoLabel } from "@aura/ui";
import { todayIn } from "@aura/shared";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { getOrgTimeZone } from "@/lib/org-time";
import { ownerTry, requireFeature, requireOwnerRoles } from "@/lib/owner-context";
import { KpiWizard, type CatalogKpi, type ExistingConfig } from "./kpi-wizard";
import { VisibilityForm } from "./visibility-form";

export const metadata: Metadata = { title: "KPI setup" };

interface Catalog {
  kpis: CatalogKpi[];
  maxSelectable: number | null;
  customKpisAllowed: boolean;
  identity: { activeTelecallers: number; withoutLogin: number };
  totalInCatalogue: number;
}

interface Config {
  config: ExistingConfig[];
  bands: { bandKey: string; label: string; minPct: number; maxPct: number | null; tone: string }[];
}

interface Settings {
  settings: {
    leaderboardVisibility: "hidden" | "own_rank" | "full";
    demoMode: boolean;
    staleFeedHours: number;
    coverageFloor: number;
  };
}

/**
 * Settings → KPI setup (§8.5, doc 41 F4's `/owner/settings/performance`).
 *
 * ── BUSINESS TYPE IS NOT ASKED AGAIN ────────────────────────────────────────
 *
 * The original plan's step 1 was "choose your business type". The business
 * profile already holds it and stage packs already key presets off it, so
 * asking again would be a second source of the same answer. Doc 41 F4.
 *
 * ── MANAGERS SEE IT, OWNERS CHANGE IT ───────────────────────────────────────
 *
 * A manager whose team is measured on these should be able to read what they
 * are; the API refuses their write. So the page renders for both personas and
 * the form is only mounted for an owner - and the refusal that matters is the
 * API's, not this branch.
 */
export default async function KpiSetupPage() {
  await requireFeature("/owner/settings/performance");
  const owner = await requireOwnerRoles(["owner", "manager"]);
  const zone = await getOrgTimeZone();

  const [catalog, config, settings] = await Promise.all([
    ownerTry<Catalog>("/v1/insights/kpi/catalog"),
    ownerTry<Config>("/v1/insights/kpi/config"),
    ownerTry<Settings>("/v1/insights/settings"),
  ]);

  if (!catalog.ok) {
    return (
      <>
        <PageHeader title="KPI setup" context="Settings" />
        <LoadFailure failure={catalog} what="the KPI catalogue" />
      </>
    );
  }

  const isOwner = owner.membership.ownerRole === "owner";
  const live = config.ok
    ? config.data.config.filter((c) => c.scope_kind === "org" && c.effective_to === null)
    : [];

  return (
    <>
      <PageHeader title="KPI setup" context="Settings" />
      <p className="-mt-2 text-sm text-text-muted">
        Choose four to six things your floor is measured on, set a target and a weight for each, and
        the Performance screens fill in from the data your systems send.
      </p>

      {!isOwner ? (
        <Card>
          <MonoLabel>Read only</MonoLabel>
          <p className="mt-1 text-sm text-text-muted">
            These are the KPIs your workspace is measured on. Only an owner can change them.
          </p>
        </Card>
      ) : null}

      {isOwner ? (
        <KpiWizard
          catalog={catalog.data.kpis}
          existing={config.ok ? config.data.config : []}
          maxSelectable={catalog.data.maxSelectable}
          identity={catalog.data.identity}
          today={todayIn(zone)}
        />
      ) : (
        <Card>
          <MonoLabel>Currently measured</MonoLabel>
          {live.length === 0 ? (
            <p className="mt-1 text-sm text-text-muted">No KPIs are set up yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-border text-sm">
              {live.map((c) => {
                const spec = catalog.data.kpis.find((k) => k.key === c.kpi_key);
                return (
                  <li key={c.kpi_key} className="flex justify-between gap-3 py-2">
                    <span className="text-text">{spec?.label ?? c.kpi_key}</span>
                    <span className="tabular-nums text-text-muted">
                      {c.target_value === null ? "no target" : `target ${c.target_value}`} ·{" "}
                      {c.weight_pct}%
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      {isOwner && settings.ok ? (
        <VisibilityForm settings={settings.data.settings} today={todayIn(zone)} />
      ) : null}

      {/* §9.3's locked preview, where it is relevant rather than on a wall of
          its own: named, one sentence of benefit, the plan that has it, one
          action. No sample numbers presented as the customer's. */}
      {isOwner && !catalog.data.customKpisAllowed ? (
        <Card>
          <MonoLabel>Custom KPIs — on Scale</MonoLabel>
          <p className="mt-1 text-sm text-text-muted">
            This plan offers {catalog.data.kpis.length} KPIs from our catalogue. Scale adds KPIs
            defined from your own fields — a formula over the custom attributes you already send.{" "}
            <Link href="/owner/plan" className="underline underline-offset-2">
              Compare plans
            </Link>
          </p>
        </Card>
      ) : null}

      <Card>
        <MonoLabel>How a score is worked out</MonoLabel>
        <ul className="mt-2 space-y-1.5 text-sm text-text-muted">
          <li>
            · Each KPI scores as <strong className="font-medium text-text">achieved ÷ target</strong>
            , capped at 120% so one enormous number cannot paper over a weak area.
          </li>
          <li>
            · Those are weighted and added. The result is a score against targets you agreed — not a
            blend of quality measures, which would mean averaging numbers that are not comparable.
          </li>
          <li>
            · A KPI with too little behind it to be worth stating shows a dash and the reason,
            rather than a number computed from three calls.
          </li>
          <li>
            · A score over less than {Math.round((settings.ok ? settings.data.settings.coverageFloor : 0.6) * 100)}
            % of the configured weight is not shown at all, and is never quietly recalculated over
            the KPIs that did answer.
          </li>
          <li>
            · Counts, durations and amounts are pro-rated to whatever period you look at. Rates are
            not — 45% is 45% over a day or a month.
          </li>
        </ul>
      </Card>
    </>
  );
}
