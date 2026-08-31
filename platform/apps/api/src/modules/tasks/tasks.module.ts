import { Module } from "@nestjs/common";
import { TasksController } from "./tasks.controller";

/** Follow-up tasks (Track A3) - packages/db/migrations/0041. */
@Module({
  controllers: [TasksController],
})
export class TasksModule {}
