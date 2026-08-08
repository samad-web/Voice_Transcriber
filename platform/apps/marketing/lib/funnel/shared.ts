/**
 * The funnel's pure logic, re-exported from `@aura/shared`.
 *
 * ── Why the deep path, and not `@aura/shared` ────────────────────────────────
 * `@aura/shared`'s entry point is a CommonJS barrel (`main: ./dist/index.js`,
 * `module: CommonJS`). CJS barrels do not tree-shake. Importing the package root
 * from a Client Component would therefore pull `crm-providers.ts` — ~1,000 lines
 * of connector endpoints, auth schemes and field maps — plus every zod schema in
 * `extraction.ts` and `entities.ts` into the browser bundle, for the sake of a
 * name regex.
 *
 * Doc 16 §4 sets the budget explicitly: the buyer is on a mid-range Android over
 * 4G, and `libphonenumber-js` was rejected at ~145 KB. Shipping the whole shared
 * package to win that argument and then lose it by accident would be absurd.
 *
 * So the funnel imports ONE compiled module by path. It is a workspace package
 * with no `exports` map, so the deep path is stable, and `funnel.ts` is
 * deliberately dependency-free (see its header) — nothing else comes with it.
 *
 * Everything re-exported here is safe on both sides of the boundary: pure
 * functions and data, no Node built-ins, no secrets, no I/O. The SERVER-ONLY
 * parts of the funnel live in ./db.ts, ./repository.ts and ./session.ts, each of
 * which imports `server-only` so a stray client import fails the build rather
 * than leaking a connection string.
 */
export {
  BUDGET_BANDS,
  BUSINESS_TYPES,
  FUNNEL_COUNTRIES,
  FUNNEL_CRM_OPTIONS,
  FUNNEL_VARIANTS,
  HAS_CRM_OPTIONS,
  INTENTS,
  NAME_PATTERN,
  QUALIFYING_BUDGET_INR,
  TEAM_SIZES,
  WANTS_CUSTOM_CRM_OPTIONS,
  classifyCrm,
  coerceOption,
  findCountry,
  isDisposableEmailDomain,
  isE164,
  normalizeEmail,
  normalizeName,
  normalizePhoneDigits,
  qualify,
  validateEmail,
  validateName,
  validatePhone,
} from "@aura/shared/dist/funnel";

export type {
  BudgetBand,
  BusinessType,
  CrmConnectorStatus,
  CrmSatisfaction,
  FunnelCountry,
  FunnelCrmOption,
  FunnelOption,
  FunnelStatus,
  FunnelVariant,
  HasCrm,
  Intent,
  QualificationAnswers,
  QualificationResult,
  TeamSize,
  ValidationResult,
  WantsCustomCrm,
} from "@aura/shared/dist/funnel";
