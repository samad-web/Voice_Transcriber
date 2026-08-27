import { Module } from "@nestjs/common";
import { MarketingSourcesController } from "./marketing-sources.controller";
import { TagsController } from "./tags.controller";

/** Tags and campaign attribution — packages/db/migrations/0057. */
@Module({
  controllers: [TagsController, MarketingSourcesController],
})
export class TagsModule {}
