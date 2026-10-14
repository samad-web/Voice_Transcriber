import { Module } from "@nestjs/common";
import { SupabaseAdminService } from "../owner/supabase-admin.service";
import { AdminController } from "./admin.controller";
import { AdminCallIssuesController } from "./admin-call-issues.controller";
import { AdminCommercialController } from "./admin-commercial.controller";
import { OperatorInvitesController } from "./operator-invites.controller";
import { OperatorInvitesService } from "./operator-invites.service";
import { OperatorsController } from "./operators.controller";

/**
 * Platform-operator (cross-tenant) surface.
 *
 * `SupabaseAdminService` is provided here rather than imported from
 * `OwnerModule`: it holds no state - two env vars and a `fetch` - so a second
 * instance costs nothing, and providing it locally keeps this module from
 * depending on the tenant-facing one just to mint a password.
 *
 * `OperatorInvitesService` (0145) is here for the same reason it is not in
 * OwnerModule: it is the invite path with no organization in it, so it shares
 * only the token, mail and acceptance-guard helpers with the tenant-scoped
 * `InvitesService`, and none of that module's org context.
 */
@Module({
  // `AdminCallIssuesController` (0147, doc 36) is the escalation queue: one work
  // list across every tenant, which is why it belongs to this module and not to
  // the tenant-facing one that holds its client-side half.
  controllers: [
    AdminController,
    OperatorsController,
    OperatorInvitesController,
    AdminCallIssuesController,
    // The commercial view (doc 49 P13c). Its own controller rather than more
    // routes on AdminController: it is one read that joins subscriptions,
    // the price list, billing orders, usage and the escalation queue, and
    // every query in it is scoped by operatorOrgScope.
    AdminCommercialController,
  ],
  providers: [SupabaseAdminService, OperatorInvitesService],
})
export class AdminModule {}
