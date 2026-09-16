import { Module } from "@nestjs/common";
import { RecycleBinController } from "./recycle-bin.controller";

/**
 * The recycle bin (migration 0108).
 *
 * No providers and no imports: `OwnerRoleGuard` gets `AuthService` from the
 * @Global() AuthModule, the same as LeadRoutingModule and OwnerModule. The
 * soft-delete helpers are plain functions in `common/`, not a service, because
 * they hold no state and every caller already has a client in hand.
 */
@Module({
  controllers: [RecycleBinController],
})
export class RecycleBinModule {}
