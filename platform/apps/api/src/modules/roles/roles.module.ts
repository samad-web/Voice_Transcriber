import { Module } from "@nestjs/common";
import { RolesController } from "./roles.controller";

/** CRM Phase 1 foundation (E0.4) — roles/permissions, schema+CRUD only (inert, not enforced). */
@Module({
  controllers: [RolesController],
})
export class RolesModule {}
