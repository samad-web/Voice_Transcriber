import { Module } from "@nestjs/common";
import { LeadsController } from "./leads.controller";
import { MessageTemplatesController } from "./message-templates.controller";
import { SlotsController } from "./slots.controller";

/** Marketing funnel leads — platform-operator, cross-tenant. */
@Module({
  controllers: [LeadsController, SlotsController, MessageTemplatesController],
})
export class LeadsModule {}
