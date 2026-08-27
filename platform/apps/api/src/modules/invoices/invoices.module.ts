import { Module } from "@nestjs/common";
import { InvoicesController } from "./invoices.controller";
import { PaymentsController } from "./payments.controller";
import { RazorpayWebhookController } from "./razorpay-webhook.controller";

@Module({
  controllers: [InvoicesController, PaymentsController, RazorpayWebhookController],
})
export class InvoicesModule {}
