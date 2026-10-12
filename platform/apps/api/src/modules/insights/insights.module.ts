import { Module } from "@nestjs/common";
import { InsightsController } from "./insights.controller";
import { InsightsOpsController } from "./insights-ops.controller";

/**
 * The API-only tier's dashboards and its Integration Center
 * (`Build docs/no-crm-api-dashboard-build-plan.md` §8, migration 0195, M4-M6).
 *
 * ── TWO CONTROLLERS, SPLIT ALONG THE ACCESS BOUNDARY ───────────────────────
 *
 * `InsightsController`     the KPI setup and the dashboards. Owner-persona and
 *                          manager-persona, with the telecaller self-view
 *                          carved out per route.
 * `InsightsOpsController`  the raw events, the error list, replay and the
 *                          unmapped queue. The event inspector sits behind the
 *                          `org_admin` TENANT TIER rather than a persona,
 *                          because §6.5 limits raw payloads to Owner, Admin
 *                          and Developer - and that tier is already what
 *                          governs API keys.
 *
 * The split is along who may see what, not along REST tidiness, the same
 * reasoning `org-chart.module.ts` sets out: a single controller with mixed
 * decorators is one copy-pasted line away from showing a telecaller a raw
 * payload.
 *
 * No services. Every read is a statement or two inside one `withOrg`
 * transaction, with the shared assembly in `kpi-read.ts` as plain functions
 * over the client the controller already opened - which is what keeps a
 * dashboard's four reads consistent with each other.
 */
@Module({
  controllers: [InsightsController, InsightsOpsController],
})
export class InsightsModule {}
