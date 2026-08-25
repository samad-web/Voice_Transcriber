import { Module } from "@nestjs/common";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";
import { TargetsController } from "./targets.controller";

/**
 * Reporting & analytics over the CRM object model (PRD Layers 3 and 5).
 *
 * Targets live here rather than in their own module because they are the
 * other half of the same question: the reports say what happened, a target
 * says what was supposed to. Attainment is only meaningful with both.
 */
@Module({
  controllers: [ReportsController, TargetsController],
  providers: [ReportsService],
})
export class ReportsModule {}
