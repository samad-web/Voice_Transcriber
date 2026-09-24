/**
 * Are the guards MOUNTED where inventory 13 §1.1 says they are?
 *
 * The other five suites prove each guard is correct in isolation. None of them
 * would notice a route that simply forgot to mount one - and an unmounted guard
 * is indistinguishable from no tenant boundary at all. `scripts/check-tenancy.js`
 * covers part of this, but it is a GREP over controller source: it can be
 * satisfied by a `@UseGuards(AdminKeyGuard, TenantGuard)` inside a comment or a
 * string, and it cannot see mounting order, class-vs-handler inheritance, or a
 * guard applied through a decorator alias. This file reads the same metadata
 * Nest reads at request time (`__guards__`, via `GuardsContextCreator`), so it
 * cannot be fooled by formatting.
 *
 * The four route classes are exhaustive and their sizes are asserted: 57
 * tenant-scoped, 21 cross-tenant, 6 device-authenticated, 6 unguarded = 90. A
 * new route lands in one of those buckets and moves a count, so "I added an
 * endpoint and forgot the guards" is a red test rather than a live hole.
 *
 * Inventory 13 §1.1 documents 75 of those. The extra twelve are the marketing
 * funnel's operator surface (LeadsModule), which post-dates the inventory; the
 * doc is the older artefact, not the authority.
 *
 * SAFETY: this imports controller CLASSES only. It never constructs one, never
 * builds a Nest application, and deliberately does NOT import `app.module.ts` -
 * that module's `ConfigModule.forRoot({ envFilePath: [...] })` (app.module.ts:27-30)
 * would read `.env`, and in this repository `.env` points at production. Reading
 * class metadata needs none of that. Controller modules do run their top-level
 * `z.object(...)` and `new S3Client(...)` statements on import; both are pure
 * in-memory construction (AWS SDK v3 resolves credentials and opens sockets at
 * request time, not at construction).
 *
 * Paths below are as DECLARED. The live URLs carry the `v1` prefix that
 * `main.ts:35` adds at bootstrap; it is omitted here because it is not part of
 * the controller metadata this file reflects over.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RequestMethod, type Type } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { HealthController } from "../health/health.controller";
import { AdminController } from "../modules/admin/admin.controller";
import { OperatorsController } from "../modules/admin/operators.controller";
import { AgentsController } from "../modules/agents/agents.controller";
import { OwnerAgentsController } from "../modules/agents/owner-agents.controller";
import { AnalyticsController } from "../modules/analytics/analytics.controller";
import { SearchController } from "../modules/analytics/search.controller";
import { ApiKeysController } from "../modules/auth/apikeys.controller";
import { AuthController } from "../modules/auth/auth.controller";
import { BillingController } from "../modules/billing/billing.controller";
import { CallsController } from "../modules/calls/calls.controller";
import { NotesController } from "../modules/calls/notes.controller";
import { CallAccessController } from "../modules/call-access/call-access.controller";
import { OwnerCallAccessController } from "../modules/call-access/owner-call-access.controller";
import { CrmController } from "../modules/crm/crm.controller";
import { AccountsController } from "../modules/crm-objects/accounts.controller";
import { CallIntegrityController } from "../modules/crm-objects/call-integrity.controller";
import { ContactsController } from "../modules/crm-objects/contacts.controller";
import { DealsController } from "../modules/crm-objects/deals.controller";
import { InteractionsController } from "../modules/crm-objects/interactions.controller";
import { ConnectionsController } from "../modules/connections/connections.controller";
import { OutboundMailController } from "../modules/connections/outbound-mail.controller";
import { ReportsController } from "../modules/reports/reports.controller";
import { CommissionPlansController } from "../modules/reports/commission-plans.controller";
import { TargetsController } from "../modules/reports/targets.controller";
import { TasksController } from "../modules/tasks/tasks.controller";
import { PipelinesController } from "../modules/crm-objects/pipelines.controller";
import { CustomFieldsController } from "../modules/custom-fields/custom-fields.controller";
import { CustomFieldValuesController } from "../modules/custom-fields/custom-field-values.controller";
import { AppDownloadController } from "../modules/devices/app-download.controller";
import { DeviceTelemetryController } from "../modules/devices/device-telemetry.controller";
import { DevicesController } from "../modules/devices/devices.controller";
import { InstancesController } from "../modules/devices/instances.controller";
import { OwnerDevicesController } from "../modules/devices/owner-devices.controller";
// Two different controllers are both called `LeadsController` - the owner's
// view of their own leads, and the platform operator's view of marketing funnel
// enquiries. Aliased rather than renamed: they are genuinely both "leads" to
// their own audience, and the filesystem check below compares normalised names,
// so a rename purely to satisfy an import would make the two lists disagree.
import { LeadsController as FunnelLeadsController } from "../modules/leads/leads.controller";
import { MessageTemplatesController } from "../modules/leads/message-templates.controller";
import { SlotsController } from "../modules/leads/slots.controller";
import { FunnelCriteriaController } from "../modules/leads/funnel-criteria.controller";
import { WhatsAppCheckController } from "../modules/leads/whatsapp-check.controller";
import { MergeController } from "../modules/merge/merge.controller";
import { NotificationsController } from "../modules/notifications/notifications.controller";
import { AutomationController } from "../modules/automation/automation.controller";
import { ConversationsController } from "../modules/conversations/conversations.controller";
import { EmbeddedSignupController } from "../modules/conversations/embedded-signup.controller";
import { MessagingChannelsController } from "../modules/conversations/messaging-channels.controller";
import { MessagingWebhookController } from "../modules/conversations/messaging-webhook.controller";
import { ConversationQualificationController } from "../modules/conversations/conversation-qualification.controller";
import { WhatsAppPairingController } from "../modules/conversations/whatsapp-pairing.controller";
import { WhatsAppSendController } from "../modules/conversations/whatsapp-send.controller";
import { TagsController } from "../modules/tags/tags.controller";
import { MarketingSourcesController } from "../modules/tags/marketing-sources.controller";
import { ProjectsController } from "../modules/projects/projects.controller";
import { McpController } from "../modules/mcp/mcp.controller";
import { PublicApiController } from "../modules/public-api/public-api.controller";
import { RealtimeController } from "../modules/realtime/realtime.controller";
import { McpServerController } from "../modules/public-api/mcp-server.controller";
import { OutreachController } from "../modules/outreach/outreach.controller";
import { ProductsController } from "../modules/products/products.controller";
import { QuotationsController } from "../modules/quotations/quotations.controller";
import { InvoicesController } from "../modules/invoices/invoices.controller";
import { PaymentsController } from "../modules/invoices/payments.controller";
import { RazorpayWebhookController } from "../modules/invoices/razorpay-webhook.controller";
import { StripeWebhookController } from "../modules/invoices/stripe-webhook.controller";
import { ImportController } from "../modules/import/import.controller";
import { MetaOAuthController } from "../modules/meta-ads/meta-oauth.controller";
import { MetaWebhookController } from "../modules/meta-ads/meta-webhook.controller";
import { ReportBuilderController } from "../modules/report-builder/report-builder.controller";
import { ReportDatasetsController } from "../modules/report-builder/report-datasets.controller";
import { LeadsController } from "../modules/owner/leads.controller";
import { LeadBoardsController } from "../modules/owner/lead-boards.controller";
import { OwnerController } from "../modules/owner/owner.controller";
import { OwnerTeamController } from "../modules/owner/owner-team.controller";
import { OwnerInvitesController } from "../modules/owner/owner-invites.controller";
import { AuthInvitesController } from "../modules/owner/auth-invites.controller";
import { InstanceInvitesController } from "../modules/owner/instance-invites.controller";
import { OwnerRolesController } from "../modules/owner/owner-roles.controller";
import { OrgFeaturesController } from "../modules/owner/org-features.controller";
import { StaffPerformanceController } from "../modules/owner/staff-performance.controller";
import { OwnerCallsController } from "../modules/owner/owner-calls.controller";
import { CallTriageController } from "../modules/owner/call-triage.controller";
import { CallDispositionsController } from "../modules/owner/call-dispositions.controller";
import { IntegrationsController } from "../modules/owner/integrations.controller";
import { TelecallerProductivityController } from "../modules/owner/telecaller-productivity.controller";
import { CallInsightsController } from "../modules/owner/call-insights.controller";
import { CallSopsController } from "../modules/owner/call-sops.controller";
import { OwnersController } from "../modules/owner/owners.controller";
import { IntakeWebhookController } from "../modules/lead-intake/intake-webhook.controller";
import { LeadSourcesController } from "../modules/lead-intake/lead-sources.controller";
import { LinkedInOAuthController } from "../modules/lead-intake/linkedin-oauth.controller";
import { LeadRoutingController } from "../modules/lead-routing/lead-routing.controller";
import { RecycleBinController } from "../modules/recycle-bin/recycle-bin.controller";
import { SavedViewsController } from "../modules/saved-views/saved-views.controller";
import { OptOutsController } from "../modules/conversations/opt-outs.controller";
import { PaymentSettingsController } from "../modules/invoices/payment-settings.controller";
import { OAuthAppsController } from "../modules/connections/oauth-apps.controller";
import { SetupController } from "../modules/owner/setup.controller";
import { BusinessProfileController } from "../modules/owner/business-profile.controller";
import { PlanUsageController } from "../modules/owner/plan-usage.controller";
import { TimeSettingsController } from "../modules/owner/time-settings.controller";
import { AccountController } from "../modules/account/account.controller";
import { AuthEventsController } from "../modules/account/auth-events.controller";
import { RolesController } from "../modules/roles/roles.controller";
import { ErasureController } from "../modules/tenancy/erasure.controller";
import { MembersController } from "../modules/tenancy/members.controller";
import { TenancyController } from "../modules/tenancy/tenancy.controller";
import { BrandingAssetsController } from "../modules/tenancy/branding-assets.controller";
import { WorkspacesController } from "../modules/tenancy/workspaces.controller";
import { OPERATOR_MAY_CALL_KEY } from "./owner-role.guard";
import { CROSS_TENANT_KEY } from "./tenant.guard";

/** Every controller in `app.module.ts`'s module graph, in inventory 13 §1.1 order. */
/**
 * Exported so `permissions-inventory.spec.ts` reflects over the SAME list.
 * Two copies would defeat the point of the exhaustiveness check below: a
 * controller added to one and not the other is a controller whose declarations
 * one of the two suites silently misses.
 */
