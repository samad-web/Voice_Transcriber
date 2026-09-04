import { Module } from "@nestjs/common";
import { AppDownloadController } from "./app-download.controller";
import { DevicesController } from "./devices.controller";
import { DeviceTelemetryController } from "./device-telemetry.controller";
import { InstancesController } from "./instances.controller";

@Module({
  controllers: [
    AppDownloadController,
    DevicesController,
    DeviceTelemetryController,
    InstancesController,
  ],
})
export class DevicesModule {}
