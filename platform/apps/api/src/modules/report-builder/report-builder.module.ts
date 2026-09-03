import { Module } from "@nestjs/common";
import { ReportBuilderController } from "./report-builder.controller";
import { ReportBuilderService } from "./report-builder.service";
import { ReportDatasetsController } from "./report-datasets.controller";

/**
 * The Report Builder (migration 0077) - user-assembled reports over the
 * tenant's own CRM data, or over a file they uploaded.
 *
 * Separate from `ReportsModule`, which owns the four FIXED reports (pipeline,
 * conversion, performance, commission) and the targets/commission-plan config
 * behind them. The two are genuinely different products sharing a word: that
 * module answers the four questions we decided everyone has, this one answers
 * the ones we did not think of. They share exactly one thing - `reports/csv.ts`,
 * imported here so a builder export and a fixed-report export quote and escape
 * identically.
 */
@Module({
  controllers: [ReportBuilderController, ReportDatasetsController],
  providers: [ReportBuilderService],
})
export class ReportBuilderModule {}
