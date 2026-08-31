import { Module } from "@nestjs/common";
import { FunnelCriteriaController } from "./funnel-criteria.controller";
import { LeadsController } from "./leads.controller";
import { MessageTemplatesController } from "./message-templates.controller";
import { SlotsController } from "./slots.controller";
import { WhatsAppCheckController } from "./whatsapp-check.controller";

/** Marketing funnel leads - platform-operator, cross-tenant. */
@Module({
  controllers: [
    LeadsController,
    SlotsController,
    MessageTemplatesController,
    WhatsAppCheckController,
    FunnelCriteriaController,
  ],
})
export class LeadsModule {}
