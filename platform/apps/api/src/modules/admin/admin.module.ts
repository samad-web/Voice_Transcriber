import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller";

/** Platform-operator (cross-tenant) surface. */
@Module({
  controllers: [AdminController],
})
export class AdminModule {}
