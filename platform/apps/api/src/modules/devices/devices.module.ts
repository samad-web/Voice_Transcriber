import { Module } from "@nestjs/common";
import { DevicesController } from "./devices.controller";
import { DeviceTelemetryController } from "./device-telemetry.controller";
import { InstancesController } from "./instances.controller";

@Module({
  controllers: [DevicesController, DeviceTelemetryController, InstancesController],
})
export class DevicesModule {}
