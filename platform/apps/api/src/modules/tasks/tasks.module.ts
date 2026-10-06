import { Module } from "@nestjs/common";
import { TaskSettingsController } from "./task-settings.controller";
import { TasksController } from "./tasks.controller";

/** Follow-up tasks (Track A3) - packages/db/migrations/0041. */
@Module({
  controllers: [TasksController, TaskSettingsController],
})
export class TasksModule {}
