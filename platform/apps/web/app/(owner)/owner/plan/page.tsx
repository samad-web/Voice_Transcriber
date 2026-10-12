import type { Metadata } from "next";
import { Card, MonoLabel, ProgressBar, StatusChip } from "@aura/ui";
import { LoadFailure } from "@/components/load-failure";
import { LocalTime } from "@/components/local-time";
import { PageHeader } from "@/components/page-header";
import { ownerTry, requireFeature, requireOwnerRoles } from "@/lib/owner-context";
import { PlanActions } from "./plan-actions";

export const metadata: Metadata = { title: "Plan & usage" };

interface PlanPayload {
  current: {
    planKey: string | null;
    planName: string | null;
    status: string | null;
    trialPlanKey: string | null;
    trialEndsAt: string | null;
    pendingPlanKey: string | null;
    currentPeriodEnd: string | null;
  };
  meters: {
    key: string;
    limitType: string;
    per: string | null;
    reading: {
      state: "ok" | "warning" | "grace" | "blocked";
      fraction: number | null;
      limit: number | null;
      used: number;
      remaining: number | null;
    };
  }[];
  plans: {
    key: string;
    name: string;
    blurb: string | null;
    priceMinor: number | null;
    currency: string;
    period: string;
    entitlements: Record<string, { enabled?: boolean; variant?: string; limit?: number | null; months?: number | null; days?: number | null }>;
  }[];
  entitlements: {
    key: string;
    label: string;
    blurb: string;
    limitType: string;
    variants: string[] | null;
    hidesSurface: boolean;
  }[];
  openRequest: { id: string; kind: string; plan_key: string | null; created_at: string } | null;
  trialsTaken: string[];
}

/**
 * Settings → Plan & usage (§8.10 and §9.1, M1 + the honest part of M8).
 *
 * ── OWNER PERSONA ONLY, AND THAT IS §9.7 ────────────────────────────────────
 *
 * "Upsell visible only to Owner and Admin; telecallers and viewers never see
 * any upsell or billing." Enforced at the API as well - a nav restriction is a
 * courtesy, and the route is the product.
 *
 * ── THE TABLE COMES FROM THE LIVE DEFINITIONS ───────────────────────────────
 *
 * §9.1: "Side-by-side plan table from the live plan definitions (never a
 * hard-coded copy)." Every number below is read from `plan_entitlements`, so a
 * limit product changed this morning shows the new figure without a deploy.
 * There is no plan table in this file and there must never be one.
 *
 * ── NO PRICES, AND NO PRETENDING ────────────────────────────────────────────
 *
 * There is no payment provider yet (the project owner's decision, 2026-10-10),
 * so `priceMinor` is null on every plan and the action is "Talk to us" rather
 * than a checkout that cannot complete. An upgrade creates a request an
 * operator applies. No countdown, no "offer ends", no price that is not real -
 * §9.7's guardrails, and the easiest way to honour them is to have nothing to
 * dress up.
 */
