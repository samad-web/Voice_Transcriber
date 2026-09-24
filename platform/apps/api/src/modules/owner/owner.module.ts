import { Module } from "@nestjs/common";
import { AgentsModule } from "../agents/agents.module";
import { PublicApiModule } from "../public-api/public-api.module";
import { RolesModule } from "../roles/roles.module";
import { LeadBoardsController } from "./lead-boards.controller";
import { CallInsightsController } from "./call-insights.controller";
import { CallSopsController } from "./call-sops.controller";
import { OwnerCallsController } from "./owner-calls.controller";
import { CallTriageController } from "./call-triage.controller";
import { CallDispositionsController } from "./call-dispositions.controller";
import { IntegrationsController } from "./integrations.controller";
import { OrgFeaturesController } from "./org-features.controller";
import { TelecallerProductivityController } from "./telecaller-productivity.controller";
import { OwnerRolesController } from "./owner-roles.controller";
import { OwnerTeamController } from "./owner-team.controller";
import { OwnerInvitesController } from "./owner-invites.controller";
import { AuthInvitesController } from "./auth-invites.controller";
import { InvitesService } from "./invites.service";
import { StaffPerformanceController } from "./staff-performance.controller";
import { LeadsController } from "./leads.controller";
import { OwnerController } from "./owner.controller";
import { OwnersController } from "./owners.controller";
import { OwnerAccountsService } from "./owner-accounts.service";
import { SetupController } from "./setup.controller";
import { BusinessProfileController } from "./business-profile.controller";
import { PlanUsageController } from "./plan-usage.controller";
import { TimeSettingsController } from "./time-settings.controller";
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
  // AgentsModule for the call drawer's reply drafter (0121). PublicApiModule
  // for CrmIngestService: the console's "New lead" writes through the same
  // service every other door does (0136).
  imports: [RolesModule, AgentsModule, PublicApiModule],
  controllers: [
    CallInsightsController,
    TelecallerProductivityController,
    CallSopsController,
    OwnerCallsController,
    CallTriageController,
    CallDispositionsController,
    IntegrationsController,
    OrgFeaturesController,
    OwnerRolesController,
    OwnerTeamController,
    // 0137: invite by link, finish with Google - the owner's half and the
    // invitee's (server-to-server from the public invite page).
    OwnerInvitesController,
    AuthInvitesController,
    StaffPerformanceController,
    LeadsController,
    LeadBoardsController,
    OwnerController,
    OwnersController,
    SetupController,
    // Doc 27: the account menu's Business profile and Plan & usage pages.
    BusinessProfileController,
    PlanUsageController,
    TimeSettingsController,
  ],
  providers: [OwnerAccountsService, SupabaseAdminService, InvitesService],
})
export class OwnerModule {}
