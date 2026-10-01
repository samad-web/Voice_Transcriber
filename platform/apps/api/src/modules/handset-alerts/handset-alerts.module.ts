import { Module } from "@nestjs/common";
import { DeviceAlertsController } from "./device-alerts.controller";
import { OwnerHandsetAlertsController } from "./owner-handset-alerts.controller";

/**
 * Phone alerts (migration 0150): the handset fetching and acknowledging what
 * it should show (`devices/me/alerts`), and an owner or manager messaging the
 * team's phones (`owner/handset-alerts`). Raising alerts for leads, tasks and
 * follow-ups, and the push ladder, are the worker's (handset-alerts.ts).
 */
@Module({
  controllers: [DeviceAlertsController, OwnerHandsetAlertsController],
})
export class HandsetAlertsModule {}