export default async function PlanPage() {
  await requireFeature("/owner/plan");
  await requireOwnerRoles(["owner"]);

  const result = await ownerTry<PlanPayload>("/v1/insights/plan");
  if (!result.ok) {
    return (
      <>
        <PageHeader title="Plan & usage" context="Settings" />
        <LoadFailure failure={result} what="your plan" />
      </>
    );
  }
  const data = result.data;
  const current = data.plans.find((p) => p.key === data.current.planKey) ?? null;
  const effectiveKey = data.current.trialPlanKey ?? data.current.planKey;

  return (
    <>
      <PageHeader title="Plan & usage" context="Settings" />

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <MonoLabel>Your plan</MonoLabel>
            <p className="mt-1 text-xl font-semibold text-text">
              {data.current.planName ?? "Not on a plan"}
            </p>
            {data.current.trialPlanKey ? (
              <p className="mt-1 text-sm text-text-muted">
                Trialling <strong className="font-medium text-text">{data.current.trialPlanKey}</strong>{" "}
                until <LocalTime iso={data.current.trialEndsAt as string} />. It reverts on its own
                — nothing is charged and no data is removed.
              </p>
            ) : null}
            {data.current.pendingPlanKey ? (
              <p className="mt-1 text-sm text-text-muted">
                Moving to <strong className="font-medium text-text">{data.current.pendingPlanKey}</strong>{" "}
                at the end of this period
                {data.current.currentPeriodEnd ? (
                  <>
                    {" "}
                    (<LocalTime iso={data.current.currentPeriodEnd} />)
                  </>
                ) : null}
                . Your data stays — only what is shown changes.
              </p>
            ) : null}
          </div>
          {data.current.status ? (
            <StatusChip tone={data.current.status === "past_due" ? "danger" : "muted"}>
              {data.current.status}
            </StatusChip>
          ) : null}
        </div>

        {!data.current.planKey ? (
          <p className="mt-2 text-sm text-text-muted">
            This workspace predates our plans and has no limits applied. Nothing will change until
            somebody puts you on one.
          </p>
        ) : null}
      </Card>

      {/* §8.10's live usage meters, and §9.2's 80%/100% triggers rendered as
          plain notices rather than as pressure. */}
      <Card>
        <MonoLabel>Usage this period</MonoLabel>
        {data.meters.length === 0 ? (
          <p className="mt-1 text-sm text-text-muted">No metered limits on this plan.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {data.meters.map((meter) => {
              const spec = data.entitlements.find((e) => e.key === meter.key);
              const reading = meter.reading;
              return (
                <li key={meter.key}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                    <span className="text-text">{spec?.label ?? meter.key}</span>
                    <span className="tabular-nums text-text-muted">
                      {reading.used.toLocaleString("en-IN")}
                      {reading.limit === null
                        ? " · unlimited"
                        : ` of ${reading.limit.toLocaleString("en-IN")}`}
                      {meter.per === "month" ? " this month" : ""}
                    </span>
                  </div>
                  {reading.limit !== null ? (
                    <ProgressBar percent={Math.min((reading.fraction ?? 0) * 100, 100)} />
                  ) : null}
                  {reading.state !== "ok" ? (
                    <p className="mt-0.5 text-xs text-text-muted">{meterNote(meter.key, reading)}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <PlanActions
        current={data.current}
        plans={data.plans.map((p) => ({ key: p.key, name: p.name }))}
        openRequest={data.openRequest}
        trialsTaken={data.trialsTaken}
      />

      {/* §9.1's comparison, from the live definitions. */}
      <Card className="overflow-x-auto p-0">
        <div className="p-4 pb-0">
          <MonoLabel>Compare plans</MonoLabel>
          <p className="mt-1 text-sm text-text-muted">
            Your own usage sits beside each limit above. Everything here is read from the live plan
            definitions, so it is what you would actually get.
          </p>
        </div>
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="border-y border-border text-left">
              <th scope="col" className="px-4 py-2 font-medium text-text-muted">
                What you get
              </th>
              {data.plans.map((plan) => (
                <th
                  key={plan.key}
                  scope="col"
                  className={`px-3 py-2 font-medium ${
                    plan.key === effectiveKey ? "text-text" : "text-text-muted"
                  }`}
                >
                  {plan.name}
                  {plan.key === effectiveKey ? (
                    <span className="ml-1 text-xs font-normal">(yours)</span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.entitlements.map((spec) => (
              <tr key={spec.key} className="border-b border-border last:border-0">
                <th scope="row" className="px-4 py-2 text-left font-normal">
                  <span className="text-text">{spec.label}</span>
                  <span className="mt-0.5 block text-xs text-text-muted">{spec.blurb}</span>
                </th>
                {data.plans.map((plan) => (
                  <td
                    key={plan.key}
                    className={`px-3 py-2 align-top ${
                      plan.key === effectiveKey ? "bg-surface-hover" : ""
                    }`}
                  >
                    {renderValue(spec.limitType, plan.entitlements[spec.key])}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="border-t border-border">
              <th scope="row" className="px-4 py-3 text-left font-normal text-text">
                Price
              </th>
              {data.plans.map((plan) => (
                <td key={plan.key} className="px-3 py-3 text-sm">
                  {plan.priceMinor === null ? (
                    <span className="text-text-muted">Talk to us</span>
                  ) : (
                    <span className="text-text">
                      ₹{Math.round(plan.priceMinor / 100).toLocaleString("en-IN")} / {plan.period}
                    </span>
                  )}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </Card>

      {/* §9.1's locked-feature gallery. Honest descriptions and a demo
          request - no sample screenshots of a product this tenant is not on. */}
      <Card>
        <MonoLabel>On the Platform plan</MonoLabel>
        <p className="mt-1 text-sm text-text-muted">
          Two things this tier deliberately does not include, described as they are:
        </p>
        <ul className="mt-3 space-y-2 text-sm">
          <li>
            <strong className="font-medium text-text">CRM.</strong>{" "}
            <span className="text-text-muted">
              Leads, a pipeline board, contacts and companies, deals, quotes and invoices — the
              place a team works a list rather than reports on one. It replaces the system you
              already have, which is the reason this tier exists.
            </span>
          </li>
          <li>
            <strong className="font-medium text-text">AI on your calls.</strong>{" "}
            <span className="text-text-muted">
              Recording, transcription, and the read of each call — intent, outcome, quality scoring
              and coaching. It needs the Aura app on your telecallers&rsquo; phones, and it means we
              hold a word-for-word account of your customers&rsquo; conversations, which is a
              decision worth making deliberately.
            </span>
          </li>
        </ul>
        <p className="mt-3 text-sm text-text-muted">
          Your API-sent history moves with you if you switch — it is the same tables either way.
        </p>
      </Card>

      {current ? (
        <p className="text-xs text-text-muted">
          {current.blurb} Changing plans never deletes anything: a lower plan limits what is
          displayed and keeps every event, fact and figure, and moving back up brings them straight
          back.
        </p>
      ) : null}
    </>
  );
}

/** §9.2's notices, as plain statements of what happens next. */
function meterNote(key: string, reading: PlanPayload["meters"][number]["reading"]): string {
  const pct = Math.round((reading.fraction ?? 0) * 100);
  switch (reading.state) {
    case "warning":
      return `${pct}% used. A higher plan raises this.`;
    case "grace":
      return (
        `Over the limit and still being accepted — there is a small allowance above it. ` +
        `${reading.remaining ?? 0} left before new ones are refused.`
      );
    case "blocked":
      return key === "ingest_events_monthly"
        ? "At the ceiling. New events are being refused with a clear error until the month rolls over or the plan changes. Nothing already sent is affected."
        : "At the ceiling. Adding more is blocked; nothing existing has been removed.";
    default:
      return "";
  }
}

function renderValue(
  limitType: string,
  value: PlanPayload["plans"][number]["entitlements"][string] | undefined,
): string {
  if (!value) return "—";
  if (limitType === "quota") {
    if (value.limit === null || value.limit === undefined) return "Unlimited";
    return value.limit.toLocaleString("en-IN");
  }
  if (limitType === "window") {
    if (value.months) return `${value.months} months`;
    if (value.days) return `${value.days} days`;
    return "Unlimited";
  }
  if (!value.enabled) return "—";
  return value.variant ? VARIANT_LABEL[value.variant] ?? value.variant : "Included";
}

/** The graded variants, in words rather than in their keys. */
const VARIANT_LABEL: Record<string, string> = {
  flat: "Flat list",
  teams: "Teams",
  org_chart: "Full org chart",
  csv_limited: "CSV, limited rows",
  csv_excel: "CSV & Excel",
  csv_excel_pdf: "CSV, Excel & PDF",
  weekly_monthly: "Weekly & monthly",
  unlimited_branded: "Unlimited, branded",
  email: "Email",
  email_whatsapp_escalation: "Email, WhatsApp, escalation",
  single_template: "One template",
  saved_mappings: "Saved mappings",
  advanced: "Advanced mappings",
  basic: "Basic",
  full: "Full",
};
