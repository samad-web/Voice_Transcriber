import { Module } from "@nestjs/common";
import { ResourcesController } from "./resources.controller";

/**
 * The first vertical primitive (Build docs/39 §23-§24, migration 0165).
 *
 * One module, one controller, no services: everything this surface does is a
 * statement or two inside a `withOrg` transaction, and a service layer here
 * would be a file whose only job is to forward a client it did not open.
 *
 * ── WHAT IS NOT HERE ────────────────────────────────────────────────────────
 *
 * No delete route (a resource is retired, never deleted - see the controller
 * header), and no custom-field routes. Typed fields on a resource go through
 * the EXISTING `/custom-fields` and `/custom-field-values` surface, which is
 * the entire point of widening `CustomFieldObjectType` rather than building a
 * second attribute system: 0165 creates `resource_custom_field_values` so
 * `valueTableForObjectType('resource')` resolves, and nothing else was needed.
 *
 * ── ONE FOLLOW-UP THAT IS NOT THIS MODULE'S TO MAKE ─────────────────────────
 *
 * `assertLookupTarget` in custom-field-values.controller.ts hard-codes
 * `["contact", "account", "deal"]`, so a LOOKUP field pointing at a resource
 * can be defined and then refuses every value with "lookup field has no valid
 * target object type". Its pluralisation (`${objectType}s`) already produces
 * the right table name, so the fix is that one array - but that file belongs
 * to another module and is not edited here.
 */
@Module({
  controllers: [ResourcesController],
})
export class ResourcesModule {}
