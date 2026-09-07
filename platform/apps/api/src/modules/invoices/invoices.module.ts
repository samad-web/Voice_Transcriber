import { Module } from "@nestjs/common";
import { InvoicesController } from "./invoices.controller";
import { PaymentsController } from "./payments.controller";
import { RazorpayWebhookController } from "./razorpay-webhook.controller";
import { StripeWebhookController } from "./stripe-webhook.controller";

@Module({
  controllers: [
    InvoicesController,
    PaymentsController,
    RazorpayWebhookController,
    StripeWebhookController,
  ],
})
export class InvoicesModule {}
