import { Module } from "@nestjs/common";
import { AttendanceService } from "./attendance.service";
import { DeviceAttendanceController } from "./device-attendance.controller";
import { OwnerAttendanceController } from "./owner-attendance.controller";

/**
 * Attendance and shift scheduling (Build docs/33, migration 0140): the
 * handset's presence beacon and requests (`devices/me/*`), and the console's
 * settings, board, timesheets, requests and review (`owner/attendance/*`).
 *
 * The device config's `attendance` block is served by the existing
 * GET /devices/me/config in DevicesController, which calls
 * attendance-device.ts directly - there is one config document, not two.
 * The worker owns everything on a timer: the classifier, alerts,
 * presence_check pushes, the WhatsApp outbox and retention.
 */
@Module({
  controllers: [DeviceAttendanceController, OwnerAttendanceController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
