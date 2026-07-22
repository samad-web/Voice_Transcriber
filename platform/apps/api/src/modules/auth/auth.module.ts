import { Global, Module } from "@nestjs/common";
import { ApiKeysController } from "./apikeys.controller";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";

/**
 * Global so AuthService is injectable by AdminKeyGuard wherever it's used.
 * Real session + RBAC live here; OIDC replaces only the login identity source.
 */
@Global()
@Module({
  controllers: [ApiKeysController, AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
