import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { PartnerScopeGuard } from "../../common/partner-scope.guard";
import { PartnerCtx, type PartnerContext } from "./partner-context";
import { PartnersService } from "./partners.service";

const SubmitBody = z.object({
  name: z.string().trim().max(160).optional(),
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().email().max(320).optional(),
  note: z.string().trim().max(2000).optional(),
});

/** Hand-built rather than `.partial()` - see partners.controller.ts (Part K §5). */
const ProfileBody = z.object({ name: z.string().trim().min(1).max(160) });

/**
 * The portal (Build docs/39 §19) - five screens, and the whole of what a
 * channel partner can reach.
 *
 * ── THE GUARD STACK IS ONE GUARD, AND THAT IS THE POINT ────────────────────
 *
 * `@UseGuards(PartnerScopeGuard)`. No `AdminKeyGuard` (it would write a
 * `platform_admin` principal onto a broker's request), no `TenantGuard` (it
 * would take the org from a header the partner could set, and would hand this
 * controller an `@OrgId()` it must not have). The guard verifies the admin key
 * itself, resolves the partner from the database, and writes `req.partner`.
 * partner-scope.guard.ts sets out all three reasons at length.
 *
 * It is also what makes these a SIXTH route class in `guard-mounting.spec.ts`
 * (§17 rule 2): not tenant-scoped (no TenantGuard), not cross-tenant (no
 * `@CrossTenant()`), not device, not unguarded, not internal.
 *
 * ── AND WHY THERE IS NO `@OrgId()` ANYWHERE BELOW ──────────────────────────
 *
 * Every handler takes `@PartnerCtx()` and hands the whole object to
 * `withPartnerContext`. There is deliberately no way to get a bare org id out
 * of it and into `db.withOrg` - which is the one mistake that would open the
 * entire tenant to a partner while the code read correctly and every type
 * checked. `partner-scope.guard.spec.ts` greps this directory for `withOrg` to
 * keep it that way.
 */
@Controller("portal")
@UseGuards(PartnerScopeGuard)
export class PortalController {
  constructor(private readonly partners: PartnersService) {}

  /**
   * Who am I, whose portal is this, and what colour is it.
   *
   * The layout's ONE call. Everything in it - the org's name, its branding
   * (0065), the workspace country the phone field starts on (0126) - rides on
   * the row `PartnerScopeGuard` already read to resolve the principal, so this
   * costs no query at all. `AuthService.contextFor` carries branding for the
   * owner console on exactly this reasoning: the alternative is ~125ms of
   * Seoul flight time on every navigation to fetch a hex code.
   */
  @Get("context")
  context(@PartnerCtx() ctx: PartnerContext) {
    return {
      partner: {
        id: ctx.partnerId,
        name: ctx.partnerName,
        code: ctx.partnerCode,
        status: ctx.partnerStatus,
        role: ctx.partnerRole,
      },
      // The TENANT's name and branding. Not their modules, not their features,
      // not their plan: a partner is told whose portal they are in and nothing
      // else about how that business is configured.
      workspace: {
        name: ctx.orgName,
        branding: ctx.branding,
        country: ctx.defaultCountry,
        currency: ctx.baseCurrency,
      },
      me: { email: ctx.email, name: ctx.name },
      // ONE bit about the tenant's configuration, and the exception to the rule
      // stated just above (Build docs/40 §A2).
      //
      // It is the exception because it is not a fact about how the business is
      // configured - it is whether the surface the caller is standing on exists
      // at all, asked by a partner this tenant themselves created. Withholding
      // it buys nothing and costs the only thing that matters here: without it
      // the web tier cannot tell "your portal is switched off" from "you are not
      // a partner", and would have to bounce an authenticated partner to a login
      // page they have already passed.
      //
      // This route is deliberately NOT gated - every route that returns portal
      // DATA is, inside `withPartnerContext`. "Who am I and does this exist" has
      // to stay answerable for the 404 to be renderable.
      portalEnabled: ctx.portalEnabled,
    };
  }

  // ── Screen 1: Submit a lead ──────────────────────────────────────────────

  @Post("submissions")
  async submit(@PartnerCtx() ctx: PartnerContext, @Body() body: unknown) {
    const parsed = SubmitBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.partners.submit(ctx, parsed.data);
  }

  // ── Screen 2: My submissions ─────────────────────────────────────────────

  @Get("submissions")
  async submissions(@PartnerCtx() ctx: PartnerContext, @Query("limit") limit?: string) {
    const parsed = z.coerce.number().int().min(1).max(200).safeParse(limit ?? 50);
    return this.partners.listSubmissions(ctx, parsed.success ? parsed.data : 50);
  }

  @Get("submissions/:id")
  async submission(@PartnerCtx() ctx: PartnerContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.partners.submissionDetail(ctx, id);
  }

  // ── Screen 3: My commissions ─────────────────────────────────────────────

  @Get("commissions")
  async commissions(@PartnerCtx() ctx: PartnerContext) {
    return this.partners.commissions(ctx);
  }

  // ── Screen 4: Resources ──────────────────────────────────────────────────
  //
  // No route. §19's Resources screen is tenant-uploaded collateral, and the
  // table that holds it is `resources`, migration 0165 - doc 39 §24, phase P6.
  // An endpoint written now would return a hard-coded empty array for as long
  // as it took P6 to land, which is a worse thing to have than nothing: it
  // reads as a working feature with no data, so the first person to look at it
  // goes hunting for why the tenant's uploads are not showing. The page
  // renders its empty state from the client and names 0165.

  // ── Screen 5: Profile ────────────────────────────────────────────────────

  @Get("profile")
  async profile(@PartnerCtx() ctx: PartnerContext) {
    return this.partners.profile(ctx);
  }

  /**
   * The one thing a partner may change: their own display name.
   *
   * Not their email (bound to the Google identity the invite was accepted
   * with), and nothing at all about the `partners` row - name, kind, code,
   * status and commission plan are the TENANT's record of a commercial
   * relationship. A broker who could flip their own status to 'active' would
   * be editing the other side's contract.
   */
  @Patch("profile")
  async updateProfile(@PartnerCtx() ctx: PartnerContext, @Body() body: unknown) {
    const parsed = ProfileBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.partners.updateProfile(ctx, parsed.data.name);
  }
}
