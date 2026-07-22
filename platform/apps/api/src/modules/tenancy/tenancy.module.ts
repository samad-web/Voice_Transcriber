import { Module } from "@nestjs/common";
import { ErasureController } from "./erasure.controller";
import { MembersController } from "./members.controller";
import { TenancyController } from "./tenancy.controller";
import { WorkspacesController } from "./workspaces.controller";

@Module({
  controllers: [TenancyController, ErasureController, WorkspacesController, MembersController],
})
export class TenancyModule {}
