import { Module } from "@nestjs/common";
import { RolesModule } from "../roles/roles.module";
import { CallSopsController } from "./call-sops.controller";
import { OwnerCallsController } from "./owner-calls.controller";
import { CallTriageController } from "./call-triage.controller";
import { CallDispositionsController } from "./call-dispositions.controller";
import { IntegrationsController } from "./integrations.controller";
import { OrgFeaturesController } from "./org-features.controller";
import { TelecallerProductivityController } from "./telecaller-productivity.controller";
import { OwnerRolesController } from "./owner-roles.controller";
import { OwnerTeamController } from "./owner-team.controller";
import { StaffPerformanceController } from "./staff-performance.controller";
import { LeadsController } from "./leads.controller";
import { OwnerController } from "./owner.controller";
import { OwnersController } from "./owners.controller";
import { OwnerAccountsService } from "./owner-accounts.service";
import { SetupController } from "./setup.controller";
import { SupabaseAdminService } from "./supabase-admin.service";

/**
 * The customer-owner surface: the lead pipeline, the client's own call log,
 * the instance's rollup, the Staff section (roster, permission grid,
 * scorecard), the feature switchboard, the new-client setup checklist, and the
 * logins that scope all of it to one tenant.
 *
 * `RolesModule` is imported for `RolesService` alone - the client's roles
 * controller and the operator's must behave identically, and that file explains
 * why they are nevertheless two controllers.
 */
@Module({
  imports: [RolesModule],
  controllers: [
    TelecallerProductivityController,
    CallSopsController,
    OwnerCallsController,
    CallTriageController,
    CallDispositionsController,
    IntegrationsController,
    OrgFeaturesController,
    OwnerRolesController,
    OwnerTeamController,
    StaffPerformanceController,
    LeadsController,
    OwnerController,
    OwnersController,
    SetupController,
  ],
  providers: [OwnerAccountsService, SupabaseAdminService],
})
export class OwnerModule {}