export const CONTROLLERS: Array<Type<unknown>> = [
  HealthController,
  AuthController,
  ApiKeysController,
  AdminController,
  OperatorsController,
  AgentsController,
  OwnerAgentsController,
  AnalyticsController,
  SearchController,
  BillingController,
  CallsController,
  NotesController,
  CallAccessController,
  OwnerCallAccessController,
  CrmController,
  AppDownloadController,
  DevicesController,
  DeviceTelemetryController,
  InstancesController,
  LeadsController,
  LeadBoardsController,
  OwnerCallsController,
  CallTriageController,
  CallDispositionsController,
  IntegrationsController,
  TelecallerProductivityController,
  CallSopsController,
  CallInsightsController,
  OwnerController,
  OwnerTeamController,
  // 0137: invite by link - the owner's four, and the invitee's four
  // (server-to-server, cross-tenant).
  OwnerInvitesController,
  AuthInvitesController,
  InstanceInvitesController,
  OwnerRolesController,
  OrgFeaturesController,
  StaffPerformanceController,
  OwnersController,
  ErasureController,
  MembersController,
  TenancyController,
  // Uploaded branding images, served to signed-out browsers (a favicon
  // request carries no credential) - the one unguarded route on TenancyModule.
  BrandingAssetsController,
  WorkspacesController,
  // ── the marketing funnel's operator surface (LeadsModule) ─────────────────
  // Added late. These three shipped without being listed here, so for the
  // duration of that gap this suite's "reflects over EVERY controller file"
  // assertion was red - which is the check working, not a formality: none of
  // the guard assertions below were seeing ten live cross-tenant routes that
  // carry the root ADMIN_API_KEY and read every enquirer's phone number.
  FunnelLeadsController,
  SlotsController,
  MessageTemplatesController,
  WhatsAppCheckController,
  FunnelCriteriaController,
  // ── the CRM object model (CRM Phase 1, migrations 0034-0039) ──────────────
  // Same story as the funnel block above, and the reason this suite's
  // filesystem check exists: all seven shipped across M2-M6 without being
  // listed here, so every assertion below was blind to 33 live tenant-scoped
  // routes carrying the root ADMIN_API_KEY over every tenant's contacts,
  // accounts and deals. Adding them is behaviour-neutral - it only makes the
  // suite see what was already mounted.
  AccountsController,
  ContactsController,
  DealsController,
  InteractionsController,
  CallIntegrityController,
  TasksController,
  ReportsController,
  CommissionPlansController,
  TargetsController,
  ConnectionsController,
  OutboundMailController,
  PipelinesController,
  CustomFieldsController,
  CustomFieldValuesController,
  MergeController,
  RolesController,
  // In-app notifications (migration 0048). AdminKeyGuard + TenantGuard only -
  // a notification is addressed to one person and is theirs to read whatever
  // their CRM role is; the scoping that matters is `user_id = <caller>`, which
  // no guard can express and every query in that controller applies.
  NotificationsController,
  // Layer 2's rule engine (migration 0049). AdminKeyGuard + TenantGuard, the
  // same treatment pipelines / custom-field-definitions / roles get and for
  // the same reason: these are org CONFIGURATION, not records, and
  // PermissionObjectType has no value for them. Asserted below alongside those.
  AutomationController,
  // The inbound messaging inbox (migrations 0055/0056). ConversationsController
  // is CrmPermissionsGuard'd on the new `conversation` object type;
  // MessagingChannelsController is org CONFIGURATION and sits with Automation
  // above; MessagingWebhookController is deliberately UNGUARDED and is listed
  // in UNGUARDED below - a provider cannot present an admin key or an org
  // header, so its `:token` path segment is the credential.
  ConversationsController,
  MessagingChannelsController,
  // WhatsApp Embedded Signup (GET/POST /messaging/embedded-signup). Same
  // AdminKeyGuard+TenantGuard tier as the channels controller beside it and
  // for the same reason: this is org CONFIGURATION - which number this tenant
  // has connected - not a CRM record with a PermissionObjectType.
  EmbeddedSignupController,
  // The OTHER connect flow (GET/POST/DELETE /messaging/whatsapp-personal plus
  // GET .../poll). Same org-CONFIGURATION tier as the two above, and separate
  // from EmbeddedSignup because it reaches a different KIND of account: that
  // one connects a WhatsApp Business Account through Meta or Wasi, this one
  // links an ordinary personal number as a WhatsApp Web device. Nothing here
  // sends - pairing establishes a session and subscribes a webhook.
  WhatsAppPairingController,
  MessagingWebhookController,
  // The outbound half, added for Wasi (migration 0061). See
  // whatsapp-send.controller.ts's header for why it's a separate class
  // rather than a method here. MessagingChannelsController also gained one
  // route in this change (GET .../templates, a Wasi proxy) - no new import
  // needed for that, same class.
  WhatsAppSendController,
  // WhatsApp qualification's review queue (migration 0080). The list is gated
  // on `conversation:view`; approve is gated on `contact:create` because that
  // is what approving actually does - create a contact/lead/deal - and gating
  // the only write path on a READ permission would be the wrong grant. There
  // is no `lead` object type in PermissionObjectType, which is why approve
  // borrows `contact`.
  ConversationQualificationController,
  // Tags and campaign attribution (migration 0057). TagsController carries
  // BOTH regimes: the tag vocabulary is org configuration, while attaching a
  // tag to a record is gated on that record's `edit` grant - a viewer who
  // cannot edit a contact must not be able to relabel it either.
  TagsController,
  MarketingSourcesController,
  ProjectsController,
  McpController,
  PublicApiController,
  // The console's live-update feed. The ONLY controller on the platform
  // guarded by neither AdminKeyGuard nor DeviceAuthGuard - see INTERNAL
  // below for why it has a guard of its own instead.
  RealtimeController,
  McpServerController,
  // The follow-up ladder (migration 0058). AdminKeyGuard + TenantGuard, with
  // the automation rules above: it writes only to its own two tables, where a
  // rule can move a deal and rewrite its custom fields.
  OutreachController,
  // Kailash-gap Milestone 1 (migrations 0059/0060): products/quotations/
  // invoices join `product`/`quotation`/`invoice` on PermissionObjectType, so
  // all of ProductsController/QuotationsController/InvoicesController/
  // PaymentsController sit with the rest of CrmPermissionsGuard's surface
  // below. RazorpayWebhookController is deliberately UNGUARDED, same class
  // of exception as MessagingWebhookController above - Razorpay cannot
  // present an admin key, and the payload's payment_link id (resolved on the
  // admin pool) is what names the org, verified against THAT org's own
  // webhook secret before anything is trusted.
  ProductsController,
  QuotationsController,
  InvoicesController,
  PaymentsController,
  RazorpayWebhookController,
  StripeWebhookController,
  // Kailash gap Milestone 2: bulk CSV import (migration 0062). AdminKeyGuard+
  // TenantGuard only - a bulk operation over a caller-chosen entity type,
  // the same administrative tier scripts/backfill-crm-objects.js already
  // operates at, not a per-record CrmPermissionsGuard surface.
  ImportController,
  // Kailash gap Milestone 4: Meta Lead Ads capture (migration 0063).
  // MetaOAuthController mixes both regimes in one class, like TagsController
  // does - `start`, the pending-choice pair and `disconnect` need a signed-in
  // tenant (and a persona, see OWNER_ROLE_ROUTES), `callback` is Meta's own
  // browser redirect and verifies itself via a signed state token instead.
  // MetaWebhookController is entirely UNGUARDED, same class of exception as
  // messaging/webhook/:token and /webhooks/razorpay.
  MetaOAuthController,
  MetaWebhookController,
  // The Report Builder (migration 0077) - user-assembled reports over the
  // tenant's own CRM data. Both classes are CrmPermissionsGuard'd on `deal`,
  // joining reports/targets/call-integrity below for the same reason those
  // are: a report is a VIEW over contacts, deals and calls rather than a
  // record class of its own, and widening PermissionObjectType would mean
  // seeding grants for all five system roles in the same migration or locking
  // every existing user out of the new object on the day it ships. See
  // `Build docs/report_builder_design.md` D7.
  ReportBuilderController,
  ReportDatasetsController,
  // The lead intake engine (migration 0078). Three classes, three regimes:
  //
  //  - IntakeWebhookController is entirely UNGUARDED, the same class of
  //    exception as messaging/webhook/:token - a form on a customer's website,
  //    an Exotel passthrough and a Mailgun route cannot present an admin key,
  //    so the `:token` path segment IS the credential.
  //  - LeadSourcesController is ordinary org CONFIGURATION, the tier
  //    projects/tags/marketing-sources sit on. Deliberately not
  //    CrmPermissionsGuard'd: `PermissionObjectType` has no value for a
  //    settings page, and widening it would mean seeding grants for five
  //    system roles to gate a catalogue. Persona-gated instead since doc 31
  //    §2 X8 (see OWNER_ROLE_ROUTES).
  //  - LinkedInOAuthController mixes both in one class, like MetaOAuthController
  //    does: `oauth/callback` is LinkedIn's own browser redirect and verifies
  //    itself with a signed state token instead of a guard.
  IntakeWebhookController,
  LeadSourcesController,
  LinkedInOAuthController,
  // Automated lead distribution (migration 0094). AdminKeyGuard + TenantGuard +
  // OwnerRoleGuard, with a real `@RequireOwnerRole("owner", "manager")` at
  // class level rather than an inert mount - see OWNER_ROLE_ROUTES, where all
  // eight of its routes are pinned. A distribution rule decides who gets paid,
  // so a telecaller or a `sales` persona reaching it would be able to route the
  // floor's leads to themselves.
  LeadRoutingController,
  RecycleBinController,
  // The new-client setup checklist (migration 0095). AdminKeyGuard +
  // TenantGuard + OwnerRoleGuard, owner/manager on the read and owner alone on
  // the dismiss - see OWNER_ROLE_ROUTES.
  SetupController,
  // The client's own payment gateway. Owner ONLY, and deliberately NOT on
  // CrmPermissionsGuard beside PaymentsController: these are live payment
  // credentials, so "may edit an invoice" is the wrong question to ask about
  // them.
  PaymentSettingsController,
  // The organisation's own Google/Microsoft OAuth apps (migration 0120). Owner
  // ONLY, same weight as the payment gateway: the app decides whose consent
  // screen the whole team signs in through, and replacing it disconnects every
  // account made through the old one. Its secret is write-only.
  OAuthAppsController,
  // The client's own handsets (migration 0096). Mounts OwnerRoleGuard with
  // EVERY persona listed rather than omitting the decorator, because the real
  // gate is a per-person capability (`memberships.can_pair_devices`) that
  // `@RequireOwnerRole` cannot express and the handlers check themselves -
  // the same shape owner-calls.controller.ts uses for `recordings_listen`.
  // Listing every persona keeps its routes inside OWNER_ROLE_ROUTES below, so
  // a route added here later cannot quietly escape the persona check.
  OwnerDevicesController,
  // A person's saved list filters (migration 0108). Plain AdminKeyGuard +
  // TenantGuard and no permission grant: a view is a query string, opened by
  // re-running the list endpoint under the viewer's own grant and scope, and
  // every statement is narrowed to the calling user.
  SavedViewsController,
  // The review queue's probable opt-outs (migration 0109): confirm or dismiss.
  // OwnerRoleGuard owner+manager at class level, the gate the opt-out release
  // on ConversationsController already uses - see OWNER_ROLE_ROUTES.
  OptOutsController,
  // Doc 27. The business profile and Plan & usage are OwnerRoleGuard'd (see
  // OWNER_ROLE_ROUTES). AccountController is a person's own profile: plain
  // AdminKeyGuard + TenantGuard, because every persona has one and "your own
  // row" is in every WHERE clause - it takes no user id from anywhere but the
  // verified caller header. AuthEventsController is cross-tenant: see
  // CROSS_TENANT for why that is safe.
  BusinessProfileController,
  PlanUsageController,
  AccountController,
  AuthEventsController,
  // Doc 30: the workspace clock. OwnerRoleGuard owner+manager on BOTH halves
  // (see OWNER_ROLE_ROUTES) - unlike the business profile, a manager may set it.
  TimeSettingsController,
];

// ── the four route classes, named exactly as inventory 13 §1.1/§1.2 do ───────

/**
 * §1.2 - the routes with no `@UseGuards` metadata at all.
 *
 * The messaging webhook is the newest member and the only one that is
 * unguarded while still writing tenant data. It is admissible because the
 * `:token` path segment IS its credential: 32 CSPRNG bytes, UNIQUE
 * platform-wide in `messaging_channels.webhook_token`, resolved on the admin
 * pool to name the org before anything is written. An unknown token 404s
 * without disclosing whether one exists.
 */
/**
 * The one route authenticated by the bare admin key and nothing else.
 *
 * `GET /internal/events` streams change signals to the web tier's fanout. It
 * is not unguarded - `InternalStreamGuard` requires ADMIN_API_KEY, which in
 * production is unset-means-deny - but it deliberately does NOT carry
 * AdminKeyGuard + TenantGuard like every other credentialed route:
 *
 *  - it is cross-tenant by construction (one subscriber receives every org's
 *    signals and the web tier filters per session), so there is no single
 *    `x-org-id` for TenantGuard to pin; and
 *  - it must not touch the database to accept a connection. AdminKeyGuard
 *    validates the org header against `organizations` on every call, which for
 *    a stream that reconnects after every deploy is a query per redial for a
 *    fact this route never uses.
 *
 * What makes that safe is the payload, not the guard: these events carry an
 * org id, a topic and a record id - never row content. See
 * packages/shared/src/realtime.ts.
 */
const INTERNAL = ["GET /internal/events"];

const UNGUARDED = [
  "GET /health",
  // An org's uploaded logo / favicon / banner. Public by nature: the same
  // values already render in a bare <img> for anyone loading the console, and
  // the uuid filename, not a credential, is what stops a guessed name resolving.
  "GET /branding-assets/:orgId/:filename",
  "POST /auth/login",
  "POST /auth/logout",
  "POST /devices/register",
  "POST /devices/challenge",
  "POST /devices/authenticate",
  // A reinstalled handset reclaiming its own row (0130). Pre-enrollment by
  // definition - the app that would hold a device token is the thing being
  // restored - so, like register, the credential is in the body: a 256-bit
  // recovery secret stored hashed, replaced on every use, and honoured only on
  // the same physical phone for a row that is still active. Every failure
  // before the secret is proven is one identical 401, so it discloses nothing.
  "POST /devices/recover",
  // Meta's subscription handshake (0098) - a GET on the SAME url, because that
  // is what Meta requires: it calls once with hub.mode=subscribe and expects
  // the challenge echoed as a bare body. Unguarded for the identical reason the
  // POST is: Meta presents no credential of ours, and the token in the path is
  // what both authenticates and names the tenant. It discloses nothing - a bad
  // verify token and an unknown channel both 403 with no body.
  "GET /messaging/webhook/:token",
  "POST /messaging/webhook/:token",
  // Razorpay's payment-link webhook (migration 0060). See razorpay-webhook.controller.ts's
  // header for the resolve-org-then-verify-signature ordering that makes this
  // safe to leave unguarded.
  "POST /webhooks/razorpay",
  // Stripe (0099), on the same terms and for the same reason: a gateway cannot
  // present an admin key, the signature over the raw bytes is the credential,
  // and the org is resolved from the session id BEFORE its secret is used to
  // verify - because which secret to use is exactly what is unknown until the
  // org is known. Always 200, so an ignored delivery is not retried for three
  // days.
  "POST /webhooks/stripe",
  // Meta's own OAuth redirect lands here with no Aura credentials - verifies
  // itself via the signed `state` param instead (meta-client.ts). Since doc 28
  // it answers only with a 302 into the console, to a URL built from
  // PUBLIC_APP_URL and never from the request (common/console-redirect.ts).
  "GET /meta/oauth/callback",
  // Meta's leadgen webhook handshake + delivery (migration 0063). Same
  // resolve-then-verify shape as the other unauthenticated webhooks above.
  "GET /meta/webhook",
  "POST /meta/webhook",
  // The lead intake engine's public front doors (migration 0078). Same
  // resolve-the-token-then-write shape as the messaging webhook: the token is
  // 32 CSPRNG bytes, UNIQUE platform-wide in `lead_sources.intake_token`, and
  // resolving it on the admin pool both authenticates the caller and names the
  // tenant. An unknown token 404s without disclosing whether one exists, and a
  // token posted to the WRONG channel's endpoint 404s too.
  "POST /intake/form/:token",
  "POST /intake/telephony/:token",
  "POST /intake/email/:token",
  // LinkedIn's OAuth redirect lands here with no Aura credentials - verifies
  // itself via the signed `state` param, and 302s into the console, exactly
  // like Meta's.
  "GET /linkedin/oauth/callback",
  // The handset app's public download. Unlike every other member of this list
  // it carries no token at all, and that is the point: the caller is a person
  // holding a NEW phone, who has no console login and no device token, because
  // the app they are here to install is the thing that would issue one.
  //
  // Admissible because it discloses only the CLIENT BINARY. It reads
  // `app_releases`, which is fleet-wide and holds no tenant data; a fresh
  // install is inert until somebody types an activation key into it; and the
  // bucket stays private - both routes presign per request and the signature
  // expires in fifteen minutes, so this publishes a link, never the object.
  "GET /app/latest",
  "GET /app/download",
];

