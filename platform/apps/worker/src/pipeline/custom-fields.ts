/**
 * The facts -> typed custom-field projection (Track A4) now lives in @aura/db
 * (packages/db/src/crm-projection.ts), beside the Contact/Deal projection that
 * calls it, so the API's intake paths populate custom fields too (doc 23, B3).
 * Re-exported here for existing importers and custom-fields.test.ts.
 */
export { projectFactsToCustomFields, type CustomFieldProjection } from "@aura/db";
