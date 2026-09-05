import { Module } from "@nestjs/common";
import { SupabaseAdminService } from "../owner/supabase-admin.service";
import { AdminController } from "./admin.controller";
import { OperatorsController } from "./operators.controller";

/**
 * Platform-operator (cross-tenant) surface.
 *
 * `SupabaseAdminService` is provided here rather than imported from
 * `OwnerModule`: it holds no state - two env vars and a `fetch` - so a second
 * instance costs nothing, and providing it locally keeps this module from
 * depending on the tenant-facing one just to mint a password.
 */
@Module({
  controllers: [AdminController, OperatorsController],
  providers: [SupabaseAdminService],
})
export class AdminModule {}
