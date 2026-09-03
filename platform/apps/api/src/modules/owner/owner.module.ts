import { Module } from "@nestjs/common";
import { OwnerCallsController } from "./owner-calls.controller";
import { OwnerTeamController } from "./owner-team.controller";
import { LeadsController } from "./leads.controller";
import { OwnerController } from "./owner.controller";
import { OwnersController } from "./owners.controller";
import { SupabaseAdminService } from "./supabase-admin.service";

/**
 * The customer-owner surface: the lead pipeline, the client's own call log,
 * the instance's rollup, the workspace's own team roster, and the logins that
 * scope all of it to one tenant.
 */
@Module({
  controllers: [
    OwnerCallsController,
    OwnerTeamController,
    LeadsController,
    OwnerController,
    OwnersController,
  ],
  providers: [SupabaseAdminService],
})
export class OwnerModule {}
