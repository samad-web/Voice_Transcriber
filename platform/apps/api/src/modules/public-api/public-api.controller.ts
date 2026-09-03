import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { ApiKeyGuard, RequireScope } from "../../common/api-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { CrmIngestService } from "./crm-ingest.service";

const CreateLeadBody = z.object({
  name: z.string().max(200).optional(),
  phone: z.string().max(40).optional(),
  email: z.string().email().max(200).optional(),
  notes: z.string().max(4000).optional(),
  facts: z.record(z.string(), z.unknown()).optional(),
  value: z.number().nonnegative().optional(),
  projectKey: z.string().max(60).optional(),
})
  // A lead with no way to reach the person is not a lead, it is a row. The
  // console would show a card nobody can act on, which is worse than a 400.
  .refine((b) => Boolean(b.phone || b.email || b.name), {
    message: "at least one of phone, email or name is required",
  });

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  stage: z.string().max(40).optional(),
  projectKey: z.string().max(60).optional(),
  search: z.string().max(200).optional(),
});

/**
 * The tenant-facing write/read API for external systems.
 *
 * ── WHY A SEPARATE CONTROLLER AND NOT SCOPES ON THE EXISTING ROUTES ───────
 *
 * Every existing CRM route is mounted `AdminKeyGuard, TenantGuard` and reaches
 * a console with a signed-in human behind it. Bolting a second credential onto
 * those 200+ routes would mean every one of them - including recording
 * playback and erasure - becomes reachable by a headless key the moment
 * someone forgets a scope annotation. The blast radius of a mistake would be
 * the whole product.
 *
 * A separate, deliberately small surface inverts that: a route is reachable by
 * an API key only if it is written HERE, and `ApiKeyGuard` refuses any handler
 * that forgot to declare a scope. Forgetting fails closed, and the reviewable
 * question is "what is in this file", not "what is missing from 200 others".
 *
 * ── THROTTLED ────────────────────────────────────────────────────────────
 *
 * `@SkipThrottle()` exists in this codebase for the device beacon, whose
 * written rationale is that dropping it means losing recordings. Nothing here
 * has that property: an integration that is rate-limited retries, and an agent
 * that is rate-limited waits. 120/min is generous for a CRM integration and
 * still bounds a runaway loop - which, on the MCP door, is a real failure mode
 * rather than a theoretical one.
 */
@Controller("public")
@UseGuards(ApiKeyGuard, TenantGuard)
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class PublicApiController {
  constructor(private readonly ingest: CrmIngestService) {}

  /**
   * Create (or converge onto) a lead, with its contact and deal.
   *
   * Not idempotent by a caller-supplied key, but convergent by identity: two
   * pushes of the same phone number update one lead rather than making two,
   * because the dedup key is the counterparty number - the same key the call
   * pipeline uses. `created` in the response says which happened, so a caller
   * can tell "new business" from "we already knew them".
   */
  @Post("leads")
  @RequireScope("leads:write")
  async createLead(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    const parsed = CreateLeadBody.safeParse(body);
    if (!parsed.success) {
      await this.event(req, orgId, "POST /public/leads", "invalid", {
        issues: parsed.error.issues.length,
      });
      throw new BadRequestException(parsed.error.issues);
    }
    // Stamped so a key-pushed lead is distinguishable on the board from a web
    // form, a call or an ad - the whole point of migration 0078.
    const lead = await this.ingest.createLead(orgId, { ...parsed.data, sourceChannel: "api" });
    await this.event(req, orgId, "POST /public/leads", "ok", { leadId: lead.leadId });
    return lead;
  }

  @Get("leads")
  @RequireScope("leads:read")
  async listLeads(@OrgId() orgId: string, @Query() query: unknown) {
    const q = ListQuery.parse(query);
    return { leads: await this.ingest.listLeads(orgId, q) };
  }

  @Get("leads/:id")
  @RequireScope("leads:read")
  async getLead(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.ingest.getLead(orgId, id);
  }

  @Get("contacts")
  @RequireScope("contacts:read")
  async listContacts(@OrgId() orgId: string, @Query() query: unknown) {
    const q = ListQuery.parse(query);
    return { contacts: await this.ingest.listContacts(orgId, q) };
  }

  @Get("deals")
  @RequireScope("deals:read")
  async listDeals(@OrgId() orgId: string, @Query() query: unknown) {
    const q = ListQuery.parse(query);
    return { deals: await this.ingest.listDeals(orgId, q) };
  }

  /**
   * The project catalogue, so an integration can send `projectKey` instead of
   * hoping the detector recognises its wording.
   */
  @Get("projects")
  @RequireScope("projects:read")
  async listProjects(@OrgId() orgId: string) {
    return { projects: await this.ingest.listProjects(orgId) };
  }

  private async event(
    req: PrincipalRequest,
    orgId: string,
    operation: string,
    status: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (!req.apiKey) return;
    await this.ingest.recordEvent(orgId, req.apiKey.id, "rest", operation, status, detail);
  }
}
