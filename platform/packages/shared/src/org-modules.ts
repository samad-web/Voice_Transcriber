import { z } from "zod";

/**
 * The product modules a tenant can be entitled to (migration 0072,
 * `organizations.enabled_modules`). Pure data, same catalogue pattern as
 * `connection-providers.ts`/`crm-providers.ts` - a new module is a row here,
 * not a branch somewhere else.
 *
 * This is the RESOLVED, per-org entitlement state - not a plan. A future
 * plans/billing system (`organizations.plan_id` is a dormant seam for
 * exactly that, see plans.ts) would assign a named plan that resolves to
 * one of these sets and writes it here; nothing downstream needs to know
 * whether a module was turned on by a plan or by hand.
 *
 * "aura" is always included - every tenant created via createTenant gets an
 * instance/workspace/devices, so there is no "no-Aura" tenant today. "crm"
 * is the one toggle that actually does something right now (createTenant's
 * `enableCrm` flag, `PATCH /admin/tenants/:id/modules`) - it gates
 * CrmPermissionsGuard and seeds roles/a default pipeline when turned on.
 * "wasi" is catalogued for plan/schema readiness only: Wasi is configured
 * manually per client on the Wasi side (a `messaging_channels` row, see
 * migration 0061), there is no bulk-provisioning action for it yet, and it
 * is not exposed as a toggle anywhere.
 *
 * "call_intel" is the second live toggle. It decides whether a tenant sees
 * the AI read of their own calls - intent, sentiment, outcome, and the
 * transcript itself - inside their console, or only the lead it produced.
 * It is a module rather than an always-on feature because a transcript is
 * the most privacy-sensitive artifact this platform stores: who may read a
 * word-for-word account of a customer's phone call is a decision per client
 * contract, not a product default. Off for every tenant until an operator
 * turns it on, including tenants that already have CRM.
 *
 * "finance" is the third live toggle (Build docs/finance-section-build-plan,
 * migration 0172). It gates the back office - deal payment schedules, the
 * canonical payment record, the ledger, expenses, incentives, the matching
 * queue and the Finance Advisor. A module rather than a feature because it is
 * a separately-sold back office, and because a tenant that had it and lost it
 * keeps its `role_permissions` rows: without the module join in
 * `CrmPermissionsGuard`, those rows would go on granting access to the ledger
 * of a product the client no longer pays for.
 *
 * OFF for every existing tenant, including those with CRM. Invoicing
 * correctness stays in "crm" - `invoice:*` keeps its module - so turning
 * finance off never takes somebody's invoices away.
 */
/**
 * "api_insights" is the fourth live toggle, and the one that sells a DIFFERENT
 * PRODUCT rather than more of this one (Build docs/no-crm-api-dashboard-build-
 * plan.md; INSIGHTS_TIER_DECISIONS.md §2).
 *
 * A business that already runs a CRM or a dialer does not want to migrate. It
 * wants to push its own data at us over an API and see how its telecallers
 * perform against KPIs it chose. That tenant gets the ingestion surface, the
 * KPI spine and the performance dashboards, and gets NO leads, no pipelines,
 * no transcripts and no AI.
 *
 * A module and not an off-by-default feature, for three reasons and the third
 * is binding: it is a separately-sold commercial entitlement, which is what
 * this axis is for; `enabled_modules` IS enforced in the API, which the spec's
 * §5 requires of these exclusions ("hidden or locked features must be absent
 * from the API too"); and `features.test.ts` pins every FEATURES entry's
 * default, so an opt-in entitlement has to be a new module - see features.ts's
 * own header.
 *
 * It COMPOSES rather than excludes. A tenant may hold `api_insights` and
 * `crm`: the KPI spine is not a no-CRM feature, it is a feature the no-CRM
 * tier is built out of, and `Build docs/41_TELECALLER_PERFORMANCE_KPI_SPINE.md`
 * wants it on the CRM screens too. What makes the no-CRM tier no-CRM is the
 * ABSENCE of `crm` from its plan, not anything this module does.
 *
 * OFF for every existing tenant. Nothing about this deploy changes a console
 * until an operator grants it.
 */
export const OrgModule = z.enum([
  "aura",
  "crm",
  "wasi",
  "call_intel",
  "finance",
  "api_insights",
]);
export type OrgModule = z.infer<typeof OrgModule>;

export interface OrgModuleSpec {
  id: OrgModule;
  label: string;
  blurb: string;
}

export const ORG_MODULES: OrgModuleSpec[] = [
  {
    id: "aura",
    label: "Aura",
    blurb: "Call recording, transcription, AI analysis, lead funnel and booking.",
  },
  {
    id: "crm",
    label: "CRM",
    blurb: "Accounts, Contacts, Deals, pipelines, roles and permissions.",
  },
  {
    id: "call_intel",
    label: "Call Intelligence",
    blurb: "Transcripts and the AI read - intent, sentiment, outcome - inside the client's console.",
  },
  {
    id: "finance",
    label: "Finance",
    blurb:
      "Payment schedules, every payment in one place, expenses, incentives and the Finance Advisor.",
  },
  {
    id: "api_insights",
    label: "API Insights",
    blurb:
      "Push your own call, conversion and payment data over our API and see KPI and telecaller performance. No CRM.",
  },
  {
    id: "wasi",
    label: "WhatsApp (Wasi)",
    blurb: "WhatsApp Business messaging via the Wasi Hub API.",
  },
];

/** Every org created via createTenant starts with at least this. */
export const DEFAULT_ORG_MODULES: OrgModule[] = ["aura"];
