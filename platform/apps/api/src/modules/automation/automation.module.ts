import { Module } from "@nestjs/common";
import { AutomationController } from "./automation.controller";

/**
 * Workflow automation (PRD Layer 2, migration 0049).
 *
 * The API owns the RULES and the run log. It does not execute anything: the
 * worker drains `automation_events` and does the work, so a tenant's own
 * configuration can never slow down or fail a console request. See
 * enqueue.ts and apps/worker/src/pipeline/automation.ts.
 */
@Module({
  controllers: [AutomationController],
})
export class AutomationModule {}
