import { Module } from "@nestjs/common";
import { CallSopsController } from "./call-sops.controller";
import { OwnerCallsController } from "./owner-calls.controller";
import { TelecallerProductivityController } from "./telecaller-productivity.controller";
import { OwnerTeamController } from "./owner-team.controller";
import { LeadsController } from "./leads.controller";
import { OwnerController } from "./owner.controller";
import { OwnersController } from "./owners.controller";
import { OwnerAccountsService } from "./owner-accounts.service";
import { SupabaseAdminService } from "./supabase-admin.service";

/**
 * The customer-owner surface: the lead pipeline, the client's own call log,
 * the instance's rollup, the workspace's own team roster, and the logins that
 * scope all of it to one tenant.
 */
@Module({
  controllers: [
    TelecallerProductivityController,
    CallSopsController,
    OwnerCallsController,
    OwnerTeamController,
    LeadsController,
    OwnerController,
    OwnersController,
  ],
  providers: [OwnerAccountsService, SupabaseAdminService],
})
export class OwnerModule {}
