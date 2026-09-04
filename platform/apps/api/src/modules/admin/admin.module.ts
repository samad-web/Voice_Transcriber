import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller";
import { OperatorsController } from "./operators.controller";

/** Platform-operator (cross-tenant) surface. */
@Module({
  controllers: [AdminController, OperatorsController],
})
export class AdminModule {}
