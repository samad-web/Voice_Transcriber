import { Module } from "@nestjs/common";
import { S3Module } from "../../s3/s3.module";
import { OrgChartContractsController } from "./org-chart-contracts.controller";
import { OrgChartController } from "./org-chart.controller";
import { OrgChartPositionsController } from "./org-chart-positions.controller";

/**
 * The organization chart (Build docs/org-chart-build-plan.md, migrations
 * 0177/0178).
 *
 * ── THREE CONTROLLERS, AND WHY THE SPLIT IS WHERE IT IS ────────────────────
 *
 * `OrgChartController`      the reads every persona makes - the chart, the
 *                           directory, the analytics, the history - plus
 *                           departments, teams and §14's settings.
 * `OrgChartPositionsController`  the seats and what fills them: create, edit,
 *                           delete, move, assign, and the four replace-the-
 *                           list editors.
 * `OrgChartContractsController`  the restricted half, gated by a DIFFERENT
 *                           permission object.
 *
 * The split is along the PERMISSION boundary rather than along REST tidiness,
 * which is the point. `position:*` and `employment_contract:*` are two objects
 * because §7 gives a telecaller all of the first and none of the second, and
 * keeping them in separate files means the restricted surface is reviewable on
 * its own - the same reason 0178 is a separate migration. A single controller
 * with mixed decorators is one copy-pasted decorator away from serving a
 * salary to the floor.
 *
 * No services. Everything here is a statement or two inside a `withOrg`
 * transaction, and the shared reads live in `tree.ts` as plain functions that
 * take the client the controller already opened - which is what keeps a move's
 * four statements in ONE transaction, as §12 requires.
 *
 * ── WHAT IS NOT HERE ───────────────────────────────────────────────────────
 *
 * The notification SWEEPS. §10's contract-expiry, probation-end and
 * stale-vacancy alerts are time-based rather than request-based, so they live
 * in `apps/worker` beside the other interval sweeps. This module exposes
 * `GET /org-chart/contracts/reminders/upcoming` so the console can show the
 * same pipeline the worker acts on, computed by the same shared function.
 */
@Module({
  // For the presigned PUT/GET that serve §6.3's contract documents. The bytes
  // never pass through this API - see `addDocument`.
  imports: [S3Module],
  controllers: [OrgChartController, OrgChartPositionsController, OrgChartContractsController],
})
export class OrgChartModule {}
