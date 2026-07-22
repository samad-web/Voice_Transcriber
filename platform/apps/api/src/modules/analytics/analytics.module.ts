import { Module } from "@nestjs/common";
import { AnalyticsController } from "./analytics.controller";
import { SearchController } from "./search.controller";

@Module({
  controllers: [AnalyticsController, SearchController],
})
export class AnalyticsModule {}
