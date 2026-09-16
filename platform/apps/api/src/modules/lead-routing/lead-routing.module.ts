import { Module } from "@nestjs/common";
import { LeadRoutingController } from "./lead-routing.controller";

/**
 * Automated lead distribution (migration 0105).
 *
 * No providers and no imports. `AuthService`, which `OwnerRoleGuard` uses to
 * derive the caller's persona from `memberships` rather than trusting the
 * header the request sends, comes from `@Global()` AuthModule - the same
 * reason OwnerModule declares no imports either.
 *
 * The engine itself is not a provider here on purpose: it lives in `@aura/db`
 * so the worker's LinkedIn sweep calls the same implementation the API does.
 * See `packages/db/src/lead-routing.ts` for why that is not a Nest service.
 */
@Module({
  controllers: [LeadRoutingController],
})
export class LeadRoutingModule {}
