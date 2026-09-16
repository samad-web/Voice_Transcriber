import { Module } from "@nestjs/common";
import { CallSopsController } from "./call-sops.controller";
import { OwnerCallsController } from "./owner-calls.controller";
import { OwnerTeamController } from "./owner-team.controller";
import { LeadsController } from "./leads.controller";
import { OwnerController } from "./owner.controller";
import { OwnersController } from "./owners.controller";
import { SetupController } from "./setup.controller";
import { TelecallerProductivityController } from "./telecaller-productivity.controller";
import { SupabaseAdminService } from "./supabase-admin.service";

/**
 * The customer-owner surface: the lead pipeline, the client's own call log,
 * the instance's rollup, the workspace's own team roster, the per-person
 * productivity read, the new-client setup checklist, and the logins that scope
 * all of it to one tenant.
 */
@Module({
  controllers: [
    OwnerCallsController,
    OwnerTeamController,
    LeadsController,
    OwnerController,
    OwnersController,
    TelecallerProductivityController,
    CallSopsController,
    SetupController,
  ],
  providers: [SupabaseAdminService],
})
export class OwnerModule {}
