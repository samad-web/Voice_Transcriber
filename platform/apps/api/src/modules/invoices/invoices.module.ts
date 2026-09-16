import { Module } from "@nestjs/common";
import { InvoicesController } from "./invoices.controller";
import { PaymentSettingsController } from "./payment-settings.controller";
import { PaymentsController } from "./payments.controller";
import { RazorpayWebhookController } from "./razorpay-webhook.controller";

@Module({
  controllers: [
    InvoicesController,
    PaymentsController,
    PaymentSettingsController,
    RazorpayWebhookController,
  ],
})
export class InvoicesModule {}
