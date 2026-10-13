import { Module } from "@nestjs/common";
import { BillingController } from "./billing.controller";
import { BillingOrdersService } from "./billing-orders.service";
import { PlatformBillingAdminController } from "./platform-billing-admin.controller";
import { PlatformBillingWebhookController } from "./platform-billing-webhook.controller";
import { SubscriptionController } from "./subscription.controller";

/**
 * Usage metering + billing (§2.7 / §10) and, since 0197, the published capture
 * price list and the payment layer behind it.
 *
 * `EntitlementsService` is injected without an import because
 * `EntitlementsModule` is `@Global` - see its header for why that exception
 * exists. This module needs it for exactly two things: resolving a plan key to
 * its catalogue id, and invalidating a tenant's cached plan the moment an
 * order settles. The second is the important one - §9.6 asks an upgrade to
 * unlock "within seconds", and without the invalidation a tenant who just paid
 * waits out the 30-second cache TTL wondering whether it worked.
 *
 * `BillingOrdersService` is EXPORTED because the operator console settles
 * manual orders through the same service (`plan-admin.controller.ts`), which is
 * what keeps "grant what this order bought" a single implementation shared
 * with the webhook.
 */
@Module({
  controllers: [
    BillingController,
    SubscriptionController,
    PlatformBillingAdminController,
    PlatformBillingWebhookController,
  ],
  providers: [BillingOrdersService],
  exports: [BillingOrdersService],
})
export class BillingModule {}
