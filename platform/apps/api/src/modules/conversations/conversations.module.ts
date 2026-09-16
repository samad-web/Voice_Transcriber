import { Module } from "@nestjs/common";
import { PublicApiModule } from "../public-api/public-api.module";
import { ConversationsController } from "./conversations.controller";
import { ConversationsService } from "./conversations.service";
import { EmbeddedSignupController } from "./embedded-signup.controller";
import { MessagingChannelsController } from "./messaging-channels.controller";
import { MessagingWebhookController } from "./messaging-webhook.controller";
import { ConversationQualificationController } from "./conversation-qualification.controller";
import { OptOutsController } from "./opt-outs.controller";
import { WhatsAppSendController } from "./whatsapp-send.controller";

/**
 * The inbound messaging inbox - packages/db/migrations/0055 and 0056 - plus
 * the outbound WhatsApp send path added for Wasi (0061). WhatsAppSendController
 * is deliberately its OWN controller, not a method on ConversationsController:
 * that controller's header states "there is no send route here, on purpose,"
 * and that sentence needs to stay true of the file it's written in.
 *
 * ConversationQualificationController (0080) is separate for the same kind of
 * reason and one more: it is the only route in the platform that turns an
 * inbound WhatsApp thread into a CRM record, and it does so only when a
 * signed-in person approves. PublicApiModule is imported for `CrmIngestService`
 * rather than re-provided, so approving a qualification and `POST /public/leads`
 * cannot drift into two definitions of what creating a lead means - the same
 * call the lead intake engine made in 0078.
 */
@Module({
  imports: [PublicApiModule],
  controllers: [
    ConversationQualificationController,
    ConversationsController,
    MessagingChannelsController,
    EmbeddedSignupController,
    MessagingWebhookController,
    WhatsAppSendController,
    OptOutsController,
  ],
  providers: [ConversationsService],
})
export class ConversationsModule {}
