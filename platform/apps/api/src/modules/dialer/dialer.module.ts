import { Module } from "@nestjs/common";
import { DeviceDialerController } from "./device-dialer.controller";
import { DialerController } from "./dialer.controller";
import { DialerService } from "./dialer.service";

/**
 * P1 of the dialer (Build docs/39 §7-§10, migration 0159): campaigns, the
 * queue, the 120-second lease, and the attempts a handset reports.
 *
 * ── WHY THE CONSOLE AND THE HANDSET SHARE A MODULE ──────────────────────────
 *
 * They are two very different callers - one holds a session and is checked
 * against the permission grid, the other holds a 15-minute device token and is
 * checked against nothing but the signature - and they still belong together,
 * for the same reason the vault and the suppression lists do: they are two
 * halves of one subsystem that has to agree with itself.
 *
 * The preview counts a record dialable and the claim serves its number, and
 * both answers come from `dialability()` applied to the same facts. Splitting
 * the two controllers into two modules would make that one shared service an
 * import across a boundary, which is the first step towards a second copy of
 * the predicate - and a second copy is how a supervisor is shown "4,812
 * dialable" while 4,900 phones ring.
 *
 * ── WHAT IS NOT HERE ────────────────────────────────────────────────────────
 *
 * No delete route for a campaign: a finished campaign is `completed`, and its
 * attempts are the only record that those numbers were ever tried (§7). No
 * route that serves more than one number at a time - see
 * device-dialer.controller.ts on why the claim is one record and not §9's
 * prefetch of twenty.
 *
 * No worker code. The attempt-to-call match is a SWEEP
 * (apps/worker/src/pipeline/dial-attempt-link.ts) because neither side arrives
 * first and the call turns up minutes after the dial, which is the same
 * reasoning call-lead-link.ts writes down at length.
 *
 * ── NOT YET MOUNTED ─────────────────────────────────────────────────────────
 *
 * `app.module.ts` is owned by the integration pass that also updates
 * `guard-mounting.spec.ts`'s route counts and `CONTROLLERS` list, so this
 * module is imported there rather than here.
 */
@Module({
  controllers: [DialerController, DeviceDialerController],
  providers: [DialerService],
  exports: [DialerService],
})
export class DialerModule {}
