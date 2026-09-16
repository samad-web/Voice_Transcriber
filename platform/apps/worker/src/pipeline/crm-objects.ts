/**
 * The Lead -> Contact/Deal projection now lives in @aura/db
 * (packages/db/src/crm-projection.ts), so the API's intake paths write through
 * the same functions the call pipeline does (doc 23, B3).
 *
 * This module stays as a re-export for its existing importers: pipeline.ts,
 * lead-intake.ts, meta-mcp-sync.ts, the tests that `vi.mock("./crm-objects")`,
 * and scripts/backfill-crm-objects.js, which requires the compiled file by path.
 */
export {
  projectCallToInteraction,
  projectLeadToCrm,
  type CrmObjectProjection,
  type ProjectLeadOptions,
} from "@aura/db";
