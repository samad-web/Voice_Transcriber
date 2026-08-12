import { Module } from "@nestjs/common";
import { ConnectionsController } from "./connections.controller";
import { OutboundMailController } from "./outbound-mail.controller";

/**
 * A user's own email/calendar accounts (PRD Layer 1). Migration 0043.
 *
 * Sending is a separate controller from connecting, because it answers to a
 * different guard: connecting is about the caller's own account and needs no
 * CRM grant, while sending writes to a contact's timeline and is gated on
 * `contact:edit`. See outbound-mail.controller.ts for what it refuses to do.
 */
@Module({
  controllers: [ConnectionsController, OutboundMailController],
})
export class ConnectionsModule {}
