import { Module } from "@nestjs/common";
import { ConversationsController } from "./conversations.controller";
import { ConversationsService } from "./conversations.service";
import { MessagingChannelsController } from "./messaging-channels.controller";
import { MessagingWebhookController } from "./messaging-webhook.controller";
import { WhatsAppSendController } from "./whatsapp-send.controller";

/**
 * The inbound messaging inbox - packages/db/migrations/0055 and 0056 - plus
 * the outbound WhatsApp send path added for Wasi (0061). WhatsAppSendController
 * is deliberately its OWN controller, not a method on ConversationsController:
 * that controller's header states "there is no send route here, on purpose,"
 * and that sentence needs to stay true of the file it's written in.
 */
@Module({
  controllers: [
    ConversationsController,
    MessagingChannelsController,
    MessagingWebhookController,
    WhatsAppSendController,
  ],
  providers: [ConversationsService],
})
export class ConversationsModule {}
