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
import { AnalyticsController } from "../modules/analytics/analytics.controller";
import { SearchController } from "../modules/analytics/search.controller";
import { ApiKeysController } from "../modules/auth/apikeys.controller";
import { AuthController } from "../modules/auth/auth.controller";
import { BillingController } from "../modules/billing/billing.controller";
import { CallsController } from "../modules/calls/calls.controller";
import { NotesController } from "../modules/calls/notes.controller";
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
import { MessagingChannelsController } from "../modules/conversations/messaging-channels.controller";
import { MessagingWebhookController } from "../modules/conversations/messaging-webhook.controller";
import { ConversationQualificationController } from "../modules/conversations/conversation-qualification.controller";
import { WhatsAppSendController } from "../modules/conversations/whatsapp-send.controller";
import { TagsController } from "../modules/tags/tags.controller";
import { MarketingSourcesController } from "../modules/tags/marketing-sources.controller";
import { ProjectsController } from "../modules/projects/projects.controller";
import { McpController } from "../modules/mcp/mcp.controller";
import { PublicApiController } from "../modules/public-api/public-api.controller";
import { McpServerController } from "../modules/public-api/mcp-server.controller";
import { OutreachController } from "../modules/outreach/outreach.controller";
import { ProductsController } from "../modules/products/products.controller";
import { QuotationsController } from "../modules/quotations/quotations.controller";
import { InvoicesController } from "../modules/invoices/invoices.controller";
import { PaymentsController } from "../modules/invoices/payments.controller";
import { RazorpayWebhookController } from "../modules/invoices/razorpay-webhook.controller";
import { ImportController } from "../modules/import/import.controller";
import { MetaOAuthController } from "../modules/meta-ads/meta-oauth.controller";
import { MetaWebhookController } from "../modules/meta-ads/meta-webhook.controller";
import { ReportBuilderController } from "../modules/report-builder/report-builder.controller";
import { ReportDatasetsController } from "../modules/report-builder/report-datasets.controller";
import { LeadsController } from "../modules/owner/leads.controller";
import { OwnerController } from "../modules/owner/owner.controller";
import { OwnerTeamController } from "../modules/owner/owner-team.controller";
import { OwnerCallsController } from "../modules/owner/owner-calls.controller";
import { TelecallerProductivityController } from "../modules/owner/telecaller-productivity.controller";
import { CallSopsController } from "../modules/owner/call-sops.controller";
import { OwnersController } from "../modules/owner/owners.controller";
import { IntakeWebhookController } from "../modules/lead-intake/intake-webhook.controller";
import { LeadSourcesController } from "../modules/lead-intake/lead-sources.controller";
import { LinkedInOAuthController } from "../modules/lead-intake/linkedin-oauth.controller";
import { RolesController } from "../modules/roles/roles.controller";
import { ErasureController } from "../modules/tenancy/erasure.controller";
import { MembersController } from "../modules/tenancy/members.controller";
import { TenancyController } from "../modules/tenancy/tenancy.controller";
import { WorkspacesController } from "../modules/tenancy/workspaces.controller";
import { CROSS_TENANT_KEY } from "./tenant.guard";

