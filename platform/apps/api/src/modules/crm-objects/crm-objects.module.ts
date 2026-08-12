import { Module } from "@nestjs/common";
import { AccountsController } from "./accounts.controller";
import { ContactsController } from "./contacts.controller";
import { DealsController } from "./deals.controller";
import { InteractionsController } from "./interactions.controller";
import { PipelinesController } from "./pipelines.controller";

/**
 * CRM Phase 1 foundation (E0.1) — Account/Contact/Deal, strangler-fig
 * alongside the existing owner/leads.controller.ts. Not linked into web nav
 * yet; see the Phase 1 plan (C:\Users\mas20\.claude\plans\
 * moonlit-juggling-pie.md).
 */
@Module({
  controllers: [
    PipelinesController,
    AccountsController,
    ContactsController,
    DealsController,
    InteractionsController,
  ],
})
export class CrmObjectsModule {}
