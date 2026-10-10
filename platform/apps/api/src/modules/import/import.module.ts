import { Module } from "@nestjs/common";
import { ImportBatchController } from "./import-batch.controller";
import { ImportController } from "./import.controller";

/**
 * The import centre (0062, extended by 0182).
 *
 * No providers and no imports: `AuthService` - which both OwnerRoleGuard and
 * the controller's own errors check use to read a caller's persona from
 * `memberships` - comes from the @Global() AuthModule, the same as
 * RecycleBinModule and LeadRoutingModule.
 *
 * ── TWO CONTROLLERS, ONE PATH PREFIX ────────────────────────────────────────
 *
 * `ImportController` is 0062's one-shot route: parse, write and report in a
 * single request. `ImportBatchController` adds the staged flow
 * Build docs/indian-business-finance-documents-cycles-import §3 requires -
 * stage, dry run, commit, undo - because "finance data wrongly imported is
 * hard to unwind, so auto-detection should do the work and a person should
 * approve it once."
 *
 * They share the `import` prefix and the same guard trio, and they do NOT
 * share route names: the first owns `preview`/`run`/`:jobId`, the second owns
 * `stage`/`jobs/*`/`templates/*`. Nest matches in declaration order, so
 * `ImportBatchController`'s `jobs/:jobId/...` would be shadowed by the
 * other's bare `:jobId` if that one were declared first - which is why the
 * batch controller is listed first and why neither declares a route the other
 * could claim.
 */
@Module({
  controllers: [ImportBatchController, ImportController],
})
export class ImportModule {}
