import { SignupModule } from "../signup/signup.module";
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
  // SignupModule, for `SignupService`: the platform webhook is where a
  // self-serve payment becomes a tenant, so the controller that verifies the
  // signature is also the one that has to provision. The dependency points this
  // way round because signup knows nothing about billing orders, while billing
  // has to know a payment might belong to someone who is not a tenant yet.
  imports: [SignupModule],
  providers: [BillingOrdersService],
  exports: [BillingOrdersService],
})
export class BillingModule {}
