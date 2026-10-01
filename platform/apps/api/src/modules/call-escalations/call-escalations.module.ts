import { Module } from "@nestjs/common";
import { CallEscalationsService } from "./call-escalations.service";
import { DeviceCallEscalationsController } from "./device-call-escalations.controller";
import { OwnerCallEscalationSettingsController } from "./owner-call-escalation-settings.controller";
import { OwnerCallEscalationsController } from "./owner-call-escalations.controller";

/**
 * Call escalations (Build docs/38, migration 0151): a telecaller hands a call
 * up to a senior or a manager, from the phone (`devices/me/...`) or the console
 * (`owner/call-escalations`), under a workspace switch and routing an owner or
 * manager sets (`owner/call-escalation-settings`).
 *
 * The device config's `callEscalation` block is served by the existing
 * GET /devices/me/config in DevicesController, which calls
 * `deviceCallEscalationBlock` directly - one config document, not two. The
 * phone alerts written here are retried by the worker's existing push sweep.
 */
@Module({
  controllers: [DeviceCallEscalationsController, OwnerCallEscalationsController, OwnerCallEscalationSettingsController],
  providers: [CallEscalationsService],
  exports: [CallEscalationsService],
})
export class CallEscalationsModule {}
