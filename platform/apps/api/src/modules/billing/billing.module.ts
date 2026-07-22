import { Module } from "@nestjs/common";
import { BillingController } from "./billing.controller";

/** Usage metering + billing (§2.7 / §10). */
@Module({
  controllers: [BillingController],
})
export class BillingModule {}
