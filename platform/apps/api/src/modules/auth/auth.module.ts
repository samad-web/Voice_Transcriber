import { Global, Module } from "@nestjs/common";
import { OrgRegistryService } from "../../common/org-registry.service";
import { ApiKeysController } from "./apikeys.controller";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";

/**
 * Global so AuthService is injectable by AdminKeyGuard wherever it's used.
 * Real session + RBAC live here; OIDC replaces only the login identity source.
 * OrgRegistryService rides along for the same reason - the guard needs it on
 * every module that mounts it.
 */
@Global()
@Module({
  controllers: [ApiKeysController, AuthController],
  providers: [AuthService, OrgRegistryService],
  exports: [AuthService, OrgRegistryService],
})
export class AuthModule {}
