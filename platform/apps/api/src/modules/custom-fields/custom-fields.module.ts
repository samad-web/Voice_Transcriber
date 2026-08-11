import { Module } from "@nestjs/common";
import { CustomFieldsController } from "./custom-fields.controller";

/** CRM Phase 1 foundation (E0.2) — org-definable fields on Contact/Account/Deal. */
@Module({
  controllers: [CustomFieldsController],
})
export class CustomFieldsModule {}
