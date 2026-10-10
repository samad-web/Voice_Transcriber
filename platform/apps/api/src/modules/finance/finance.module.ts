import { Module } from "@nestjs/common";
import { S3Module } from "../../s3/s3.module";
import { AdvisorController } from "./advisor.controller";
import { ComplianceController } from "./compliance.controller";
import { ConnectorsController } from "./connectors.controller";
import { DealTemplatesController } from "./deal-templates.controller";
import { DocumentsController } from "./documents.controller";
import { ExpensesController } from "./expenses.controller";
import { FinanceDashboardController } from "./finance-dashboard.controller";
import { FinancePaymentsController } from "./finance-payments.controller";
import { FinanceWebhookController } from "./finance-webhook.controller";
import { IncentivesController } from "./incentives.controller";

/**
 * The Finance module (Build docs/finance-section-build-plan, migrations
 * 0172-0176).
 *
 * ── SEVEN CONTROLLERS, NO SERVICES ──────────────────────────────────────────
 *
 * The same shape `ResourcesModule` records: everything these routes do is a
 * few statements inside a `withOrg` transaction, and a service layer whose
 * only job is to forward a client it did not open earns nothing.
 *
 * What IS factored out is the logic that more than one caller needs, and each
 * piece sits at the lowest level that reaches all of its callers:
 *
 *   `@aura/shared`  money arithmetic, the deal/schedule rules, the statistics,
 *                   the advisor catalogue, the metric definitions. Pure, so the
 *                   web console imports the same functions for its previews.
 *   `@aura/db`      the rollup (`computeTotals`), the connector registry and
 *                   the event drain - needed by the WORKER as well as the API,
 *                   and the worker cannot import from `apps/api`.
 *   here            `ledger.ts` (the only writer of `ledger_entries`),
 *                   `matcher.ts` (§8's rules), `finance-settings.ts` (§15's
 *                   defaults, resolved once).
 *
 * ── WHAT IS NOT HERE ────────────────────────────────────────────────────────
 *
 * No delete route anywhere in the module. §6.3 is a MUST - "never edit or
 * delete a posted payment or ledger row" - so a payment is reversed, an
 * expense is reversed, a template is superseded by a new version, and a period
 * is re-opened rather than un-locked. `ENFORCED_PERMISSIONS` has no
 * `finance:delete` for the same reason: a grid cell with no route behind it is
 * a checkbox somebody would believe.
 *
 * No customer-facing surface and no send path. §12.5's "notify-only by
 * default" means the Advisor raises in-app notifications and tasks for STAFF;
 * there is no template, no outbox and no phone number anywhere under
 * `finance/`. Nothing in this module can message a customer or move money.
 *
 * No language model. §12's MUST is that "rules and statistics decide; language
 * only explains", and the structural guarantee is that the deciding code is
 * pure and cannot reach a network. There is no `@aura/llm` import in this
 * module and there must not be one.
 *
 * ── AND WHAT 0060 KEEPS ─────────────────────────────────────────────────────
 *
 * `InvoicesModule` is untouched. Invoices, quotations and the Razorpay payment
 * LINK flow all work exactly as before; this module treats 0060's `payments`
 * as a SOURCE that normalizes into `finance_payments` (DECISIONS.md §3.2), so
 * "collected" has one definition without any existing surface changing.
 */
/**
 * ── TEN CONTROLLERS NOW, AND ONE IMPORT ─────────────────────────────────────
 *
 * The last two come from
 * Build docs/indian-business-finance-documents-cycles-import, which §4 of that
 * document files under this spec: "Finance spec: add 'document vault and
 * compliance calendar' and 'import center' as new sections and milestones."
 *
 * Two of its three parts are here. The third - the import centre - is NOT,
 * deliberately: it extends `ImportModule` instead, because the same document
 * asks for ONE import centre that employee lists and call logs also come
 * through. A finance-only importer under this module would be the second one.
 *
 * `S3Module` is imported for the document vault's presigned PUT/GET, the same
 * way the org chart's contract documents reach storage. The bytes never pass
 * through this API.
 */
@Module({
  imports: [S3Module],
  controllers: [
    // M1: §5's templates, the generated schedules, §9's period lock.
    DealTemplatesController,
    // M2 + M4: the canonical payment, §6.2's offline money and second-person
    // approval, §6.3's reversals, the dues/aging views and §8's queue.
    FinancePaymentsController,
    // M3: §7's connector framework. The two controllers are split because one
    // of them has no guards - see FinanceWebhookController's header.
    ConnectorsController,
    FinanceWebhookController,
    // M5: expenses, their approval limit, and §12.3's cost drivers.
    ExpensesController,
    // M7: §10's plans, the collected-only calculation, clawbacks, payouts.
    IncentivesController,
    // M6: §11's metrics layer over snapshots, with live figures for today.
    FinanceDashboardController,
    // M8 + M9: the alert inbox, the rules, the forecast, the leak report.
    AdvisorController,
    // §1's document vault: statutory documents with an expiry, an owner and a
    // reminder. Per-PERSON documents stay on the org chart (0178) - see
    // documents.controller.ts for why that boundary is about access, not tidiness.
    DocumentsController,
    // §2's compliance calendar and month-end close. The calendar is DATA in
    // `compliance_items`, seeded once from the shared catalogue and owned by
    // the tenant after that, because §2 requires a CA to be able to correct a
    // date without a deploy.
    ComplianceController,
  ],
})
export class FinanceModule {}