/** §1.1 rows 22, 23, 44, 48-50 - the handset fleet's entire surface. */
const DEVICE_AUTHED = [
  "POST /calls",
  "POST /calls/:id/complete",
  // Missed calls from the handset's call log (0133). DeviceAuthGuard like the
  // upload pair above: it is the same ingest, minus the audio, and it refuses a
  // device or org that is no longer active exactly as create() does.
  "POST /calls/missed",
  "GET /devices/me/config",
  "POST /devices/me/health",
  "POST /devices/me/events",
  "GET /devices/me/calls/:callId",
  // The handset's own update check. Advisory only - it cannot gate recording,
  // and the APK URL is presigned per request rather than stored. DeviceAuthGuard
  // like every other /devices/me route: the signed device token IS the identity.
  "GET /devices/me/update",
  // The handset registering its own push token, so the console can wake it
  // (POST /devices/:id/ping) instead of waiting for its next poll. DeviceAuthGuard
  // like every other /devices/me route: the signed device token IS the identity,
  // and a phone has no principal to present.
  "POST /devices/me/fcm-token",
  // The handset arming its own recovery secret (0130). DeviceAuthGuard like
  // every /devices/me route: holding the Keystore key IS being the phone the
  // secret protects, and the route refuses a device that is no longer active.
  "POST /devices/me/recovery",
];

/** §1.1 rows 3, 4, 9, 10, 18 - the operator surface, all on the RLS-bypassing pool. */
const CROSS_TENANT = [
  "GET /auth/context",
  // Invite by link (0137), the invitee's half. Cross-tenant because the
  // invitee has no workspace yet - the token names it. Reached only from the
  // console's public invite page and OAuth callback, on the admin key; accept
  // and identity/link take the person's own Supabase access token and ask
  // GoTrue who it is, so nothing here trusts the caller about identity.
  "GET /auth/invites/preview",
  "POST /auth/invites/prepare",
  "POST /auth/invites/accept",
  "POST /auth/identity/link",
  "GET /auth/me",
  "POST /admin/tenants",
  "GET /admin/tenants",
  "PATCH /admin/tenants/:orgId/modules",
  // Doc 27 §6.4: the operator's storage quota. Separate from the modules PATCH
  // so it cannot interfere with feature reconciliation. Display and warn only.
  "PATCH /admin/tenants/:orgId/storage-quota",
  "GET /admin/health",
  // A person's own sign-in history (doc 27 §5). Cross-tenant because an
  // operator has no org and a failed sign-in has no session; bound instead to
  // the caller's own Supabase subject (`x-caller-auth-id`), which the web tier
  // sets from a verified getClaims(). No route here names whose history to read.
  "POST /account/auth-events",
  "GET /account/login-activity",
  // The platform's own staff list (migration 0089). Cross-tenant for the same
  // reason /admin/tenants is: a platform operator belongs to no org, so there
  // is nothing for TenantGuard to scope to. WHICH operator is asking cannot be
  // decided here - every console request arrives on the one shared admin key -
  // so "only the root may change this list" is enforced in the web tier's
  // requireMax(). What this layer holds is the invariant that needs no
  // identity: the root address is configured in the environment, and can be
  // neither added nor deleted as a row.
  "GET /admin/operators",
  "POST /admin/operators",
  "DELETE /admin/operators/:email",
  // Minting and resetting a superadmin's Supabase password. Cross-tenant for
  // the same reason as the three above - platform staff belong to no org - and
  // fenced by the one invariant this layer CAN check without knowing the
  // caller: the address must already be the root or a `platform_operators`
  // row, so the admin key cannot mint a confirmed login for a stranger.
  "POST /admin/operators/:email/login",
  "POST /admin/operators/:email/password",
  "GET /analytics/fleet",
  // Platform Hub KPIs (dashboard overhaul): both answer a fleet-wide question
  // with no single org to scope to, same reasoning as /analytics/fleet above.
  "GET /analytics/active-users",
  "GET /analytics/booking-rate",
  // The marketing funnel. Cross-tenant by nature rather than by exception: an
  // enquiry has no org yet - that is what makes it an enquiry - so there is no
  // tenant for TenantGuard to scope these to. They still carry AdminKeyGuard,
  // which is the credential that actually gates them.
  "GET /admin/leads",
  "POST /admin/leads/:id/send-confirmation",
  "POST /admin/leads/:id/reject",
  "POST /admin/leads/delete",
  "POST /admin/leads/:id/link",
  "GET /admin/slots",
  "GET /admin/slots/booked",
  "POST /admin/slots",
  "POST /admin/slots/generate",
  "POST /admin/slots/:id/attendance",
  "DELETE /admin/slots/:id",
  "GET /admin/message-templates",
  "PUT /admin/message-templates/:key",
  "POST /admin/message-templates/:key/reset",
  // Presence lookup on the WhatsApp network for numbers an enquirer typed.
  // Same reasoning as the rest of the funnel: no org exists yet to scope to.
  "POST /admin/whatsapp/check",
  // Who counts as a qualified lead. Cross-tenant for the same reason as
  // the rest of the funnel: these rules belong to the funnel, not to a
  // tenant, because a lead has no tenant until it is converted.
  "GET /admin/funnel-criteria",
  "PUT /admin/funnel-criteria",
];

/**
 * The operator's instance surface (migration 0096's sibling fix). These mint
 * enrollment tokens, and an enrollment token puts a device into the tenant -
 * so a tenant console user is refused outright, while the bare platform admin
 * key passes. Neither OrgRoleGuard (inert: it admits any `viaAdminKey` caller,
 * which every owner-console request is) nor OwnerRoleGuard (refuses the bare
 * admin key the operator console uses) could express that.
 */
const OPERATOR_ONLY_ROUTES = [
  "POST /instances",
  "GET /instances",
  "GET /instances/:id",
  "DELETE /instances/:id",
  "POST /instances/:id/keys",
  // The operator's side of the call-access gate (0122). Guarded for the
  // opposite reason the instance routes are: not to keep a tenant OUT of an
  // operator surface, but to stop a tenant's own console reaching the surface
  // where the vendor ASKS - an owner who could approve through here would be
  // approving their own vendor's request, which is the one thing the gate
  // exists to prevent. Deciding lives on OwnerCallAccessController.
  "GET /call-access/mine",
  "POST /call-access/requests",
  "POST /call-access/requests/:id/otp",
  "POST /call-access/requests/:id/redeem",
];

/** §2.3 - one route on the whole platform. */
const PERMISSION_ROUTES = ["GET /calls/:id/audio"];

/**
 * 0122 - every route that hands a human CALL CONTENT, and is therefore gated
 * on the tenant's own administrator having agreed to let a platform operator
 * see it.
 *
 * This list is the whole feature. A call route that is added without
 * `@CallContent()` is a hole in it, and the only thing that catches that is
 * this assertion failing - which it will, because the route lands in no bucket
 * and moves the totals below.
 *
 * What is deliberately NOT here:
 *   - every `/owner/*` call route. OwnerRoleGuard resolves a persona from
 *     `memberships` and refuses a bare admin-key caller outright, so an
 *     operator cannot reach them at all. Double-gating them would add a second
 *     answer to "why can't I see this call" for no extra safety.
 *   - `GET /devices/me/calls/:callId`, which is device-authenticated: the
 *     handset reading back its own call, with no operator anywhere near it.
 *   - the write routes (`reprocess`, `reprocess-backlog`). They spend money
 *     and they move a call through the pipeline; they return no content.
 */
const CALL_CONTENT_ROUTES = [
  "GET /calls",
  "GET /calls/:id",
  "GET /calls/:id/audio",
  "GET /calls/:id/notes",
  "POST /calls/:id/notes",
  // Verbatim transcript snippets, fifty at a time - the widest call-content
  // read in the product.
  "GET /search",
  // Runs an extractor over a stored transcript and returns what it found.
  "POST /agents/:id/test",
  // `crm_sync_log.request_body` holds the transcript, the facts, the full
  // number and a presigned recording URL.
  "GET /crm/integrations/:id/deliveries",
];

