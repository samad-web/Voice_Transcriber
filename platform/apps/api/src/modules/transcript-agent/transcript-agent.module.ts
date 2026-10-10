import { Module } from "@nestjs/common";
import { CallbacksModule } from "../callbacks/callbacks.module";
import { FeatureGatesModule } from "../feature-gates/feature-gates.module";
import { TranscriptAgentController } from "./transcript-agent.controller";

/**
 * The review inbox, the configuration and the accuracy reporting
 * (Build docs/transcript-agent-build-plan §8.2, §12, §13; migration 0185).
 *
 * ── WHAT IS NOT HERE ───────────────────────────────────────────────────────
 *
 * No executor, and no sender of any kind. Approving a suggestion marks it
 * `approved`; the worker runs it, behind its own gate re-check. The controller
 * header has the argument - an approval that executed inline would do it on a
 * request a person is waiting on, with no retry and no idempotent claim, and a
 * booking that half-happened because a browser tab closed is exactly the
 * customer-visible half-done state §10 forbids.
 *
 * ── AND WHY IT IMPORTS `CallbacksModule` ───────────────────────────────────
 *
 * `schedule_callback` is one of §10's tools, and a callback approved from the
 * review queue has to be created by the SAME code path a telecaller's console
 * uses - `CallbacksService.create`, which places it in calling hours, plans its
 * reminders and computes its priority. Two implementations of "make a
 * callback" is how one of them stops planning reminders.
 */
@Module({
  imports: [FeatureGatesModule, CallbacksModule],
  controllers: [TranscriptAgentController],
})
export class TranscriptAgentModule {}
