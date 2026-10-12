import { Global, Module } from "@nestjs/common";
import { EntitlementsController } from "./entitlements.controller";
import { EntitlementsService } from "./entitlements.service";
import { PlanAdminController } from "./plan-admin.controller";

/**
 * Plans, entitlements and usage (migration 0192, M1).
 *
 * ── @Global, WHICH IS A DELIBERATE EXCEPTION ────────────────────────────────
 *
 * Almost nothing in this API is a global module, and for good reason: a global
 * provider is one you cannot see being imported, so a module's dependencies
 * stop being readable from its own file.
 *
 * `EntitlementsService` earns the exception because `EntitlementGuard` is
 * mounted by ROUTE, anywhere, and a guard's dependencies are resolved from the
 * module that declares the controller. Without @Global, adding
 * `@RequireEntitlement` to any route in any of the forty modules would also
 * mean adding an import to that module - and forgetting it produces a runtime
 * "cannot resolve dependency" at boot rather than a compile error.
 *
 * A gate that is awkward to mount is a gate people route around. The same
 * argument the feature-gate framework's own module makes.
 */
@Global()
@Module({
  controllers: [EntitlementsController, PlanAdminController],
  providers: [EntitlementsService],
  exports: [EntitlementsService],
})
export class EntitlementsModule {}
