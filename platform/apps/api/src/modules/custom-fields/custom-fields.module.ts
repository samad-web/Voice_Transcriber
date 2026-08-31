import { Module } from "@nestjs/common";
import { CustomFieldsController } from "./custom-fields.controller";
import { CustomFieldValuesController } from "./custom-field-values.controller";

/**
 * CRM Phase 1 foundation (E0.2) - org-definable fields on Contact/Account/Deal.
 *
 * Two controllers, split along the line that matters: DEFINITIONS are org
 * configuration an admin edits once, VALUES are record data a rep edits all
 * day. They carry different permissions (the definitions surface is
 * admin-key-only; the values surface is gated on the record's own
 * `view`/`edit` grant) and different route shapes, so they are not one file.
 */
@Module({
  controllers: [CustomFieldsController, CustomFieldValuesController],
})
export class CustomFieldsModule {}
