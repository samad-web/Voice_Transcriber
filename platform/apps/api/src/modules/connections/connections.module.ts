import { Module } from "@nestjs/common";
import { ConnectionsController } from "./connections.controller";

/** A user's own email/calendar accounts (PRD Layer 1). Migration 0043. */
@Module({
  controllers: [ConnectionsController],
})
export class ConnectionsModule {}
