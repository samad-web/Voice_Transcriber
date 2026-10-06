import { Module } from "@nestjs/common";
import { LeadIntakeModule } from "../lead-intake/lead-intake.module";
import { SupabaseAdminService } from "../owner/supabase-admin.service";
import { PartnerInvitesService } from "./partner-invites.service";
import { PartnersController } from "./partners.controller";
import { PartnersService } from "./partners.service";
import { PortalController } from "./portal.controller";
import { PortalInvitesController } from "./portal-invites.controller";

/**
 * Channel partners and the portal shell - P4, migrations 0162 and 0163
 * (Build docs/39 §17-§19).
 *
 * ── THREE CONTROLLERS, THREE DIFFERENT AUDIENCES ───────────────────────────
 *
 *   PartnersController      the TENANT's console. AdminKeyGuard + TenantGuard +
 *                           CrmPermissionsGuard on the `partner` object type.
 *                           Ordinary tenant routes in every way.
 *
 *   PortalController        the PARTNER. PartnerScopeGuard alone - a sixth
 *                           route class, and the only place `app.partner_id`
 *                           is ever set.
 *
 *   PortalInvitesController NOBODY yet. AdminKeyGuard + TenantGuard +
 *                           @CrossTenant(), like AuthInvitesController: the
 *                           person holding the link has no principal until
 *                           they accept, and the token is what names the org.
 *
 * Kept in one module because they are one subsystem with one invariant between
 * them - a partner has a `partner_users` row and no membership - and splitting
 * the roster from the portal would put the two halves of that sentence in two
 * places.
 *
 * ── WHAT IS IMPORTED, AND WHY NOTHING IS EXPORTED ──────────────────────────
 *
 * `LeadIntakeModule` for `LeadIntakeService`, rather than re-providing it:
 * §16's instruction is that a submission reuses intake and does not fork it,
 * and a second instance would be the first step towards a second definition of
 * what creating a lead means. `SupabaseAdminService` is provided locally, the
 * same way AdminModule and OwnerModule each provide their own - it holds no
 * state beyond two env strings, so a third instance costs nothing and avoids a
 * circular import on OwnerModule.
 *
 * Nothing is exported. Nothing outside this module should be able to reach a
 * partner's data without going through a controller that mounts
 * `PartnerScopeGuard` or `CrmPermissionsGuard`.
 *
 * ⚠ NOT YET REGISTERED IN `app.module.ts` - that file belongs to another
 * change in this phase. Until the import lands, every route below 404s and the
 * isolation suite's partner cases cannot reach a handler.
 */
@Module({
  imports: [LeadIntakeModule],
  controllers: [PartnersController, PortalController, PortalInvitesController],
  providers: [PartnersService, PartnerInvitesService, SupabaseAdminService],
})
export class PartnersModule {}
