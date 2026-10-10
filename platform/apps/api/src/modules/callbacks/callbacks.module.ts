import { Module } from "@nestjs/common";
import { FeatureGatesModule } from "../feature-gates/feature-gates.module";
import { CallbacksController } from "./callbacks.controller";
import { CallbacksService } from "./callbacks.service";

/**
 * The managed to-call list (Build docs/transcript-agent-build-plan §10A,
 * migration 0186).
 *
 * ── IT IMPORTS `FeatureGatesModule` RATHER THAN PROVIDING THE SERVICE ──────
 *
 * `FeatureGateGuard` needs `FeatureGateService`, and it has to be the SAME
 * INSTANCE the admin controller invalidates - the cache is per-instance, so a
 * second copy would go on serving a stale decision after an owner flipped a
 * switch. §3A.4's five-second propagation is only true if there is one
 * instance.
 *
 * ── AND THE SERVICE IS EXPORTED ────────────────────────────────────────────
 *
 * The worker does not import it (it is a separate process with its own code
 * path), but the transcript-agent module does: `schedule_callback` is one of
 * §10's tools, and the review queue approves one by calling the same create
 * path a telecaller's console does. Two implementations of "make a callback"
 * is how one of them stops planning reminders.
 */
@Module({
  imports: [FeatureGatesModule],
  controllers: [CallbacksController],
  providers: [CallbacksService],
  exports: [CallbacksService],
})
export class CallbacksModule {}