/** §2.4 - two controllers. */
const OWNER_ROLE_ROUTES = [
  // Undoing an opt-out a customer asked for (migration 0100). Owner/manager
  // rather than `conversation:edit`, because the justification for reversing
  // it always happens outside the system - the customer said so on a call -
  // and the person asserting that should not be the person who wants to send
  // the message.
  "POST /conversations/:id/opt-out/release",
  "GET /owner/overview",
  "GET /owner/crm-overview",
  // Telecaller productivity (0090). Mounts OwnerRoleGuard at class level and
  // declares NO `@RequireOwnerRole` on the read - the same shape inventory 13
  // finding 3 flagged on `GET /owner/overview`, and, as there, the fix was not
  // a persona requirement. Every persona may see their own talk time; what must
  // not happen is a telecaller reading the floor's. The narrowing comes from
  // OwnerScopeGuard, which is never inert.
  "GET /owner/productivity",
  // Call insights: the floor-wide read of every call, and the same read as a
  // PDF. Owner/manager at class level - a REAL requirement, unlike the
  // productivity read above, because it ranks named colleagues and summarises
  // the whole floor's conversations (the call log's own restriction). The PDF
  // is audited as an export.
  "GET /owner/call-insights",
  "GET /owner/call-insights/pdf",
  // The SOP surface (0091). Every route here declares a real requirement: an
  // SOP is the DEFINITION of the measure, it has no owner to narrow rows by,
  // and a telecaller editing the rules they are scored against is the one shape
  // of access with no defensible reading.
  "GET /owner/sops",
  "GET /owner/sops/:id/versions",
  "POST /owner/sops",
  "POST /owner/sops/:id/versions",
  "POST /owner/sops/deactivate",
  "PATCH /owner/telecallers/:deviceId",
  // The workspace's own team roster (migration 0079). Both routes declare a
  // real requirement rather than mounting the guard inertly, and the two are
  // deliberately DIFFERENT: reading the roster is owner-or-manager, while
  // changing somebody's persona is owner alone. A manager who could assign
  // personas could assign themselves `owner`, which is privilege escalation
  // wearing the clothes of an ordinary team edit.
  "GET /owner/team",
  "PATCH /owner/team/:userId",
  // Provisioning, re-passwording and revoking a colleague's login - all OWNER
  // only. Unlike most of the owner console these are real API-side
  // enforcement rather than a nav restriction: OwnerRoleGuard resolves the
  // persona from `memberships`, so a manager is refused here even though the
  // admin key the console arrives on is minted as platform_admin.
  "POST /owner/team",
  "POST /owner/team/:userId/password",
  "DELETE /owner/team/:userId",
  // Invite by link (0137). Reading pending invites is owner-or-manager like
  // the roster; issuing, resending and withdrawing are owner only, for the
  // same reason POST /owner/team is.
  "GET /owner/invites",
  "POST /owner/invites",
  "POST /owner/invites/:id/resend",
  "DELETE /owner/invites/:id",
  // The staff record (migration 0102). All owner-only, and each is a different
  // kind of write on the same row:
  //
  //   /profile    employment details - a staff code, a job title, a phone.
  //               They grant nothing, which is exactly why they are a separate
  //               route from the persona edit above rather than more fields on
  //               it: "this endpoint cannot change access" should be true by
  //               inspection.
  //   /suspend    stops somebody signing in without deleting their login. It
  //               goes through the same last-owner guard as a demotion,
  //               because leaving a workspace with no owner is the same
  //               lockout either way.
  //   /reinstate  the inverse. Never guarded - it only ever widens.
  //   /role       the permission role whose grid applies (0039's
  //               `memberships.role_id`, which nothing wrote until now). It
  //               does NOT touch `memberships.role`, the five-value tier
  //               OrgRoleGuard reads - see the handler.
  "PATCH /owner/team/:userId/profile",
  "POST /owner/team/:userId/suspend",
  "POST /owner/team/:userId/reinstate",
  "PUT /owner/team/:userId/role",
  // Roles & permissions, the CLIENT's half (0039's grid, owner console).
  // Mounted with OwnerRoleGuard rather than the OrgRoleGuard that gates
  // `/v1/roles`, and that is the entire reason it is a second controller:
  // OrgRoleGuard reads `memberships.role`, and every owner-console request
  // arrives on an admin key minted as `platform_admin`, so it would pass for a
  // telecaller. Reading is owner-or-manager; every write is owner alone.
  //
  // Deliberately NO CrmPermissionsGuard anywhere here. An owner who saves a
  // grid that revokes their own CRM access must still be able to reach this
  // surface to undo it - a repair behind the thing being repaired is not a
  // repair.
  "GET /owner/roles",
  "POST /owner/roles",
  "PATCH /owner/roles/:id",
  "PUT /owner/roles/:id/permissions",
  "DELETE /owner/roles/:id",
  // The feature switchboard (migration 0101). Owner-or-manager read,
  // owner-only write - the same split as the roster, because a manager has to
  // be able to answer "why is Invoices missing" before raising it as a bug.
  //
  // What it writes is the CLIENT's choice, never the entitlement:
  // `organizations.enabled_modules` stays an operator-only column, and
  // `resolveFeatures` keeps a switched-on feature `unavailable` without its
  // module. That separation is why this is safe to expose to a customer at all.
  "GET /owner/features",
  "PUT /owner/features",
  // The staff scorecard. Owner-or-manager, narrower than the Productivity page
  // next door: that one narrows to the reader's OWN rows and is open to every
  // persona, while this is a league table naming colleagues.
  "GET /owner/staff/performance",
  // The client's own call log. Unlike the three above it declares a real
  // `@RequireOwnerRole("owner", "manager")` at class level rather than
  // mounting the guard inertly: reading the whole floor's conversations is a
  // manager's view of the team, not a telecaller's view of their own work.
  // Automated lead distribution (migration 0094). Every route declares the
  // class-level owner+manager requirement. Managers WRITE here, unlike
  // `/owner/team` where they read the roster and only an owner changes it:
  // setting a persona is privilege escalation, sharing out leads is not.
  // Handsets (migration 0096). The list and the mint admit every persona at
  // the guard and then check the per-person pairing grant in the handler;
  // revoke is the one route with a real persona requirement, because retiring
  // a working phone mid-shift is not delegable.
  // A person's OWN WhatsApp number (0125). The four personas who have an
  // inbox to read its chats in; every route acts only on the caller's own
  // channel, found by owner_user_id - see WhatsAppPairingController.
  "GET /messaging/whatsapp-personal",
  "POST /messaging/whatsapp-personal",
  "GET /messaging/whatsapp-personal/poll",
  "DELETE /messaging/whatsapp-personal",
  "GET /owner/devices",
  "POST /owner/devices/pairing-token",
  // The pairing dialog's "has the phone used it yet" (0124). Every persona,
  // like the list it is a subset of - see the handler.
  "GET /owner/devices/pairing-token/:id",
  "POST /owner/devices/:id/revoke",
  // Device recovery (0130): undo a retire, and mint a pairing code bound to one
  // existing handset. Both owner-or-manager - the retire tier, not the
  // delegable pairing capability - because each can put a person's identity
  // back on (or onto) a phone.
  "POST /owner/devices/:id/restore",
  "POST /owner/devices/:id/relink-token",
  // The setup checklist (migration 0095). The read is owner-or-manager, the
  // dismiss is owner alone: silencing a tenant-wide notice permanently is a
  // decision, and a manager who could take it could hide an unfinished account
  // from the person who owns it.
  "GET /owner/setup",
  "POST /owner/setup/dismiss",
  // The setup GUIDE (doc 27 §7.5, migration 0129). Skipping an optional step
  // is owner or manager - the pair that sees the guide; hiding and re-opening
  // the guide is owner alone, the same split the banner's dismiss has.
  "POST /owner/setup/steps/:stepId/skip",
  "DELETE /owner/setup/steps/:stepId/skip",
  "POST /owner/setup/guide/dismiss",
  "POST /owner/setup/guide/reopen",
  // The business profile (doc 27 §4.3, 0126): owner edits, manager reads.
  "GET /owner/business-profile",
  "PUT /owner/business-profile",
  // Plan & usage (doc 27 §6.7): owner and manager.
  "GET /owner/plan-usage",
  // The workspace clock (doc 30): owner and manager read AND write it.
  "GET /owner/time-settings",
  "PUT /owner/time-settings",
  // Its location half - country and currency - is owner alone: the same
  // columns the business profile's owner-only PUT writes.
  "PUT /owner/time-settings/region",
  // Doc 27 §4.4's fix. Its OrgRoleGuard was inert for every console request
  // (the admin key is platform_admin); the persona gate is the real one.
  "PATCH /org/branding",
  // Its upload half - a presigned PUT for a branding image - carries the
  // same two gates as the PATCH that saves the resulting URL.
  "POST /org/branding/upload-url",
  // Owner alone on both halves: whoever holds these keys decides which bank
  // account this business's money settles into.
  "GET /owner/payment-settings",
  "PUT /owner/payment-settings",
  // Owner alone: an organisation's OAuth app (0120) - see OAuthAppsController.
  "GET /connections/oauth-apps",
  "PUT /connections/oauth-apps/:provider",
  "DELETE /connections/oauth-apps/:provider",
  // The tenant's own AI Agent Studio (0121). Owner or manager on every route,
  // reads included: an extractor decides which of the floor's calls become
  // leads, so it is the SOP argument again - the people being counted do not
  // write the rule that counts them. See OwnerAgentsController.
  "GET /owner/agents",
  "GET /owner/agents/samples",
  "GET /owner/agents/:id",
  "POST /owner/agents",
  "POST /owner/agents/generate",
  "POST /owner/agents/test",
  "POST /owner/agents/:id/versions",
  "POST /owner/agents/:id/activate",
  "POST /owner/agents/:id/deactivate",
  "POST /owner/agents/:id/archive",
  "GET /owner/lead-routing",
  "POST /owner/lead-routing/rules",
  "PATCH /owner/lead-routing/rules/:id",
  "DELETE /owner/lead-routing/rules/:id",
  "PUT /owner/lead-routing/rules/:id/targets",
  "POST /owner/lead-routing/rules/:id/reset",
  "GET /owner/lead-routing/rules/:id/preview",
  "POST /owner/lead-routing/backfill",
  "GET /owner/recycle-bin",
  "POST /owner/recycle-bin/:resource/:id/restore",
  "GET /owner/calls",
  "GET /owner/calls/:id",
  // The call-detail actions the same log grew (f7a7a1f): playback, the notes
  // an owner leaves on a conversation, and re-running the pipeline over one.
  // Same class-level @RequireOwnerRole("owner", "manager") as the two above -
  // they are reached only from that log, so they inherit its tier.
  //
  // Playback additionally checks the membership's `recordings_listen` INSIDE
  // the handler, because the owner console arrives on the admin key that
  // AdminKeyGuard mints with `recordingsListen: true` - PermissionsGuard would
  // wave every client member through, so it is deliberately not mounted here.
  "GET /owner/calls/:id/audio",
  "GET /owner/calls/:id/notes",
  "POST /owner/calls/:id/notes",
  // OWNER ONLY - the one route in this controller that narrows the class
  // decorator, via `getAllAndOverride`. A reprocess re-runs ASR and analyze
  // against the paid providers, so it is a spending decision and belongs with
  // the account holder rather than with everyone who can read the log.
  // What a PERSON said the call was (0097), in the tenant's own vocabulary,
  // as opposed to the AI's reading already on the row. Class-level
  // owner/manager like the rest of the log: it re-rates the lead behind the
  // call, which is a decision about somebody else's pipeline.
  "POST /owner/calls/:id/disposition",
  "POST /owner/calls/:id/reprocess",
  // A follow-up drafted by the tenant's reply drafter (0121). Returns text and
  // sends nothing; class-level owner/manager, plus call_intel and the reader's
  // own recordings_listen checked in the handler, because a draft recaps the
  // transcript.
  "POST /owner/calls/:id/draft-reply",
  // The vocabulary itself. GET carries no @RequireOwnerRole - every
  // surface showing a call needs the labels to render a chip, and a
  // telecaller reading a bare key helps nobody. Defining the list is
  // owner/manager, because a disposition carries a lead-quality mapping:
  // whoever controls it controls how the board gets rated.
  // The Integrations store (doc 28): what this tenant can connect to, what is
  // connected, and one app's connections and history. Every persona - a
  // telecaller connects their own Gmail there - but a REAL one: the class
  // lists all five, so the guard resolves the persona from `memberships` and
  // a bare admin key gets nothing. What each persona sees is filtered in the
  // controller (canSeeApp).
  "GET /owner/integrations",
  "GET /owner/integrations/:id",
  // The store's two provider-OAuth connect flows (doc 28 §11.3, §14). Owner,
  // manager and marketing - each app's `manageRoles` - behind the feature the
  // app belongs to (`meta_ads`, `lead_sources`) via OrgFeatureGuard. Starting a
  // sign-in, reading what it returned, choosing, and disconnecting are all
  // decisions about where the team's leads come from, so a telecaller or a
  // `sales` persona is refused here rather than only hidden from the page.
  // Both callbacks stay in UNGUARDED: the signed state is their credential.
  "POST /meta/oauth/start",
  "GET /meta/oauth/pending/:id",
  "POST /meta/oauth/pending/:id/choose",
  "POST /meta/connections/:id/disconnect",
  "POST /linkedin/oauth/start",
  "GET /linkedin/connections/:id/accounts",
  "POST /linkedin/connections/:id/account",
  "POST /linkedin/connections/:id/disconnect",
  "GET /owner/call-dispositions",
  "POST /owner/call-dispositions",
  "PATCH /owner/call-dispositions/:id",
  // The unmatched-call queue (migration 0094). Same class-level
  // @RequireOwnerRole("owner", "manager") and the same `call_intel`
  // entitlement as the log it hangs off, for the same reason: the queue is
  // every unmatched call on the floor, and working it creates and re-parents
  // leads across the whole team.
  //
  // Deliberately NOT record-scoped, unlike the leads and productivity
  // routes. A call nobody has matched belongs to nobody in particular, so a
  // per-telecaller slice of this queue would leave those rows in nobody's
  // list - the one outcome a reconciliation queue cannot have.
  "GET /owner/call-triage",
  "GET /owner/call-triage/:id/candidates",
  "POST /owner/call-triage/:id/link",
  "POST /owner/call-triage/:id/create-lead",
  "POST /owner/call-triage/:id/dismiss",
  "POST /owner/call-triage/:id/restore",
  // ── The review queue and the response clock (0111/0119) ──────────────────
  //
  // Opt-outs are a compliance record: confirming one stops every future send to
  // that number, and dismissing one says a "leave me alone" was not one. Owner
  // and manager, because it decides whether a customer can be contacted at all.
  "GET /opt-outs",
  "POST /opt-outs/:id/confirm",
  "POST /opt-outs/:id/dismiss",
  // The org's promised first-response time, and therefore what the SLA sweep
  // raises a breach against. Owner/manager: it is the number the floor is
  // measured by, so the people being measured do not set it.
  "GET /owner/lead-routing/response-sla",
  "PUT /owner/lead-routing/response-sla",
  // Moving a batch of leads onto somebody else. Owner/manager for the same
  // reason a routing rule is: it decides who works - and who earns on - them.
  "POST /leads/reassign",
  // ── The customer's side of the call-access gate (0122) ──
  //
  // The list is owner-or-manager; every DECISION is owner alone. This is the
  // one place in the product where a tenant decides something about its
  // VENDOR rather than about its own work, and a manager who could grant the
  // vendor its recordings would be making that call on the business's behalf.
  //
  // `settings` carries the gate toggle itself, and it exists ONLY here - there
  // is deliberately no operator-side route that can write it. A vendor able to
  // switch off the gate protecting the customer from the vendor has not built
  // a gate.
  "GET /owner/call-access",
  "POST /owner/call-access/:id/approve",
  "POST /owner/call-access/:id/deny",
  "POST /owner/call-access/:id/revoke",
  "PUT /owner/call-access/settings",
  // ── Org configuration that checked nothing but tenant membership (doc 31 §2 X8) ──
  //
  // Every route below used to be plain AdminKeyGuard + TenantGuard, so a
  // telecaller whose request reached one could merge records, rewrite
  // automation rules or read the org's audit log. Each now declares the
  // personas its console page is shown to (reads the whole floor uses stay
  // inert - a class mount with no class-level requirement), and every one
  // carries @OperatorMayCall so the bare admin key - operator console, ops
  // scripts, e2e harnesses - keeps exactly the access it had. That makes the
  // change strictly narrower: only console PEOPLE lost anything. See
  // OPERATOR_MAY_CALL_ROUTES below.
  //
  // Automation rules, custom-field definitions and analytics: operator-console
  // surfaces today; a person must be owner or manager.
  "GET /automations",
  "GET /automations/runs",
  "POST /automations/dry-run",
  "POST /automations",
  "PATCH /automations/:id",
  "DELETE /automations/:id",
  "GET /custom-field-definitions",
  "POST /custom-field-definitions",
  "PATCH /custom-field-definitions/:id",
  "DELETE /custom-field-definitions/:id",
  "GET /analytics/overview",
  "GET /analytics/fleet",
  "GET /analytics/active-users",
  "GET /analytics/booking-rate",
  // Merge and CSV import: owner, manager, marketing - who the Duplicates and
  // Import pages are shown to. An import's error rows are further narrowed in
  // the handler to the person who ran it, or an owner/manager (X6).
  "POST /import/preview",
  "POST /import/run",
  "GET /import/:jobId",
  "GET /import/:jobId/errors",
  "GET /import/:jobId/errors.csv",
  "POST /merge/scan",
  "GET /merge/duplicates",
  "POST /merge/duplicates/:id/dismiss",
  "GET /merge",
  "POST /merge",
  "POST /merge/:id/revert",
  // Cadences are the org's ladder (owner/manager); journeys, due steps and
  // step outcomes are every rep's daily work and stay open.
  "GET /outreach/cadences",
  "POST /outreach/cadences",
  "PATCH /outreach/cadences/:id",
  "GET /outreach/journeys",
  "POST /outreach/journeys",
  "PATCH /outreach/journeys/:id",
  "GET /outreach/due",
  "PATCH /outreach/steps/:id",
  // Reads open (the board labels leads with projects); writes for the four
  // personas the Projects page is shown to.
  "GET /projects",
  "POST /projects",
  "PATCH /projects/:id",
  // Reads open; create/edit owner and manager (the Manage board control's
  // reach); stage packs owner, manager and sales (the Deals page's).
  "GET /pipelines",
  "GET /pipelines/:id",
  "POST /pipelines",
  "PATCH /pipelines/:id",
  "GET /pipelines/stage-packs/catalogue",
  "POST /pipelines/:id/apply-stage-pack",
  // Lead sources, WhatsApp channel setup, embedded signup and Meta MCP
  // connections: owner, manager, marketing - the Lead sources, Messaging
  // setup and Meta ads pages. One exception: a channel's template list is
  // what the inbox picker reads, so every replying persona keeps it.
  "GET /lead-sources/catalogue",
  "POST /lead-sources/sheets/preview",
  "GET /lead-sources",
  "POST /lead-sources",
  "PATCH /lead-sources/:id",
  "POST /lead-sources/:id/rotate-token",
  "GET /lead-sources/:id/events",
  "POST /lead-sources/events/:eventId/replay",
  "GET /messaging/channels",
  "POST /messaging/channels",
  "PATCH /messaging/channels/:id",
  "POST /messaging/channels/:id/verify",
  "GET /messaging/channels/:id/templates",
  "POST /messaging/channels/:id/templates/sync",
  "GET /messaging/embedded-signup",
  "POST /messaging/embedded-signup",
  "GET /mcp/connections",
  "POST /mcp/connections",
  "POST /mcp/connections/:id/test",
  "DELETE /mcp/connections/:id",
  // The tag vocabulary is owner/manager to change; the record-tagging routes
  // keep their CrmPermissionsGuard grant and declare no persona (inert).
  "GET /tags",
  "POST /tags",
  "PATCH /tags/:id",
  "DELETE /tags/:id",
  "POST /contacts/:id/tags",
  "DELETE /contacts/:id/tags/:tagId",
  "POST /deals/:id/tags",
  "DELETE /deals/:id/tags/:tagId",
  "POST /tags/:id/contacts",
  "POST /tags/:id/deals",
  "GET /marketing-sources",
  "POST /marketing-sources",
  "PATCH /marketing-sources/:id",
  // A commission plan decides what people are paid: marketing may read the
  // plans beside the commission report, only owner/manager write them.
  "GET /commission-plans",
  "GET /commission-plans/:id",
  "POST /commission-plans",
  "PATCH /commission-plans/:id",
  "DELETE /commission-plans/:id",
  // The org audit log (owner) and the org policy (owner/manager, and a console
  // person may send only the three transcription fields - enforced in the
  // handler, see CONSOLE_POLICY_FIELDS in tenancy.controller.ts).
  "GET /org/audit",
  "PATCH /org/policy",
  // Membership and role-grid writes. `OrgRoleGuard` alone was inert for a
  // console person (every one arrives as platform_admin), so the only thing
  // stopping a self-promotion was that no owner-console action called these.
  // The operator console's Team and Roles tabs write here on the bare key; a
  // person must be the owner - the tier /owner/team and /owner/roles require.
  "POST /members",
  "PATCH /members/:userId",
  "DELETE /members/:userId",
  "POST /roles",
  "PATCH /roles/:id",
  "PUT /roles/:id/permissions",
];

