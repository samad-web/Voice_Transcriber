import { Module } from "@nestjs/common";
import { ImportController } from "./import.controller";

/**
 * Bulk CSV import (0062).
 *
 * No providers and no imports: `AuthService` - which both OwnerRoleGuard and
 * the controller's own errors check use to read a caller's persona from
 * `memberships` - comes from the @Global() AuthModule, the same as
 * RecycleBinModule and LeadRoutingModule.
 */
@Module({
  controllers: [ImportController],
})
export class ImportModule {}
