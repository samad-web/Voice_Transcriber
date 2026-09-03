import { Module } from "@nestjs/common";
import { LeadIntakeModule } from "../lead-intake/lead-intake.module";
import { MetaOAuthController } from "./meta-oauth.controller";
import { MetaWebhookController } from "./meta-webhook.controller";

/**
 * Imports LeadIntakeModule so the webhook writes through the SAME service every
 * other channel uses. Before migration 0078 this module had its own INSERTs and
 * created contacts and deals but no `leads` row - which is why no Meta lead has
 * ever appeared on /owner/board or /owner/leads.
 */
@Module({
  imports: [LeadIntakeModule],
  controllers: [MetaOAuthController, MetaWebhookController],
})
export class MetaAdsModule {}
