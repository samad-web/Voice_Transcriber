import { join } from "node:path";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DbModule } from "./db/db.module";
import { S3Module } from "./s3/s3.module";
import { HealthModule } from "./health/health.module";
import { AuthModule } from "./modules/auth/auth.module";
import { TenancyModule } from "./modules/tenancy/tenancy.module";
import { DevicesModule } from "./modules/devices/devices.module";
import { CallsModule } from "./modules/calls/calls.module";
import { AgentsModule } from "./modules/agents/agents.module";
import { CrmModule } from "./modules/crm/crm.module";
import { AnalyticsModule } from "./modules/analytics/analytics.module";
import { BillingModule } from "./modules/billing/billing.module";
import { AdminModule } from "./modules/admin/admin.module";

/**
 * Modular monolith (design doc §5). The module map below is the future
 * service-extraction map; keep boundaries clean.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [join(__dirname, "../../../.env"), ".env"],
    }),
    DbModule,
    S3Module,
    HealthModule,
    AuthModule,
    TenancyModule,
    DevicesModule,
    CallsModule,
    AgentsModule,
    CrmModule,
    AnalyticsModule,
    BillingModule,
    AdminModule,
  ],
})
export class AppModule {}