/** Every controller in `app.module.ts`'s module graph, in inventory 13 §1.1 order. */
const CONTROLLERS: Array<Type<unknown>> = [
  HealthController,
  AuthController,
  ApiKeysController,
  AdminController,
  OperatorsController,
  AgentsController,
  AnalyticsController,
  SearchController,
  BillingController,
  CallsController,
  NotesController,
  CrmController,
  AppDownloadController,
  DevicesController,
  DeviceTelemetryController,
  InstancesController,
  LeadsController,
  OwnerCallsController,
  TelecallerProductivityController,
  CallSopsController,
  OwnerController,
  OwnerTeamController,
  OwnersController,
  ErasureController,
  MembersController,
  TenancyController,
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
  // Kailash gap Milestone 2: bulk CSV import (migration 0062). AdminKeyGuard+
  // TenantGuard only - a bulk operation over a caller-chosen entity type,
  // the same administrative tier scripts/backfill-crm-objects.js already
  // operates at, not a per-record CrmPermissionsGuard surface.
  ImportController,
  // Kailash gap Milestone 4: Meta Lead Ads capture (migration 0063).
  // MetaOAuthController mixes both regimes in one class, like TagsController
  // does - `start` needs a signed-in tenant, `callback` is Meta's own
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
  //  - LeadSourcesController is ordinary org CONFIGURATION on
  //    AdminKeyGuard+TenantGuard, the tier projects/tags/marketing-sources sit
  //    on. Deliberately not CrmPermissionsGuard'd: `PermissionObjectType` has
  //    no value for a settings page, and widening it would mean seeding grants
  //    for five system roles to gate a catalogue.
  //  - LinkedInOAuthController mixes both in one class, like MetaOAuthController
  //    does: `oauth/callback` is LinkedIn's own browser redirect and verifies
  //    itself with a signed state token instead of a guard.
  IntakeWebhookController,
  LeadSourcesController,
  LinkedInOAuthController,
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
const UNGUARDED = [
  "GET /health",
  "POST /auth/login",
  "POST /auth/logout",
  "POST /devices/register",
  "POST /devices/challenge",
  "POST /devices/authenticate",
  "POST /messaging/webhook/:token",
  // Razorpay's payment-link webhook (migration 0060). See razorpay-webhook.controller.ts's
  // header for the resolve-org-then-verify-signature ordering that makes this
  // safe to leave unguarded.
  "POST /webhooks/razorpay",
  // Meta's own OAuth redirect lands here with no Aura credentials - verifies
  // itself via the signed `state` param instead (meta-client.ts).
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
  // itself via the signed `state` param, exactly like Meta's.
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
  "GET /devices/me/config",
  "POST /devices/me/health",
  "POST /devices/me/events",
  "GET /devices/me/calls/:callId",
  // The handset's own update check. Advisory only - it cannot gate recording,
  // and the APK URL is presigned per request rather than stored. DeviceAuthGuard
  // like every other /devices/me route: the signed device token IS the identity.
  "GET /devices/me/update",
];

/** §1.1 rows 3, 4, 9, 10, 18 - the operator surface, all on the RLS-bypassing pool. */
const CROSS_TENANT = [
  "GET /auth/context",
  "GET /auth/me",
  "POST /admin/tenants",
  "GET /admin/tenants",
  "PATCH /admin/tenants/:orgId/modules",
  "GET /admin/health",
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

/** §2.3 - one route on the whole platform. */
const PERMISSION_ROUTES = ["GET /calls/:id/audio"];

/** §2.4 - two controllers. */
const OWNER_ROLE_ROUTES = [
  "GET /owner/overview",
  "GET /owner/crm-overview",
  // Telecaller productivity (0090). Mounts OwnerRoleGuard at class level and
  // declares NO `@RequireOwnerRole` on the read - the same shape inventory 13
  // finding 3 flagged on `GET /owner/overview`, and, as there, the fix was not
  // a persona requirement. Every persona may see their own talk time; what must
  // not happen is a telecaller reading the floor's. The narrowing comes from
  // OwnerScopeGuard, which is never inert.
  "GET /owner/productivity",
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
  // The client's own call log. Unlike the three above it declares a real
  // `@RequireOwnerRole("owner", "manager")` at class level rather than
  // mounting the guard inertly: reading the whole floor's conversations is a
  // manager's view of the team, not a telecaller's view of their own work.
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
  "POST /owner/calls/:id/reprocess",
];

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
  "POST /roles",
  "PATCH /roles/:id",
  "PUT /roles/:id/permissions",
  "POST /erasure-requests",
  "POST /devices/:id/logout",
  "POST /devices/:id/wipe",
  "DELETE /devices/:id",
  "POST /workspaces",
];

/**
 * The CRM object model's enforced surface - every route that consults the
 * `role_permissions` grid (migration 0039) via `CrmPermissionsGuard`.
 *
 * Pinned as an exhaustive list for the same reason PERMISSION_ROUTES is: a
 * route that quietly LOSES its guard is a silent authorization hole, and a
 * route that gains one unexpectedly is a silent lockout. `pipelines`,
 * `custom-field-definitions` and `merge` are deliberately absent -
 * `PermissionObjectType` is contact|account|deal only, so there is no grant
 * for them to check yet; they remain AdminKeyGuard+TenantGuard as before.
 */
const CRM_PERMISSION_ROUTES = [
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
  // Track A3. `task` joined PermissionObjectType with migration 0041, which
  // also seeds every system role's task grants - so these are enforced from
  // the moment they ship, rather than being a retrofit later.
  "GET /tasks",
  "GET /tasks/:id",
  "POST /tasks",
  "PATCH /tasks/:id",
  // The inbox (migrations 0055/0056), on the `conversation` object type.
  // There is no POST here and that is the point: safety rule 3 survives only
  // while no general-purpose "post a message" route sits behind an ordinary
  // permission. Reading, routing, claiming and closing - never sending.
  "GET /conversations",
  "GET /conversations/:id",
  "PATCH /conversations/:id",
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
  // PRD Layer 3. Viewing a report needs `deal:view`; the CSV export needs
  // `deal:export` - the first route on the platform to use that action, and
  // the reason the export is its own route rather than a `?format=` param.
  "GET /reports/pipeline",
  "GET /reports/performance",
  "GET /reports/conversion",
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
];

interface Route {
  /** `"GET /calls/:id"` - verb plus the declared path, no `v1` prefix. */
  route: string;
  /** Class guards then handler guards, which is the order Nest runs them in. */
  guards: string[];
  crossTenant: boolean;
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

  it("has 319 routes, partitioned 266 tenant / 29 cross-tenant / 7 device / 17 unguarded", () => {
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
    // - and the lead intake engine's fifteen (0078): three unguarded intake
    // webhooks (form/telephony/email), seven tenant-scoped `/lead-sources/*`
    // configuration routes, and five for LinkedIn, of which `oauth/callback` is
    // unguarded because LinkedIn's browser redirect carries no credential of
    // ours. Nothing here is cross-tenant or device-authed.
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
    expect(ROUTES).toHaveLength(319);
    expect(new Set(ROUTES.map((r) => r.route)).size).toBe(319);

    const unguarded = ROUTES.filter((r) => r.guards.length === 0);
    const device = ROUTES.filter((r) => r.guards.includes("DeviceAuthGuard"));
    const crossTenant = ROUTES.filter((r) => r.crossTenant);
    const tenantScoped = ROUTES.filter((r) => r.guards.includes("TenantGuard") && !r.crossTenant);

    expect(sorted(unguarded.map((r) => r.route))).toEqual(sorted(UNGUARDED));
    expect(sorted(device.map((r) => r.route))).toEqual(sorted(DEVICE_AUTHED));
    expect(sorted(crossTenant.map((r) => r.route))).toEqual(sorted(CROSS_TENANT));
    // 191: the AI Agent Studio's POST /agents/generate (plain
    // AdminKeyGuard+TenantGuard, same tier as the rest of AgentsController -
    // a preview endpoint like POST /agents/:id/test, not a CRM-object route).
    expect(tenantScoped).toHaveLength(266);
    // Exhaustive: every route is in exactly one class.
    expect(unguarded.length + device.length + crossTenant.length + tenantScoped.length).toBe(319);
  });

  it("mounts AdminKeyGuard FIRST and TenantGuard SECOND on all 281 principal routes", () => {
    // 241 tenant-scoped + 24 cross-tenant. `TenantGuard` reads
    // `req.principal`, which only `AdminKeyGuard` writes, so the order is a
    // correctness requirement and not a style - tenant.guard.spec.ts's
    // chain-order block shows the reversed pair 401s a perfectly valid
    // request. Asserting the INDICES (not just membership) is what makes a
    // reordered `@UseGuards` fail here.
    const principalRoutes = ROUTES.filter((r) => r.guards.includes("AdminKeyGuard"));
    expect(principalRoutes).toHaveLength(287);

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

  it("mounts CrmPermissionsGuard on exactly the contact/account/deal routes, after TenantGuard", () => {
    // The guard reads `req.principal` (AdminKeyGuard) and `req.tenantOrgId`
    // (TenantGuard), so like the other two metadata guards its position in the
    // chain is a correctness requirement - it 401s if it runs first.
    const withCrm = ROUTES.filter((r) => r.guards.includes("CrmPermissionsGuard"));
    expect(sorted(withCrm.map((r) => r.route))).toEqual(sorted(CRM_PERMISSION_ROUTES));

    for (const { route, guards } of withCrm) {
      expect([route, guards.indexOf("CrmPermissionsGuard") > guards.indexOf("TenantGuard")]).toEqual(
        [route, true],
      );
    }
  });

  it("leaves pipelines, custom-field-definitions and merge unenforced, as scoped", () => {
    // Asserted rather than assumed: these carry the root ADMIN_API_KEY like
    // every other tenant route, and the reason they are NOT permission-checked
    // is that `PermissionObjectType` has no value for them yet - not that
    // somebody forgot. If that enum grows, this test is where the decision
    // gets revisited.
    const unenforced = ROUTES.filter(
      (r) =>
        r.route.includes("/pipelines") ||
        r.route.includes("/custom-field-definitions") ||
        r.route.includes("/merge"),
    );
    expect(unenforced).toHaveLength(14);
    for (const { route, guards } of unenforced) {
      expect([route, guards]).toEqual([route, ["AdminKeyGuard", "TenantGuard"]]);
    }
  });

  it("pins GET /calls/:id/audio as the full four-guard chain", () => {
    // The single most-guarded route on the platform and the only consumer of
    // PermissionsGuard. Spelled out in full because the chain IS the contract:
    // authenticate, scope to a tenant, then check the recordings grant.
    expect(byRoute.get("GET /calls/:id/audio")?.guards).toEqual([
      "AdminKeyGuard",
      "TenantGuard",
      "PermissionsGuard",
    ]);
  });

  it("pins the seventeen unguarded routes as an explicit allowlist", () => {
    // Inventory 13 §1.2. Each of these is unguarded for a reason recorded in
    // that section (liveness, credential minting, pre-enrollment), and
    // `POST /auth/logout` is a known finding - an anonymous DELETE on the
    // RLS-bypassing pool. Razorpay, Meta's OAuth callback and Meta's leadgen
    // webhook came next, and the lead intake engine's three token endpoints
    // plus LinkedIn's OAuth callback (0078) are the newest: unauthenticated for
    // the same class of reason as the messaging webhook, resolve-then-verify
    // rather than guard-then-trust.
    // A SIXTEENTH unguarded route is not a judgement call this suite can make,
    // so it fails and asks for one.
    for (const route of UNGUARDED) {
      expect([route, byRoute.get(route)?.guards]).toEqual([route, []]);
    }
  });
});
