import { Module } from "@nestjs/common";
import { OwnerCallsController } from "./owner-calls.controller";
import { LeadsController } from "./leads.controller";
import { OwnerController } from "./owner.controller";
import { OwnersController } from "./owners.controller";
import { SupabaseAdminService } from "./supabase-admin.service";

/**
 * The customer-owner surface: the lead pipeline, the client's own call log,
 * the instance's rollup, and the logins that scope all of it to one tenant.
 */
@Module({
  controllers: [OwnerCallsController, LeadsController, OwnerController, OwnersController],
  providers: [SupabaseAdminService],
})
export class OwnerModule {}
