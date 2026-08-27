import { Module } from "@nestjs/common";
import { MetaOAuthController } from "./meta-oauth.controller";
import { MetaWebhookController } from "./meta-webhook.controller";

@Module({
  controllers: [MetaOAuthController, MetaWebhookController],
})
export class MetaAdsModule {}
