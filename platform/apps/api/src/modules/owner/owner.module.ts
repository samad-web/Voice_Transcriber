import { Module } from "@nestjs/common";
import { LeadsController } from "./leads.controller";
import { OwnerController } from "./owner.controller";
import { OwnersController } from "./owners.controller";
import { SupabaseAdminService } from "./supabase-admin.service";

/**
 * The customer-owner surface: the lead pipeline, the instance's own rollup,
 * and the logins that scope both to one tenant.
 */
@Module({
  controllers: [LeadsController, OwnerController, OwnersController],
  providers: [SupabaseAdminService],
})
export class OwnerModule {}
