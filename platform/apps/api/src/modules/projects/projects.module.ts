import { Module } from "@nestjs/common";
import { ProjectsController } from "./projects.controller";

/** The tenant's project catalogue - packages/db/migrations/0073. */
@Module({
  controllers: [ProjectsController],
})
export class ProjectsModule {}
