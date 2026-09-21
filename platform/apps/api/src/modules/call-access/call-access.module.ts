import { Module } from "@nestjs/common";
import { CallAccessController } from "./call-access.controller";
import { OwnerCallAccessController } from "./owner-call-access.controller";

/**
 * The call-access gate's two sides (migration 0122): the operator asks, the
 * customer decides. `CallAccessGuard` itself lives in `common/` because it is
 * mounted on other modules' controllers, not on these.
 */
@Module({
  controllers: [CallAccessController, OwnerCallAccessController],
})
export class CallAccessModule {}
