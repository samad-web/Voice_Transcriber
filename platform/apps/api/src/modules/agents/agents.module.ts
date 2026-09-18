import { Module } from "@nestjs/common";
import { AgentsController } from "./agents.controller";
import { AgentsService } from "./agents.service";
import { OwnerAgentsController } from "./owner-agents.controller";

/**
 * Both AI Agent Studios - the operator's (`/agents`, any tenant) and the
 * tenant's own (`/owner/agents`, migration 0121) - over one service.
 */
@Module({
  controllers: [AgentsController, OwnerAgentsController],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