/**
 * Routes whose persona gate lets the BARE admin key through
 * (`@OperatorMayCall`, owner-role.guard.ts). Pinned for the same reason
 * OPERATOR_ONLY_ROUTES is: a route that quietly GAINS it hands the persona
 * check a bypass for any caller that omits `x-caller-user-id`; one that LOSES
 * it silently locks the operator console out.
 *
 * Every entry is also in OWNER_ROLE_ROUTES - the marker means nothing on a
 * route OwnerRoleGuard never runs on, and the test asserts that too.
 */
const OPERATOR_MAY_CALL_ROUTES = OWNER_ROLE_ROUTES.slice(
  OWNER_ROLE_ROUTES.indexOf("GET /automations"),
);

/**
 * Org-administration routes gated on `principal.role` directly via
 * `OrgRoleGuard`/`@RequireOrgRole` - not a `role_permissions` grant, since
 * these are not CRM records (contact/account/deal/...), they are "who else
 * may act as this org". Added closing a real privilege-escalation gap: none
 * of these had ANY check beyond tenant membership, so a freshly-invited
 * `viewer` could `PATCH /members/:userId` its own role to `org_admin`. See
 * org-role.guard.ts's header for the fuller reasoning, including why
 * `pipelines`/`custom-field-definitions`/`automation`/`merge` are
 * deliberately NOT in this list - those stay member-accessible org
 * CONFIGURATION, a different tier from org ADMINISTRATION.
 */
const ORG_ROLE_ROUTES = [
  "POST /members",
  "PATCH /members/:userId",
  "DELETE /members/:userId",
  "POST /apikeys",
  "DELETE /apikeys/:id",
  "PATCH /org/policy",
  "PATCH /org/branding",
  "POST /org/branding/upload-url",
  "POST /roles",
  "PATCH /roles/:id",
  "PUT /roles/:id/permissions",
  "POST /erasure-requests",
  "POST /devices/:id/logout",
  "POST /devices/:id/wipe",
  // Removing an UNPAIRED device row - the tidying action logout and wipe do
  // not provide. Same org_admin tier as its two siblings above, and for a
  // stronger reason than either: they change a handset's status, this one
  // deletes a record. The endpoint additionally refuses with 409 unless the
  // device has zero calls and zero attributed leads, so "org_admin" is the
  // floor and not the whole check.
  "DELETE /devices/:id",
  // Waking a handset through FCM so it checks in now rather than at its next
  // scheduled poll. Sits with logout and wipe for the same reason they sit
  // together: all three reach out and change what a phone in somebody's pocket
  // is doing, which is an org_admin action whatever its blast radius.
  "POST /devices/:id/ping",
  // Undoing logout, wipe or removal (0130). org_admin with its siblings: it
  // reverses exactly what they do, and re-arms a phone that may be in a
  // stranger's pocket if the wipe was deliberate.
  "POST /devices/:id/restore",
  "POST /workspaces",
];

/**
 * The CRM object model's enforced surface - every route that consults the
 * `role_permissions` grid (migration 0039) via `CrmPermissionsGuard`.
 *
 * Pinned as an exhaustive list for the same reason PERMISSION_ROUTES is: a
 * route that quietly LOSES its guard is a silent authorization hole, and a
 * route that gains one unexpectedly is a silent lockout. `pipelines`,
 * `custom-field-definitions` and `merge` are deliberately absent - they are
 * org-configuration surfaces rather than records and have no grant to check;
 * they remain AdminKeyGuard+TenantGuard as before.
 *
 * NO LONGER "the contact/account/deal routes". Migration 0103 added `lead` and
 * mounted the guard on the owner console's leads controller, which is the
 * point at which this grid started governing the page an Aura tenant actually
 * spends the day in rather than only the CRM half of the product.
 */
