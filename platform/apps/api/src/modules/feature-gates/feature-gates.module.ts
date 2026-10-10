import { Module } from "@nestjs/common";
import { FeatureGateService } from "../../common/feature-gate.service";
import { FeatureGatesController } from "./feature-gates.controller";

/**
 * The GENERIC gate's admin surface (Build docs/transcript-agent-build-plan
 * §3A, migration 0184).
 *
 * ── WHY `FeatureGateService` IS PROVIDED **AND** EXPORTED ───────────────────
 *
 * Exported because §3A.4's whole point is that one service answers the
 * question for every layer: `FeatureGateGuard` needs it, the transcript-agent
 * module needs it, the callbacks module needs it, and all three must share the
 * SAME INSTANCE - the invalidation cache is per-instance, and a second copy
 * would go on serving a stale decision after an owner flipped a switch.
 *
 * It is a provider here rather than in a `common/` module because that is this
 * codebase's shape: guards live in `common/` as classes and are wired per
 * module. Importing this module is how another module gets the service.
 *
 * ── AND WHY THIS MODULE IS NOT ITSELF GATED ────────────────────────────────
 *
 * The controller's header has the argument: gating the screen that turns the
 * feature on behind the feature being on is a workspace one click from needing
 * an operator with a SQL prompt to recover. It is the single documented
 * exemption in `agent-gate-coverage.spec.ts`.
 */
@Module({
  controllers: [FeatureGatesController],
  providers: [FeatureGateService],
  exports: [FeatureGateService],
})
export class FeatureGatesModule {}
