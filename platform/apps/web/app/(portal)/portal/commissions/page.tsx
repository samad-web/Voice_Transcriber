import type { Metadata } from "next";
import { Card, EmptyState, StatCard } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { getPortal, portalGet } from "../../portal-context";

export const metadata: Metadata = { title: "My commissions" };

interface Plan {
  id: string;
  name: string;
  metric: string;
  rate_type: string;
  rate: string;
  active: boolean;
}

interface Counts {
  converted: string;
  accepted: string;
  first_submission_at: string | null;
}

const METRIC_LABEL: Record<string, string> = {
  won_value: "the value of business won",
  won_count: "each deal won",
  calls: "each call",
};

/**
 * Screen three (Build docs/39 §19): the rate, and what has converted.
 *
 * ── NO FIGURE IS SHOWN, AND THAT IS THE DESIGN ────────────────────────────
 *
 * There is no "you have earned ₹X". 0071's boundary - restated in §18 - is
 * that `commission_plans` is a CALCULATOR INPUT, not payroll: no accrual, no
 * claw-back when a deal unwinds, no approval trail, and nothing that survives
 * the rate being edited. A number printed here would be read as an amount owed
 * by somebody who is not an employee and who has a contract, and the first
 * time it disagreed with what the tenant actually paid, the portal would be
 * the reason for the argument.
 *
 * So: the rate the tenant has set, the count of converted referrals, and
 * whose arithmetic it is. A partner statement is a Report Builder dataset the
 * TENANT sends when they are ready to pay (§18) - a document with a date on
 * it, not a live counter.
 */
export default async function PortalCommissionsPage() {
  const [portal, data] = await Promise.all([
    getPortal(),
    portalGet<{ plan: Plan | null; counts: Counts }>("/v1/portal/commissions"),
  ]);

  if (!data) {
    return (
      <>
        <PageHeader title="My commissions" />
        <EmptyState
          title="We couldn't load your commission details"
          description="The portal didn't answer. Reload the page in a moment."
        />
      </>
    );
  }

  const { plan, counts } = data;
  const workspace = portal?.workspace.name || "the team";

  return (
    <>
      <PageHeader title="My commissions" description={`The rate ${workspace} has you on, and what has converted.`} />

      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Converted" value={Number(counts?.converted ?? 0)} />
        <StatCard label="Accepted and in progress" value={Number(counts?.accepted ?? 0)} />
      </div>

      {plan ? (
        <Card className="space-y-4">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-text">{plan.name}</h2>
            <p className="text-sm leading-relaxed text-text-muted">
              {plan.rate_type === "percent" ? (
                <>
                  <span className="font-medium text-text">{plan.rate}%</span> of{" "}
                  {METRIC_LABEL[plan.metric] ?? plan.metric}.
                </>
              ) : (
                <>
                  <span className="font-medium text-text">
                    {portal?.workspace.currency ?? ""} {plan.rate}
                  </span>{" "}
                  for {METRIC_LABEL[plan.metric] ?? plan.metric}.
                </>
              )}
            </p>
          </div>
          <p className="rounded-md border border-border bg-surface-hover p-3 text-xs leading-relaxed text-text-muted">
            This is the rate on your account, not a statement. {workspace} works out what is
            payable and when - ask them for a statement if you need the figures.
          </p>
        </Card>
      ) : (
        <EmptyState
          title="No rate has been set on your account yet"
          description={`${workspace} sets the commission rate. Your referrals are still being tracked - ask them to attach a plan when you agree one.`}
        />
      )}
    </>
  );
}
