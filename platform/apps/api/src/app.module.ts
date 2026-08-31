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
import { ConnectionsModule } from "./modules/connections/connections.module";
import { ReportsModule } from "./modules/reports/reports.module";
import { ConversationsModule } from "./modules/conversations/conversations.module";
import { TagsModule } from "./modules/tags/tags.module";
import { OutreachModule } from "./modules/outreach/outreach.module";
import { TasksModule } from "./modules/tasks/tasks.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { AutomationModule } from "./modules/automation/automation.module";
import { ProductsModule } from "./modules/products/products.module";
import { QuotationsModule } from "./modules/quotations/quotations.module";
import { InvoicesModule } from "./modules/invoices/invoices.module";
import { ImportModule } from "./modules/import/import.module";
import { MetaAdsModule } from "./modules/meta-ads/meta-ads.module";
import { ProjectsModule } from "./modules/projects/projects.module";
import { McpModule } from "./modules/mcp/mcp.module";
import { PublicApiModule } from "./modules/public-api/public-api.module";

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
    ProjectsModule,
    McpModule,
    PublicApiModule,
    CustomFieldsModule,
    MergeModule,
    RolesModule,
    ConversationsModule,
    TagsModule,
    OutreachModule,
    TasksModule,
    NotificationsModule,
    AutomationModule,
    ReportsModule,
    ConnectionsModule,
    ProductsModule,
    QuotationsModule,
    InvoicesModule,
    ImportModule,
    MetaAdsModule,
  ],
  providers: [
    // Global, so a new controller is rate-limited by default rather than by
    // remembering to decorate it. The two callers that must never be limited -
    // the console (one source IP, admin key) and the handset fleet - are
    // exempted explicitly: see config/throttling.ts and the `@SkipThrottle()`
    // on every device-authed route.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
