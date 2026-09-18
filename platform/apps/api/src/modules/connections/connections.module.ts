import { Module } from "@nestjs/common";
import { ConnectionsController } from "./connections.controller";
import { OAuthAppsController } from "./oauth-apps.controller";
import { OutboundMailController } from "./outbound-mail.controller";

/**
 * A user's own email/calendar accounts (PRD Layer 1). Migration 0043.
 *
 * Sending is a separate controller from connecting, because it answers to a
 * different guard: connecting is about the caller's own account and needs no
 * CRM grant, while sending writes to a contact's timeline and is gated on
 * `contact:edit`. See outbound-mail.controller.ts for what it refuses to do.
 *
 * The organisation's own OAuth apps (0120) are a third controller for the same
 * reason: they are owner-only, a gate neither of the other two carries.
 */
@Module({
  controllers: [ConnectionsController, OAuthAppsController, OutboundMailController],
})
export class ConnectionsModule {}
