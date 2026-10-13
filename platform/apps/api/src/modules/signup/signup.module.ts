import { Module } from "@nestjs/common";
import { DbModule } from "../../db/db.module";
import { InvitesService } from "../owner/invites.service";
import { SupabaseAdminService } from "../owner/supabase-admin.service";
import { PublicSignupController } from "./public-signup.controller";
import { SignupReconcileService } from "./signup-reconcile.service";
import { SignupService } from "./signup.service";

/**
 * Self-serve purchase and provisioning.
 *
 * `InvitesService` is PROVIDED here rather than imported from `OwnerModule`,
 * which exports nothing and whose own comment sets the convention: these
 * services hold no state - a DbService and a SupabaseAdminService - so a second
 * instance costs nothing, and importing the tenant-facing module into this one
 * would point the dependency the wrong way. This module is reached by people
 * who do not have a tenant yet.
 *
 * What is NOT re-implemented is the invite itself. `invited_by` NULL with no
 * existing membership is already how an operator invites a customer's first
 * owner; it is tested, and its hashing, expiry and single-use are settled. A
 * second token system here would be a second copy of those bugs.
 */
@Module({
  imports: [DbModule],
  controllers: [PublicSignupController],
  providers: [SignupService, SignupReconcileService, InvitesService, SupabaseAdminService],
  exports: [SignupService],
})
export class SignupModule {}
