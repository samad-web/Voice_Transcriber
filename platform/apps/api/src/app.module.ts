import { join } from "node:path";
import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { throttlerOptions } from "./config/throttling";
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
import { LeadsModule } from "./modules/leads/leads.module";
import { OwnerModule } from "./modules/owner/owner.module";
import { CrmObjectsModule } from "./modules/crm-objects/crm-objects.module";
import { CustomFieldsModule } from "./modules/custom-fields/custom-fields.module";
import { MergeModule } from "./modules/merge/merge.module";
import { RolesModule } from "./modules/roles/roles.module";

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
    ThrottlerModule.forRoot(throttlerOptions()),
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
    LeadsModule,
    OwnerModule,
    CrmObjectsModule,
    CustomFieldsModule,
    MergeModule,
    RolesModule,
  ],
  providers: [
    // Global, so a new controller is rate-limited by default rather than by
    // remembering to decorate it. The two callers that must never be limited —
    // the console (one source IP, admin key) and the handset fleet — are
    // exempted explicitly: see config/throttling.ts and the `@SkipThrottle()`
    // on every device-authed route.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
