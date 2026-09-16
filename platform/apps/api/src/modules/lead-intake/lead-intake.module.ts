import { Module } from "@nestjs/common";
import { PublicApiModule } from "../public-api/public-api.module";
import { IntakeWebhookController } from "./intake-webhook.controller";
import { LeadIntakeService } from "./lead-intake.service";
import { LeadSourcesController } from "./lead-sources.controller";
import { LinkedInOAuthController } from "./linkedin-oauth.controller";

/**
 * The lead intake engine - migration 0078.
 *
 * Imports PublicApiModule for `CrmIngestService` rather than re-providing it:
 * one instance, one write path, and no chance of the intake engine and
 * `POST /public/leads` drifting into two different definitions of what
 * creating a lead means.
 *
 * `LeadIntakeService` is exported because the Meta webhook writes through it
 * too - which is what finally puts ad leads on the lead board (see 0078's
 * header for the four years of leads that never got there).
 */
@Module({
  imports: [PublicApiModule],
  controllers: [IntakeWebhookController, LeadSourcesController, LinkedInOAuthController],
  providers: [LeadIntakeService],
  exports: [LeadIntakeService],
})
export class LeadIntakeModule {}
