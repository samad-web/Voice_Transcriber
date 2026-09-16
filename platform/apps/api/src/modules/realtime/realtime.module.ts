import { Global, Module } from "@nestjs/common";
import { RealtimeController } from "./realtime.controller";
import { RealtimeService } from "./realtime.service";

/**
 * Global, so any module that wants to announce something a route path cannot
 * describe - a webhook that resolves its own tenant, a pipeline stage - can
 * inject `RealtimeService` without adding an import to its own module. There is
 * exactly one hub per process; making callers wire it up would only create
 * opportunities to end up with two.
 */
@Global()
@Module({
  controllers: [RealtimeController],
  providers: [RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
