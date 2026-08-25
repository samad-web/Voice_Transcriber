import { Module } from "@nestjs/common";
import { NotificationsController } from "./notifications.controller";

/** In-app notifications (migration 0048). Nothing here leaves the console. */
@Module({
  controllers: [NotificationsController],
})
export class NotificationsModule {}
