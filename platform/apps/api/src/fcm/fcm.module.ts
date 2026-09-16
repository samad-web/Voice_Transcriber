import { Global, Module } from "@nestjs/common";
import { FcmService } from "./fcm.service";

/**
 * Global so DevicesController (and any future controller that needs to push)
 * can inject FcmService without every feature module importing FcmModule.
 */
@Global()
@Module({
  providers: [FcmService],
  exports: [FcmService],
})
export class FcmModule {}
