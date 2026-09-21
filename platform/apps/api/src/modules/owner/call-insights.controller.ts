import { BadRequestException, Controller, Get, Header, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import {
  CallInsightsQuery,
  type CallInsightsReport,
  type CallInsightsWindow,
  callInsightsFilename,
  callInsightsWindow,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgFeatureGuard, RequireFeature } from "../../common/org-feature.guard";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { renderCallInsightsPdf } from "./call-insights-pdf";
import { assembleCallInsights, type BatchResult, callInsightsBatch } from "./call-insights.query";

/**
 * Call insights - the floor-wide read of every call in a range, as JSON for
 * the console page and as a PDF for taking off the platform.
 *
 * ── ONE READ, TWO RENDERINGS ────────────────────────────────────────────────
 *
 * Both routes call the same `load()`, which is the same statement batch and the
 * same assembly. A PDF that could disagree with the page it was downloaded from
 * would be the copy that gets forwarded, so there is exactly one place the
 * numbers come from - the same rule reports.controller.ts holds for its CSVs.
 *
 * ── WHO MAY READ IT ─────────────────────────────────────────────────────────
 *
 * Owner and manager, like the call log it summarises (owner-calls.controller
 * .ts) and the staff scorecard: it is a view over the whole floor's
 * conversations and it ranks named colleagues. A telecaller's own numbers are
 * on /owner/productivity, which narrows rows rather than refusing the page.
 *
 * `call_insights` is a feature of the `call_intel` module (features.ts), and
 * OrgFeatureGuard resolves both axes on every request - a tenant without the
 * module, or whose owner switched the page off, gets a 403 here as well as a
 * hidden page there.
 *
 * ── WHAT IT CANNOT RETURN ───────────────────────────────────────────────────
 *
 * Transcript text and risk-flag snippets are never selected (see
 * call-insights.query.ts), so there is no `recordings_listen` redaction to do:
 * the attention list carries the AI summary, which the call log already shows
 * both personas unredacted.
 */
@Controller("owner/call-insights")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard, OrgFeatureGuard)
@RequireOwnerRole("owner", "manager")
@RequireFeature("call_insights")
export class CallInsightsController {
  constructor(private readonly db: DbService) {}

  @Get()
  async insights(@OrgId() orgId: string, @Query() query: unknown): Promise<CallInsightsReport> {
    const { window } = parse(query);
    return this.load(orgId, window);
  }

  /**
   * The same report as a file.
   *
   * A separate route rather than `?format=pdf`, for the reason the CSV exports
   * give: an export is a different act from a read - it leaves the platform
   * with no permission attached any more - and it is audited as one.
   * `calls=0` leaves out the per-call list (contact names and summaries) for a
   * copy meant for a wider audience.
   */
  @Get("pdf")
  @Header("Cache-Control", "no-store")
  async pdf(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Query() query: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const { window, includeCalls } = parse(query);
    const report = await this.load(orgId, window);
    const pdf = await renderCallInsightsPdf(report, { includeCalls });

    // Audited like a recording playback: a file carrying the floor's numbers,
    // colleagues' names and (unless left out) customers' names has just left
    // the platform, and the tenant may need to know who took it.
    await this.db.withOrg(orgId, (client) =>
      client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, 'call_insights.export', 'report', 'call-insights', $3)`,
        [
          orgId,
          req.principal?.userId ?? "owner",
          JSON.stringify({ from: report.range.from, to: report.range.to, includeCalls, bytes: pdf.length }),
        ],
      ),
    );

    res
      .status(200)
      .setHeader("Content-Type", "application/pdf")
      .setHeader("Content-Length", String(pdf.length))
      .setHeader(
        "Content-Disposition",
        `attachment; filename="${callInsightsFilename(report.org.name, report.range.from, report.range.to)}"`,
      )
      .send(pdf);
  }

  private load(orgId: string, window: CallInsightsWindow): Promise<CallInsightsReport> {
    return this.db.withOrg(orgId, async (client) => {
      // One multi-statement flight - see call-insights.query.ts for why, and
      // for why interpolating the window there is safe.
      const batch = (await client.query(callInsightsBatch(window))) as unknown as BatchResult;
      return assembleCallInsights(batch);
    });
  }
}

function parse(query: unknown): { window: CallInsightsWindow; includeCalls: boolean } {
  const parsed = CallInsightsQuery.safeParse(query);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return { window: callInsightsWindow(parsed.data), includeCalls: parsed.data.calls !== "0" };
}
