import { Module } from "@nestjs/common";
import { RolesController } from "./roles.controller";
import { RolesService } from "./roles.service";

/**
 * Roles & permissions (CRM Phase 1, E0.4). The grid is no longer inert:
 * `CrmPermissionsGuard` enforces it, and the owner console assigns it.
 *
 * `RolesService` is exported because `OwnerModule` mounts the client-facing
 * half of this surface (`/v1/owner/roles`) at a different guard tier - see the
 * service's header for why that is two controllers rather than one.
 */
@Module({
  controllers: [RolesController],
  providers: [RolesService],
  exports: [RolesService],
})
export class RolesModule {}