const CRM_PERMISSION_ROUTES = [
  // ── The lead board and list (0103) ──
  //
  // `lead` is filed under the `aura` module in PERMISSION_OBJECT_MODULE, NOT
  // `crm` - a recording-only tenant must keep its board, and this is the one
  // object in the enum for which the guard's module predicate is not 'crm'.
  //
  // Four reads and one write. There is deliberately no create/delete/export
  // cell for leads: this controller has no such route, rows are written by the
  // worker's projection, and a checkbox gating nothing is the defect the
  // enforced-permission inventory exists to prevent.
  "GET /leads",
  "GET /leads/board",
  "GET /leads/:id",
  "GET /leads/:id/calls/:callId",
  "PATCH /leads/:id",
  // The console's "New lead" (0136) - `lead:create`, seeded by 0136 from
  // `lead:edit` so nobody who could work a lead lost the ability to add one.
  "POST /leads",
  // ── Lead boards (0136) ──
  // Reading boards is `lead:view`; making, reshaping, routing and deleting
  // them are the `lead_board` object's create/edit/delete - admin-only by
  // 0136's seed, because they change the columns under everyone's leads.
  "GET /lead-boards",
  "POST /lead-boards",
  "PATCH /lead-boards/:ref",
  "DELETE /lead-boards/:id",
  "GET /lead-boards/routes",
  "PUT /lead-boards/routes",
  "GET /accounts",
  "GET /accounts/:id",
  "POST /accounts",
  "PATCH /accounts/:id",
  "GET /contacts",
  "GET /contacts/:id",
  "GET /contacts/:id/deals",
  "POST /contacts",
  "PATCH /contacts/:id",
  "GET /deals",
  "GET /deals/board",
  "GET /deals/:id",
  // The stage ledger (migration 0046). `deal:view`, not a wider grant: it is
  // a fact about one deal, and anyone who may see the deal may see how it got
  // there.
  "GET /deals/:id/stage-history",
  "POST /deals",
  "PATCH /deals/:id",
  // Track A2's timeline. Declared on InteractionsController, which has an
  // EMPTY @Controller() prefix and spells each parent out in the path - so
  // these read as contacts/accounts/deals routes here even though they live
  // in a different file, the same way NotesController's routes appear under
  // `calls`. Each is gated on its parent object, which is the whole reason
  // the routes are nested rather than one filtered `/interactions` list.
  "GET /accounts/:id/interactions",
  "POST /accounts/:id/interactions",
  "GET /contacts/:id/interactions",
  "POST /contacts/:id/interactions",
  "GET /deals/:id/interactions",
  "POST /deals/:id/interactions",
  // The console's global search over activity notes. The one flat
  // interactions route: gated on `contact:view` and joined to contacts under
  // that grant's `owned` scope, so it can only return notes whose contact the
  // caller could already open.
  "GET /interactions/search",
  // Track A3. `task` joined PermissionObjectType with migration 0041, which
  // also seeds every system role's task grants - so these are enforced from
  // the moment they ship, rather than being a retrofit later.
  "GET /tasks",
  // The follow-up queue's five tab counts (migration 0095), one statement.
  // Declared above GET /tasks/:id in the controller so Nest does not read
  // "counts" as a task id - the ordering matters there, not here.
  "GET /tasks/counts",
  "GET /tasks/:id",
  "POST /tasks",
  "PATCH /tasks/:id",
  // The inbox (migrations 0055/0056), on the `conversation` object type.
  // There is no POST here and that is the point: safety rule 3 survives only
  // while no general-purpose "post a message" route sits behind an ordinary
  // permission. Reading, routing, claiming and closing - never sending.
  "GET /conversations",
  "GET /conversations/:id",
  // A POST, but not a send: it returns reply TEXT for the composer (0121), and
  // the person still sends through whatsapp-send.controller.ts. conversation:view
  // with record scope, the same predicate as reading the thread it drafts from.
  "POST /conversations/:id/draft-reply",
  "PATCH /conversations/:id",
  // Mounted from the class and INERT on this one: it declares no
  // `@RequireCrmPermission`, and CrmPermissionsGuard returns true when the
  // metadata is absent. Its real gate is OwnerRoleGuard (see
  // OWNER_ROLE_ROUTES) - releasing a customer's opt-out is not a rep's day
  // job. Listed here because the inventory records what is MOUNTED, and a
  // guard that is mounted-but-inert is exactly the shape inventory 13 §7
  // finding 3 exists to keep visible rather than to hide.
  "POST /conversations/:id/opt-out/release",
  // WhatsApp qualification (migration 0080). The queue reads on
  // `conversation:view`; reject edits a verdict, so `conversation:edit`.
  // Approve is the one that creates CRM records and is listed with the
  // contact-writing routes below, on `contact:create`.
  "GET /conversation-qualifications",
  "POST /conversation-qualifications/:id/reject",
  // Attaching a label is editing the record it hangs off (migration 0057).
  "POST /contacts/:id/tags",
  "DELETE /contacts/:id/tags/:tagId",
  "POST /deals/:id/tags",
  "DELETE /deals/:id/tags/:tagId",
  // The list views' bulk actions (CRM dashboard Phase 5). The same grant as
  // the single-record edit each one repeats - `:edit` on the object - with
  // the caller's `owned` scope inside the UPDATE/INSERT, so a scoped rep who
  // selects a colleague's rows changes nothing about them.
  "POST /contacts/reassign",
  "POST /deals/reassign",
  "POST /tasks/reassign",
  // An assignee's accept / decline (migration 0135). `task:view`, not edit:
  // being asked to do something must not depend on being allowed to rewrite
  // it, and the UPDATE is keyed on the caller's own id.
  "POST /tasks/:id/respond",
  "POST /tags/:id/contacts",
  "POST /tags/:id/deals",
  // PRD Layer 3. Viewing a report needs `deal:view`; the CSV export needs
  // `deal:export` - the first route on the platform to use that action, and
  // the reason the export is its own route rather than a `?format=` param.
  "GET /reports/pipeline",
  "GET /reports/performance",
  "GET /reports/conversion",
  // The three Tier-1 reports from the Hawcus gap analysis (migration 0093).
  // Same `deal:view` gate as their four siblings. Two of them read `leads`,
  // which has no owner_user_id, so an `owned`-scoped caller is REFUSED rather
  // than silently widened - the rule query-compiler.spec.ts already pins for
  // report-builder sources, asserted for these in reports-sla.spec.ts.
  "GET /reports/response-time",
  "GET /reports/followup-compliance",
  "GET /reports/lead-aging",
  // The team roll-up (CRM dashboard Phase 8). Same deal:view gate as its
  // siblings; the service refuses an `owned` caller outright, because every
  // row in it is somebody else's work.
  "GET /reports/team",
  "GET /reports/:report/export",
  // PRD Layer 5. Gated on `deal` rather than a new object type: a target is a
  // statement about deals and attainment is computed from them. Setting one
  // needs `deal:edit`, because it changes what every report says about a
  // person's performance.
  "GET /targets",
  "GET /targets/attainment",
  "POST /targets",
  "DELETE /targets/:id",
  // Custom-field VALUES on a record - nested under their parent for the same
  // reason the timeline routes are, and gated on that parent's view/edit.
  // The DEFINITIONS surface (`/custom-field-definitions`) stays unenforced
  // and is asserted separately below; these two are deliberately different
  // things, which is why they are different controllers.
  "GET /accounts/:id/custom-fields",
  "PUT /accounts/:id/custom-fields",
  "GET /contacts/:id/custom-fields",
  "PUT /contacts/:id/custom-fields",
  "GET /deals/:id/custom-fields",
  "PUT /deals/:id/custom-fields",
  // Sending one email to one contact, from the sender's own mailbox. Gated on
  // `contact:edit` because it writes to that contact's timeline; the harder
  // restrictions (a resolvable user, their own connection, a recipient read
  // from the record rather than the request) live in the controller, since no
  // guard can express "and the address must come from the database".
  "POST /contacts/:id/email",
  // Kailash-gap Milestone 1 (migrations 0059/0060). `product`/`quotation`/
  // `invoice` joined PermissionObjectType together, seeded in the same
  // migrations that widen the enum - see permissions.ts's comment.
  "GET /products",
  "GET /products/:id",
  "POST /products",
  "PATCH /products/:id",
  "GET /quotations",
  "GET /quotations/:id",
  "POST /quotations",
  "PATCH /quotations/:id",
  "GET /invoices",
  "GET /invoices/:id",
  "POST /invoices",
  "POST /invoices/from-quotation/:quotationId",
  "PATCH /invoices/:id",
  // "Collect Payment" - gated on invoice:edit, same reasoning as the email
  // send route above: creating a link writes to the invoice's payment
  // history, even though only the (unguarded, separately verified) webhook
  // can ever mark it paid.
  "POST /invoices/:id/payment-link",
  // The outbound WhatsApp send path (migration 0061). Gated on `conversation:edit`
  // rather than a new action - same reasoning as the email-send route above.
  "POST /conversations/:id/messages",
  // Approving a WhatsApp qualification (0080) - the only route that turns an
  // inbound thread into a lead. `contact:create`, because a contact is what it
  // creates; it additionally requires a signed-in user id, which no permission
  // grant can substitute for (safety rule 2).
  "POST /conversation-qualifications/:id/approve",
  // The call-vs-CRM integrity review queue (0070). Gated on `deal` like
  // reports/targets - there is no dedicated object type for this either.
  "GET /call-integrity-flags",
  "PATCH /call-integrity-flags/:id",
  // The commission report (0071) - the fourth report alongside pipeline/
  // performance/conversion, same `deal:view` gate. commission_plans CRUD
  // itself is NOT here - it's org configuration (AdminKeyGuard+TenantGuard
  // only), the same tier as pipelines.
  "GET /reports/commission",
  // ── the Report Builder (migration 0077) ─────────────────────────────────
  //
  // Every route is `deal:view` except the widget CSV export, which raises to
  // `deal:export` exactly as `GET /reports/:report/export` does - seeing a
  // chart and walking out with the rows behind it are different acts.
  //
  // The record SCOPE from this guard is not decoration here: it compiles into
  // every widget's WHERE clause (query-compiler.ts), so an `owned`-scoped rep
  // charting deals charts their own, in the editor, in the CSV and in a
  // scheduled run. A source that cannot express `owned` is REFUSED rather
  // than silently widened - pinned in query-compiler.spec.ts.
  "GET /report-builder",
  "POST /report-builder",
  "GET /report-builder/templates",
  "POST /report-builder/templates",
  "GET /report-builder/palettes",
  "POST /report-builder/palettes",
  "GET /report-builder/:id",
  "PATCH /report-builder/:id",
  "DELETE /report-builder/:id",
  "POST /report-builder/:id/publish",
  "GET /report-builder/:id/shares",
  "PUT /report-builder/:id/shares",
  "PUT /report-builder/:id/link",
  "GET /report-builder/:id/schedules",
  "POST /report-builder/:id/schedules",
  "DELETE /report-builder/:id/schedules/:scheduleId",
  "POST /report-builder/:id/render",
  "GET /report-builder/:id/runs",
  "POST /report-builder/:id/runs",
  "GET /report-builder/:id/runs/:runId",
  "GET /report-builder/:id/widgets/:widgetId/export",
  "GET /report-datasets",
  "POST /report-datasets",
  "GET /report-datasets/:id",
  "DELETE /report-datasets/:id",
  "POST /report-datasets/:id/rows",
  "POST /report-datasets/:id/query",
  // Bulk reassignment is an edit of every lead in the batch, so it carries the
  // same lead:edit grant a single PATCH does - on top of the owner/manager
  // persona check above.
  "POST /leads/reassign",
];

interface Route {
  /** `"GET /calls/:id"` - verb plus the declared path, no `v1` prefix. */
  route: string;
  /** Class guards then handler guards, which is the order Nest runs them in. */
  guards: string[];
  crossTenant: boolean;
  /** `@OperatorMayCall` on the handler or the class. */
  operatorMayCall: boolean;
}

/**
 * `GuardsContextCreator.create` concatenates CLASS metadata then HANDLER
 * metadata (`ContextCreator.createContext`), so this ordering is Nest's, not a
 * convention chosen here. It matters: `@UseGuards(AdminKeyGuard, TenantGuard)`
 * on the class with `@UseGuards(PermissionsGuard)` on the handler yields
 * [AdminKey, Tenant, Permissions] - the dependency order tenant.guard.spec.ts
 * pins behaviourally.
 */
function guardNames(target: object): string[] {
  const meta = Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined;
  return (meta ?? []).map((g) => (typeof g === "function" ? g.name : String(g)));
}

function routesOf(cls: Type<unknown>): Route[] {
  const base = (Reflect.getMetadata(PATH_METADATA, cls) as string | undefined) ?? "";
  const classGuards = guardNames(cls);
  const routes: Route[] = [];
  for (const name of Object.getOwnPropertyNames(cls.prototype)) {
    if (name === "constructor") continue;
    const handler = (cls.prototype as Record<string, unknown>)[name];
    if (typeof handler !== "function") continue;
    // PATH_METADATA on a method is what @Get/@Post/@Patch/@Delete set; a helper
    // method on the controller has none and is skipped.
    const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
    if (path === undefined) continue;
    const verb = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
    routes.push({
      route: `${verb} /${base}/${path}`.replace(/\/+/g, "/").replace(/\/$/, ""),
      guards: [...classGuards, ...guardNames(handler)],
      // getAllAndOverride([handler, class]) semantics, hand-rolled because a
      // Reflector needs an ExecutionContext: handler wins, class applies to all.
      crossTenant:
        Reflect.getMetadata(CROSS_TENANT_KEY, handler) === true ||
        Reflect.getMetadata(CROSS_TENANT_KEY, cls) === true,
      operatorMayCall:
        Reflect.getMetadata(OPERATOR_MAY_CALL_KEY, handler) === true ||
        Reflect.getMetadata(OPERATOR_MAY_CALL_KEY, cls) === true,
    });
  }
  return routes;
}

const ROUTES: Route[] = CONTROLLERS.flatMap(routesOf);
const byRoute = new Map(ROUTES.map((r) => [r.route, r]));
const sorted = (values: string[]): string[] => [...values].sort();

