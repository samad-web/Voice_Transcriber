import { Module } from "@nestjs/common";
import { MergeController } from "./merge.controller";

/** CRM Phase 1 foundation (E0.3) - Contact/Account merge and duplicate detection. */
@Module({
  controllers: [MergeController],
})
export class MergeModule {}
