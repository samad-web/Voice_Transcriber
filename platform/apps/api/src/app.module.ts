import { join } from "node:path";
import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { throttlerOptions } from "./config/throttling";
import { DbModule } from "./db/db.module";
import { S3Module } from "./s3/s3.module";
import { FcmModule } from "./fcm/fcm.module";
import { HealthModule } from "./health/health.module";
import { AuthModule } from "./modules/auth/auth.module";
import { AccountModule } from "./modules/account/account.module";
import { TenancyModule } from "./modules/tenancy/tenancy.module";
import { DevicesModule } from "./modules/devices/devices.module";
import { CallsModule } from "./modules/calls/calls.module";
import { CallAccessModule } from "./modules/call-access/call-access.module";
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
import { ReportBuilderModule } from "./modules/report-builder/report-builder.module";
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
import { ExportsModule } from "./modules/exports/exports.module";
import { MetaAdsModule } from "./modules/meta-ads/meta-ads.module";
import { LeadIntakeModule } from "./modules/lead-intake/lead-intake.module";
import { LeadRoutingModule } from "./modules/lead-routing/lead-routing.module";
import { RecycleBinModule } from "./modules/recycle-bin/recycle-bin.module";
import { SavedViewsModule } from "./modules/saved-views/saved-views.module";
import { ProjectsModule } from "./modules/projects/projects.module";
import { McpModule } from "./modules/mcp/mcp.module";
import { PublicApiModule } from "./modules/public-api/public-api.module";
import { RealtimeModule } from "./modules/realtime/realtime.module";
import { AttendanceModule } from "./modules/attendance/attendance.module";
import { HandsetAlertsModule } from "./modules/handset-alerts/handset-alerts.module";
import { CallEscalationsModule } from "./modules/call-escalations/call-escalations.module";
import { AppointmentsModule } from "./modules/appointments/appointments.module";
import { DialerModule } from "./modules/dialer/dialer.module";
import { PartnersModule } from "./modules/partners/partners.module";
import { ResourcesModule } from "./modules/resources/resources.module";
import { SuppressionModule } from "./modules/suppression/suppression.module";
import { WebFormsModule } from "./modules/web-forms/web-forms.module";
import { RealtimeInterceptor } from "./modules/realtime/realtime.interceptor";

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
    FcmModule,
    HealthModule,
    AuthModule,
    AccountModule,
    TenancyModule,
    DevicesModule,
    CallsModule,
    CallAccessModule,
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
    RealtimeModule,
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
    ReportBuilderModule,
    ConnectionsModule,
    ProductsModule,
    QuotationsModule,
    InvoicesModule,
    ImportModule,
    ExportsModule,
    MetaAdsModule,
    LeadIntakeModule,
    LeadRoutingModule,
    RecycleBinModule,
    SavedViewsModule,
    // Doc 33 / migration 0140: shifts, presence, leave and the timesheet.
    AttendanceModule,
    // Migration 0150: leads, tasks and manager messages on the telecaller's phone.
    HandsetAlertsModule,
    // Doc 38 / migration 0151: a telecaller escalates a call to a senior or manager.
    CallEscalationsModule,
    // Doc 39 P0 / migrations 0157-0158: the dialable-number vault and the
    // suppression lists. Nothing dials without these, and CallsModule reaches
    // VaultService through this module's export to seed the vault from an
    // inbound call.
    SuppressionModule,
    // Doc 39 P1 / migration 0159: the progressive dialer. Nine console routes
    // and two under the SILENT `devices/me` prefix - a handset route mounted
    // anywhere else would broadcast a realtime `device` change to every open
    // console on every dial (see realtime.ts's KNOWN_TOPICS comments).
    DialerModule,
    // Doc 39 P3 / migration 0161. Its public half is served by the marketing
    // container and proxies here, because apps/marketing connects as
    // `aura_marketing` and `web_forms` lives in `public`.
    WebFormsModule,
    // Doc 39 P6 / migrations 0165-0166: two of the four vertical primitives.
    // `resources` is capacity-based so a unique flat and a 40-seat batch are
    // one table; `appointments` is the tenant-scoped port of the funnel's
    // booking lifecycle, which stays where it is in the `marketing` schema.
    ResourcesModule,
    AppointmentsModule,
    // Doc 39 P4 / migrations 0162-0163: channel partners and the portal.
    // The only module in the platform that introduces a SECOND isolation axis
    // (`app.partner_id`), and 0163's `partner_wall` is what makes it a
    // boundary rather than a convention - without it a partner transaction,
    // which must set `app.org_id` to read its own three tables, would have
    // every other tenant table wide open behind it.
    PartnersModule,
  ],
  providers: [
    // Global, so a new controller is rate-limited by default rather than by
    // remembering to decorate it. The two callers that must never be limited -
    // the console (one source IP, admin key) and the handset fleet - are
    // exempted explicitly: see config/throttling.ts and the `@SkipThrottle()`
    // on every device-authed route.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Global, so a controller written next month makes the console update
    // without anybody remembering this feature exists. See the interceptor
    // for why opt-out beats opt-in here.
    { provide: APP_INTERCEPTOR, useClass: RealtimeInterceptor },
  ],
})
export class AppModule {}
