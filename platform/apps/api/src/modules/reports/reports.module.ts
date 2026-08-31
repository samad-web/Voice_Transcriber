import { Module } from "@nestjs/common";
import { CommissionPlansController } from "./commission-plans.controller";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";
import { TargetsController } from "./targets.controller";

/**
 * Reporting & analytics over the CRM object model (PRD Layers 3 and 5).
 *
 * Targets live here rather than in their own module because they are the
 * other half of the same question: the reports say what happened, a target
 * says what was supposed to. Attainment is only meaningful with both.
 *
 * Commission plans (Phase 4) join them for the identical reason: a plan is
 * config, `ReportsService.commission()` is the report that reads it, and the
 * two must never drift into separate modules that could disagree about what
 * a plan even is.
 */
@Module({
  controllers: [ReportsController, TargetsController, CommissionPlansController],
  providers: [ReportsService],
})
export class ReportsModule {}
