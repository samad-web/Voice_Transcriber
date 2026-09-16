import { Module } from "@nestjs/common";
import { SavedViewsController } from "./saved-views.controller";

/** Per-person saved filters for the owner console's lists - packages/db/migrations/0108. */
@Module({
  controllers: [SavedViewsController],
})
export class SavedViewsModule {}
