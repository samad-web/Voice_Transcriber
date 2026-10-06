import { Module } from "@nestjs/common";
import { AppointmentRemindersService } from "./appointment-reminders.service";
import { AppointmentsController } from "./appointments.controller";

/**
 * The second vertical primitive (Build docs/39 §25, migration 0166).
 *
 * ── WHY THE REMINDER WRITER IS A SERVICE AND THE RESOURCE MODULE HAS NONE ───
 *
 * Because three routes write to the outbox - create, PATCH and attendance -
 * and the rules about WHAT to queue (skip past instants, cancel the old
 * sequence before queueing a new one, never queue for somebody who has opted
 * out) have to be identical across all three. Inlining them three times is how
 * the reschedule path ends up queueing a ladder nobody cancelled. The resource
 * module has no such shared rule, so it has no service.
 *
 * `AppointmentRemindersService` takes the CLIENT as an argument rather than
 * reaching for a pool of its own: every enqueue must ride the same transaction
 * as the appointment write, or a crash between them leaves a booking with no
 * reminders owed, or reminders owed for a booking that was rolled back.
 *
 * ── WHAT IS NOT HERE ────────────────────────────────────────────────────────
 *
 * No delete route (an appointment is cancelled, never deleted - the no-show
 * report counts against the row). No sender of any kind: this module writes
 * outbox rows and the drain that turns one into a message is a later wave
 * (§34's `startAppointmentReminderDrain`). No public reschedule route either -
 * `appointment_reschedule_tokens` exists but nothing mints one, because
 * verifying a bearer token from an unauthenticated visitor needs the portal's
 * second RLS axis (§17-§19).
 *
 * It is not exported. Nothing outside this module should queue a message to a
 * tenant's customer.
 */
@Module({
  controllers: [AppointmentsController],
  providers: [AppointmentRemindersService],
})
export class AppointmentsModule {}