describe("guard mounting (inventory 13 §1.1)", () => {
  it("reflects over EVERY controller file in the tree", () => {
    // The one hand-maintained list in this file is CONTROLLERS, and a new
    // controller that nobody adds to it would be invisible to every assertion
    // below - the exact failure this suite exists to prevent. So the list is
    // checked against the filesystem: add `foo.controller.ts` without importing
    // it here and this fails, naming the file.
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (entry.name.endsWith(".controller.ts")) files.push(entry.name);
      }
    };
    walk(join(__dirname, ".."));

    // Compared on a case- and separator-insensitive key, because the file and
    // class names do not agree on word boundaries: `apikeys.controller.ts`
    // declares `ApiKeysController`, `device-telemetry.controller.ts` declares
    // `DeviceTelemetryController`. Both normalise to the same key.
    const key = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const fromDisk = files.map((f) => key(f.replace(/\.controller\.ts$/, "")));
    const imported = CONTROLLERS.map((c) => key(c.name.replace(/Controller$/, "")));
    expect(sorted(imported)).toEqual(sorted(fromDisk));
  });

  it("has no @Controller() class hiding in a file that isn't named *.controller.ts", () => {
    // The walk above only ever looks at `*.controller.ts` files - which is
    // exactly the naming convention a new controller could ignore. A
    // `@Controller()` class dropped into some other file (a barrel, a
    // `*.routes.ts`, anything) would never be added to `files` above, never
    // compared against CONTROLLERS, and never picked up by a single guard
    // assertion in this suite. This is the other half of that check: read
    // every non-spec, non-module `.ts` file under `src/modules` as TEXT and
    // look for the decorator itself, so a misnamed controller file is caught
    // by what it contains rather than by what it's called.
    const offenders: string[] = [];
    const walkAll = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walkAll(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        // Spec files can reference `@Controller(` in a comment or a fixture
        // without declaring one, and `*.module.ts` never declares one at
        // all - both are excluded to keep this a check on real source, not
        // noise. Everything else is fair game: the regex is what decides
        // whether a file is a "controller support file", not its name.
        if (entry.name.endsWith(".spec.ts") || entry.name.endsWith(".module.ts")) continue;
        const source = readFileSync(full, "utf8");
        if (/@Controller\(/.test(source) && !entry.name.endsWith(".controller.ts")) {
          offenders.push(full);
        }
      }
    };
    walkAll(join(__dirname, "..", "modules"));

    expect(offenders).toEqual([]);
  });

  it("has 461 routes, partitioned 398 tenant / 32 cross-tenant / 10 device / 20 unguarded / 1 internal", () => {
    // The counts inventory 13 §1.1 closes with, plus the funnel's ten, plus the
    // CRM object model's 33 (all tenant-scoped: 4 accounts + 5 contacts + 5
    // deals + 4 pipelines + 4 custom-field-definitions + 6 merge + 5 roles),
    // plus Track A2's 6 interaction-timeline routes Track A3's 4 task routes,
    // Layer 3's 4 report routes, Layer 1's 6 connection routes, the 6
    // custom-field-VALUE routes, the booking lifecycle's one
    // (POST /admin/slots/:id/attendance, cross-tenant like the rest of the
    // funnel's operator surface), A6 Milestone 4's one
    // (GET /owner/crm-overview, tenant-scoped like its sibling
    // GET /owner/overview), Kailash-gap Milestone 1's 15 (4 products + 4
    // quotations + 5 invoices + 1 payment-link, all tenant-scoped, plus the
    // one unguarded Razorpay webhook), the platform console's
    // PATCH /devices/:id/telecaller (0067) - the operator-side counterpart of
    // PATCH /owner/telecallers/:deviceId below, tenant-scoped like the rest of
    // the devices surface - and the call-vs-CRM integrity review queue (0070):
    // GET/PATCH /call-integrity-flags, CrmPermissionsGuard'd on `deal` like
    // reports/targets since there is no dedicated object type for it either
    // - and Phase 4/5's seven, landed together: the fleet health dashboard's
    // GET /devices/fleet-health (tenant-scoped, same tier as GET /devices),
    // and the commission export's GET /reports/commission (CrmPermissionsGuard
    // on deal:view, like the other three report routes) plus five plain
    // AdminKeyGuard+TenantGuard commission_plans CRUD routes (org
    // configuration, same tier as pipelines) - and the project catalogue's
    // three (0073): GET/POST /projects and PATCH /projects/:id, plain
    // AdminKeyGuard+TenantGuard because a project catalogue is org
    // configuration in exactly the way marketing-sources and tags are.
    // Attaching a project to a record happens through the leads/deals PATCH
    // endpoints, which carry their own gates. They are asserted as a
    // set, not just a total, so moving a route BETWEEN classes (dropping
    // TenantGuard from a tenant route, say) fails even though the total is
    // unchanged.
    //
    // - and the external integration surface's eight (0076): six
    // `/public/*` REST routes plus `POST /mcp` and `GET /mcp`, the inbound MCP
    // server. The GET exists only to answer 405 with an `Allow: POST` header:
    // Streamable HTTP's server->client SSE stream is optional, and a server
    // that does not offer it MUST say 405 rather than leave the verb unmounted,
    // where Nest's 404 would send a client looking for a different URL. These
    // are the FIRST routes in the product authenticated by a tenant's own
    // `api_keys` row rather than by the platform admin key or a user session,
    // so they are pinned separately and exhaustively in the API_KEYED test
    // below. They count as tenant-scoped because ApiKeyGuard writes
    // `req.principal` with the org taken FROM THE KEY, which TenantGuard then
    // pins exactly as it does for a session - the tenant boundary is the same
    // one, reached with a different credential.
    // - and the Report Builder's twenty-seven (0077): twenty-one
    // `/report-builder/*` and six `/report-datasets/*`, all tenant-scoped and
    // all CrmPermissionsGuard'd on `deal`. Nothing here is cross-tenant,
    // unguarded or device-authed: the read-only share link is deliberately NOT
    // an anonymous endpoint - it still requires a session resolving to the
    // owning org and only widens that session to `viewer`, so it adds no route
    // to UNGUARDED. See `Build docs/report_builder_design.md` D6/D7.
    // - and the lead intake engine's sixteen (0078, 0096): three unguarded
    // intake webhooks (form/telephony/email), eight tenant-scoped
    // `/lead-sources/*` configuration routes - the eighth being
    // `POST /lead-sources/sheets/preview`, which reads a spreadsheet's headers
    // so the console can offer a column mapping - and five for LinkedIn, of
    // which `oauth/callback` is unguarded because LinkedIn's browser redirect
    // carries no credential of ours. Nothing here is cross-tenant or
    // device-authed.
    // - and call intelligence's one: `GET /leads/:id/calls/:callId`, the
    // client-facing transcript + AI read behind the `call_intel` module. Plain
    // AdminKeyGuard+TenantGuard like the rest of the owner leads controller:
    // its two extra gates are not guards and cannot be, because neither is a
    // verdict on the request. The module is an entitlement read per request
    // from `organizations`, and `recordings_listen` REDACTS part of the
    // response rather than refusing it - the same shape `GET /calls/:id`
    // already has.
    // - and the client's own call log's six (`GET /owner/calls`,
    // `GET /owner/calls/:id`, its notes pair, `/audio` and `/reprocess`):
    // tenant-scoped, and the only routes outside OwnerController carrying
    // OwnerRoleGuard at class level - a call log is a manager's view of the
    // floor, not a telecaller's view of their own work. `/reprocess` narrows
    // that to owner alone, because it spends.
    // Their `call_intel` module check is not a guard for the same reason the
    // leads one is not: the list answers normally without the module and the
    // detail refuses, which is a decision each route makes for itself.
    // 306: adds DELETE /devices/:id (0087) - taking a handset out of the
    // fleet, the third device action alongside logout/wipe. Tenant-scoped,
    // OrgRoleGuard-gated like its two siblings (see ORG_ROLE_ROUTES below).
    // - and the Staff section's twelve (0101/0102): four staff-record writes on
    // the existing team controller, five for the client's own roles &
    // permissions grid, two for the feature switchboard, and the scorecard.
    // All tenant-scoped and all OwnerRoleGuard'd; see OWNER_ROLE_ROUTES, which
    // says what each one is for.
    // 398: adds the organisation's own OAuth apps (0120) - GET, PUT and DELETE
    // under /connections/oauth-apps. Tenant-scoped and owner-only.
    // 408: adds the tenant's own AI Agent Studio (0121) - ten routes under
    // /owner/agents, all tenant-scoped and owner-or-manager.
    // 410: the reply drafter's two surfaces (0121) - POST conversations/:id/draft-reply
    // and POST owner/calls/:id/draft-reply. Both return text and send nothing.
    // 419: the call-access gate's nine (0122) - four on the operator's side
    // (OperatorOnlyGuard: ask, check, request a code, redeem one) and five on
    // the customer's (OwnerRoleGuard: the queue, approve, deny, revoke, and
    // the gate's own settings). All tenant-scoped: an access request is about
    // exactly one org, and there is deliberately no cross-tenant view of who
    // has been asking for what.
    // 423: personal-WhatsApp pairing's four (`/messaging/whatsapp-personal`).
    // Nothing to do with the gate above - that controller was already in the
    // tree and already imported here, but its routes had never reached these
    // totals, so this suite was red before 0122 arrived. Listed separately
    // rather than folded into the previous number, because a count that
    // quietly absorbs unfinished work stops being worth reading.
    // 425: call insights' two (`GET /owner/call-insights` and its `/pdf`),
    // tenant-scoped and OwnerRoleGuard'd - see OWNER_ROLE_ROUTES.
    // 426: the handset pairing dialog's status read (0124),
    // `GET /owner/devices/pairing-token/:id`. Tenant-scoped, OwnerRoleGuard'd.
    // 439: doc 27's thirteen - a person's own profile (GET/PATCH) and phone,
    // tenant-scoped; sign-in history's two and the storage quota, cross-tenant;
    // the business profile's GET/PUT, Plan & usage, and the setup guide's
    // skip/unskip/hide/reopen, all tenant-scoped and OwnerRoleGuard'd.
    // 444: device recovery's five (0130) - POST /devices/recover (unguarded,
    // see UNGUARDED), POST /devices/me/recovery (device-authed), the operator's
    // POST /devices/:id/restore (OrgRoleGuard) and the owner console's
    // restore + relink-token (OwnerRoleGuard).
    // 445: the Integrations store's app page read, GET /owner/integrations/:id
    // (doc 28 §10). Tenant-scoped, OwnerRoleGuard'd with every persona.
    // 450: doc 28's store routes (2026-09-22) - Meta's pending-choice read and
    // choose, Meta's disconnect, LinkedIn's ad-account list, and the Google /
    // Microsoft `POST /connections/oauth/abandon`. All tenant-scoped; the first
    // four are OwnerRoleGuard'd (see OWNER_ROLE_ROUTES), abandon is plain
    // AdminKeyGuard + TenantGuard like the rest of ConnectionsController. The
    // Meta and LinkedIn callbacks changed answer (a 302, not JSON), not class.
    // 452: the workspace clock (doc 30) - GET/PUT /owner/time-settings,
    // tenant-scoped, OwnerRoleGuard owner+manager.
    // 453: POST /calls/missed (0133), the handset's missed calls. Device-authed,
    // so the tenant and principal counts do not move.
    // 461: lead boards (0136) - the console's POST /leads and the six
    // /lead-boards routes. All tenant-scoped and CrmPermissionsGuard'd.
    // 464: Time & location's PUT /owner/time-settings/region, tenant-scoped,
    // OwnerRoleGuard owner only.
    // +8: invite by link (0137) - four tenant-scoped /owner/invites routes
    // (OwnerRoleGuard) and four cross-tenant /auth/invites + /auth/identity.
    // 474: branding uploads - POST /org/branding/upload-url (tenant-scoped,
    // OrgRoleGuard + OwnerRoleGuard like PATCH /org/branding) and the
    // unguarded GET /branding-assets/:orgId/:filename that serves them.
    expect(ROUTES).toHaveLength(478);
    expect(new Set(ROUTES.map((r) => r.route)).size).toBe(478);

    const unguarded = ROUTES.filter((r) => r.guards.length === 0);
    const device = ROUTES.filter((r) => r.guards.includes("DeviceAuthGuard"));
    const crossTenant = ROUTES.filter((r) => r.crossTenant);
    const tenantScoped = ROUTES.filter((r) => r.guards.includes("TenantGuard") && !r.crossTenant);
    const internal = ROUTES.filter((r) => r.guards.includes("InternalStreamGuard"));

    expect(sorted(unguarded.map((r) => r.route))).toEqual(sorted(UNGUARDED));
    expect(sorted(device.map((r) => r.route))).toEqual(sorted(DEVICE_AUTHED));
    expect(sorted(crossTenant.map((r) => r.route))).toEqual(sorted(CROSS_TENANT));
    expect(sorted(internal.map((r) => r.route))).toEqual(sorted(INTERNAL));
    // Its guard is the WHOLE chain. A route in this class that also picked up
    // AdminKeyGuard would be silently re-tenanted, and one that lost
    // InternalStreamGuard would be an open cross-tenant feed.
    for (const { route, guards } of internal) {
      expect([route, guards]).toEqual([route, ["InternalStreamGuard"]]);
    }
    // 191: the AI Agent Studio's POST /agents/generate (plain
    // AdminKeyGuard+TenantGuard, same tier as the rest of AgentsController -
    // a preview endpoint like POST /agents/:id/test, not a CRM-object route).
    // 362: plus the call-access gate's nine (0122).
    // 366: plus personal-WhatsApp pairing's four - GET/POST/DELETE
    // messaging/whatsapp-personal and GET .../poll. Org configuration, the
    // same tier as the channels and Embedded Signup controllers beside it.
    // 368: plus call insights' JSON read and its PDF export.
    // 369: plus the handset pairing dialog's status read (0124).
    // 379: plus doc 27's ten tenant-scoped routes.
    // 382: plus device recovery's three restore/relink routes (0130).
    // 383: plus the store's app page read (doc 28 §10).
    // 388: plus doc 28's five store routes (see the total above).
    // 390: plus the workspace clock's two (doc 30).
    // 391: plus a task assignee's accept / decline (0135).
    // 398: plus lead boards' seven (0136).
    // 399: plus Time & location's region PUT.
    // 403: plus invite by link's four /owner/invites routes (0137).
    // 404: plus POST /org/branding/upload-url.
    expect(tenantScoped).toHaveLength(408);
    // Exhaustive: every route is in exactly one class.
    // `internal` is its own class: the worker-to-API stream route carries
    // InternalStreamGuard and no tenant, so it belongs to none of the four
    // above and has to be named here for the partition to stay exhaustive.
    expect(
      unguarded.length + device.length + crossTenant.length + tenantScoped.length + internal.length,
    ).toBe(478); // = ROUTES.length: every route in exactly one class
  });

  it("mounts AdminKeyGuard FIRST and TenantGuard SECOND on all 422 principal routes", () => {
    // 422: plus lead boards' seven (0136), all tenant-scoped.
    // 414 = 382 tenant-scoped principal + 32 cross-tenant, after the
    // workspace clock's GET/PUT /owner/time-settings (doc 30).
    // 412 = 380 tenant-scoped principal + 32 cross-tenant, after the store's
    // app page read (doc 28 §10) and doc 28's five store routes - all six
    // tenant-scoped, none cross-tenant.
    // 406 = 374 tenant-scoped principal + 32 cross-tenant, after device
    // recovery's three restore/relink routes (0130).
    // 403 = 371 tenant-scoped principal + 32 cross-tenant, after doc 27's
    // thirteen (ten tenant-scoped, three cross-tenant).
    // 390 = 361 tenant-scoped principal + 29 cross-tenant; the newest was the
    // handset pairing dialog's status read (0124). 389 before it, of which
    // the last two were call insights' read and PDF export. 387 before them. This number was
    // left at 374 when the call-access gate (0122) added nine routes and the
    // total above was updated without it, so the suite was already failing
    // here before personal-WhatsApp pairing added its four. Both are counted
    // in now. `TenantGuard` reads
    // `req.principal`, which only `AdminKeyGuard` writes, so the order is a
    // correctness requirement and not a style - tenant.guard.spec.ts's
    // chain-order block shows the reversed pair 401s a perfectly valid
    // request. Asserting the INDICES (not just membership) is what makes a
    // reordered `@UseGuards` fail here.
    const principalRoutes = ROUTES.filter((r) => r.guards.includes("AdminKeyGuard"));
    // 430: plus invite by link's eight (0137) - four tenant-scoped, four cross-tenant.
    // 434: plus POST /org/branding/upload-url, and the Platform Hub's
    // GET /analytics/active-users + /analytics/booking-rate, which reached
    // CROSS_TENANT without this count moving.
    expect(principalRoutes).toHaveLength(438);

    for (const { route, guards } of principalRoutes) {
      expect([route, guards[0]]).toEqual([route, "AdminKeyGuard"]);
      expect([route, guards[1]]).toEqual([route, "TenantGuard"]);
    }
  });

  it("never mounts TenantGuard without a guard that writes req.principal", () => {
    // The other direction of the same dependency: a route with only
    // `TenantGuard` would reject every request with a 401 that reads like an
    // auth outage. Cheap to assert, and it is the shape a copy-paste error
    // actually takes.
    //
    // This used to read "without AdminKeyGuard", which was the same statement
    // while AdminKeyGuard was the only thing that wrote `req.principal`.
    // `ApiKeyGuard` (0076) is the second, and TenantGuard reads
    // `principal.orgId` without caring which one filled it in. The invariant
    // being asserted was never really about AdminKeyGuard - it is that
    // TenantGuard is preceded by SOMETHING that authenticates - so it is
    // widened by naming the closed set, not by dropping the check.
    //
    // The set is closed on purpose: a third principal-writing guard has to be
    // added HERE, which is the review this test exists to force.
    const PRINCIPAL_WRITERS = ["AdminKeyGuard", "ApiKeyGuard"];
    for (const { route, guards } of ROUTES) {
      if (guards.includes("TenantGuard")) {
        const writer = guards.find((g) => PRINCIPAL_WRITERS.includes(g));
        expect([route, writer !== undefined]).toEqual([route, true]);
        // And it must come FIRST, for the same reason AdminKeyGuard does:
        // TenantGuard reads what it writes.
        expect([route, guards.indexOf(writer!)]).toEqual([route, 0]);
      }
    }
  });

  it("pins the eight API-key routes as an explicit allowlist, each declaring a scope", () => {
    // The blast-radius test for the external surface.
    //
    // `api_keys` is a credential a TENANT mints and may hand to a third party.
    // Before 0076 nothing authenticated with it, so the question "what can an
    // API key reach" had the answer "nothing". Now it has a real answer, and
    // that answer must be a short list somebody has read - not a property that
    // emerges from 246 routes' worth of decorators.
    //
    // Two things are asserted, and the second is the load-bearing one:
    //   1. exactly these routes accept an API key;
    //   2. every one of them declares an `@RequireScope`. ApiKeyGuard already
    //      fails closed on a handler with no scope metadata, but a route that
    //      403s in production is a bug found late; this finds it in CI.
    //
    // Nothing here can send a message, read a recording or transcript, delete,
    // merge, or move a card between stages - there is no route and no scope for
    // any of it. Adding one means editing this list.
    const API_KEYED = [
      "POST /public/leads",
      "GET /public/leads",
      "GET /public/leads/:id",
      "GET /public/contacts",
      "GET /public/deals",
      "GET /public/projects",
      "POST /mcp",
      "GET /mcp",
    ];
    const apiKeyed = ROUTES.filter((r) => r.guards.includes("ApiKeyGuard"));
    expect(sorted(apiKeyed.map((r) => r.route))).toEqual(sorted(API_KEYED));

    // Every API-keyed route is ApiKeyGuard THEN TenantGuard, and nothing else:
    // no AdminKeyGuard (which would grant platform_admin), no CrmPermissionsGuard
    // (whose grid resolves a person, and there is no person here).
    for (const { route, guards } of apiKeyed) {
      expect([route, guards]).toEqual([route, ["ApiKeyGuard", "TenantGuard"]]);
    }
  });

  it("keeps the device credential and the principal credential on disjoint routes", () => {
    // Inventory 13 §2.0: `DeviceAuthGuard` never coexists with the principal
    // chain - `req.device` and `req.principal` are separate properties on
    // separate route sets, and device-auth.guard.spec.ts pins that a device
    // token sets neither `principal` nor `tenantOrgId`. A route carrying both
    // would authenticate under one and scope under the other.
    for (const { route, guards } of ROUTES) {
      if (guards.includes("DeviceAuthGuard")) {
        expect([route, guards]).toEqual([route, ["DeviceAuthGuard"]]);
      }
    }
  });

  it("mounts PermissionsGuard and OwnerRoleGuard only where inventory 13 §2.3/§2.4 say", () => {
    // Both read `req.principal`, so both must come after AdminKeyGuard - and
    // both are mounted on so few routes that an accidental extra mount (or a
    // lost one) is worth failing over. `GET /owner/overview` carrying
    // OwnerRoleGuard while declaring no `@RequireOwnerRole` is inventory 13 §7
    // finding 3: the guard is mounted and inert. That is asserted here as
    // today's shape, with the behavioural half in owner-role.guard.spec.ts O1.
    const withPermissions = ROUTES.filter((r) => r.guards.includes("PermissionsGuard"));
    const withOwnerRole = ROUTES.filter((r) => r.guards.includes("OwnerRoleGuard"));

    expect(sorted(withPermissions.map((r) => r.route))).toEqual(sorted(PERMISSION_ROUTES));
    expect(sorted(withOwnerRole.map((r) => r.route))).toEqual(sorted(OWNER_ROLE_ROUTES));

    for (const { route, guards } of [...withPermissions, ...withOwnerRole]) {
      const last = guards.indexOf("TenantGuard");
      const index = guards.findIndex((g) => g === "PermissionsGuard" || g === "OwnerRoleGuard");
      expect([route, index > last]).toEqual([route, true]);
    }
  });

  it("mounts OrgRoleGuard on exactly the org-administration routes, after TenantGuard", () => {
    // Same shape as the PermissionsGuard/OwnerRoleGuard assertion above: a
    // route that quietly LOSES this guard reopens the self-promotion hole
    // this fix closed, and a route that gains it unexpectedly is a silent
    // lockout.
    const withOrgRole = ROUTES.filter((r) => r.guards.includes("OrgRoleGuard"));
    expect(sorted(withOrgRole.map((r) => r.route))).toEqual(sorted(ORG_ROLE_ROUTES));

    for (const { route, guards } of withOrgRole) {
      expect([route, guards.indexOf("OrgRoleGuard") > guards.indexOf("TenantGuard")]).toEqual([
        route,
        true,
      ]);
    }
  });

  it("mounts CallAccessGuard on exactly the call-content routes, after TenantGuard", () => {
    // THE assertion the call-access gate (0122) rests on.
    //
    // A gate is only worth what its least-guarded route is worth, and the
    // failure mode is not a broken test - it is a new call endpoint shipped
    // next year by somebody who never read the guard, through which a
    // customer's recordings leave while the feature still reports itself as
    // enforced. Reflecting over the real Nest metadata is what makes that a
    // red build instead.
    const gated = ROUTES.filter((r) => r.guards.includes("CallAccessGuard"));
    expect(sorted(gated.map((r) => r.route))).toEqual(sorted(CALL_CONTENT_ROUTES));

    for (const { route, guards } of gated) {
      // It reads `req.principal` (AdminKeyGuard) and `req.tenantOrgId`
      // (TenantGuard) and queries the org's gate setting with both. Running it
      // first would 401 every request rather than gate anything.
      expect([route, guards.indexOf("CallAccessGuard") > guards.indexOf("TenantGuard")]).toEqual([
        route,
        true,
      ]);
    }
  });

  it("mounts OperatorOnlyGuard on exactly the instance and call-access routes, after TenantGuard", () => {
    // A route that LOSES this guard reopens the gap it closed: enrollment-token
    // minting reachable by any tenant console user. A route that GAINS it
    // unexpectedly is a silent lockout of the operator console.
    const operatorOnly = ROUTES.filter((r) => r.guards.includes("OperatorOnlyGuard"));
    expect(sorted(operatorOnly.map((r) => r.route))).toEqual(sorted(OPERATOR_ONLY_ROUTES));

    for (const { route, guards } of operatorOnly) {
      // It reads `req.principal`, which only AdminKeyGuard writes, so running
      // it before that guard would 401 every operator request.
      expect([route, guards.indexOf("OperatorOnlyGuard") > guards.indexOf("TenantGuard")]).toEqual([
        route,
        true,
      ]);
    }
  });

  it("mounts CrmPermissionsGuard on exactly the contact/account/deal routes, after TenantGuard", () => {
    // The guard reads `req.principal` (AdminKeyGuard) and `req.tenantOrgId`
    // (TenantGuard), so like the other two metadata guards its position in the
    // chain is a correctness requirement - it 401s if it runs first.
    const withCrm = ROUTES.filter((r) => r.guards.includes("CrmPermissionsGuard"));
    expect(sorted(withCrm.map((r) => r.route))).toEqual(sorted(CRM_PERMISSION_ROUTES));

    for (const { route, guards } of withCrm) {
      expect([
        route,
        guards.indexOf("CrmPermissionsGuard") > guards.indexOf("TenantGuard"),
      ]).toEqual([route, true]);
    }
  });

  it("gates pipelines, custom-field-definitions and merge by persona, not by grant", () => {
    // Revisited in doc 31 §2 X8, as this test's earlier version asked. The
    // reason these carry no CrmPermissionsGuard still holds -
    // `PermissionObjectType` has no value for a pipeline, a field definition
    // or a merge - but "no grant" had become "no check": every one was plain
    // AdminKeyGuard + TenantGuard, reachable by any console persona. They now
    // take the persona check, and nothing else, so a grant can still be added
    // later without two gates disagreeing.
    const configRoutes = ROUTES.filter(
      (r) =>
        r.route.includes("/pipelines") ||
        r.route.includes("/custom-field-definitions") ||
        r.route.includes("/merge"),
    );
    // 16 since the stage packs landed.
    expect(configRoutes).toHaveLength(16);
    for (const { route, guards } of configRoutes) {
      expect([route, guards]).toEqual([route, ["AdminKeyGuard", "TenantGuard", "OwnerRoleGuard"]]);
    }
  });

  it("lets the bare admin key past the persona check on exactly the pinned routes", () => {
    const marked = ROUTES.filter((r) => r.operatorMayCall);
    expect(sorted(marked.map((r) => r.route))).toEqual(sorted(OPERATOR_MAY_CALL_ROUTES));
    // The marker is only read by OwnerRoleGuard. On a route without it, it
    // would be a comment that looks like a policy.
    for (const { route, guards } of marked) {
      expect([route, guards.includes("OwnerRoleGuard")]).toEqual([route, true]);
    }
  });

  it("pins GET /calls/:id/audio as the full four-guard chain", () => {
    // The single most-guarded route on the platform. Spelled out in full
    // because the chain IS the contract: authenticate, scope to a tenant,
    // check the member's recordings grant, then check the CUSTOMER agreed to
    // let the vendor listen at all.
    //
    // The last two are not redundant, and the order they are read in is the
    // clearest statement of why. `PermissionsGuard` answers a question about a
    // tenant's own member - and answers it with an unconditional yes for
    // anything holding the admin key, which is every console request
    // (`principalHasPermission`). `CallAccessGuard` answers the question that
    // one structurally cannot ask: whether this recording is ours to play.
    expect(byRoute.get("GET /calls/:id/audio")?.guards).toEqual([
      "AdminKeyGuard",
      "TenantGuard",
      "PermissionsGuard",
      "CallAccessGuard",
    ]);
  });

  it("pins the twenty unguarded routes as an explicit allowlist", () => {
    // Inventory 13 §1.2. Each of these is unguarded for a reason recorded in
    // that section (liveness, credential minting, pre-enrollment), and
    // `POST /auth/logout` is a known finding - an anonymous DELETE on the
    // RLS-bypassing pool. Razorpay, Meta's OAuth callback and Meta's leadgen
    // webhook came next, and the lead intake engine's three token endpoints
    // plus LinkedIn's OAuth callback (0078) are the newest: unauthenticated for
    // the same class of reason as the messaging webhook, resolve-then-verify
    // rather than guard-then-trust. Device recovery's POST /devices/recover
    // (0130) is the twentieth, pre-enrollment for the same reason as register.
    // A SIXTEENTH unguarded route is not a judgement call this suite can make,
    // so it fails and asks for one.
    for (const route of UNGUARDED) {
      expect([route, byRoute.get(route)?.guards]).toEqual([route, []]);
    }
  });
});
