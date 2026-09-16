import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Param,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { RecordScope, UNSCOPED, type CrmRecordScope } from "../../common/crm-scope";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { toCsv, safeFilename, type CsvColumn } from "./csv";
import {
  ReportsService,
  type CommissionRow,
  type ConversionRow,
  type PerformanceRow,
  type PipelineRow,
} from "./reports.service";

/** `YYYY-MM-DD`, same contract as tasks.dueOn - a report window is days, not instants. */
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/**
 * `days` - "the last N days, ending today" - as an alternative to naming
 * `from`. The console's dashboard uses it and then builds every drill-down link
 * from the `from`/`to` the response echoes, so a metric card and the list it
 * opens are guaranteed to be the same window: the console never has to guess
 * which "today" the API used.
 */
const Days = z.coerce.number().int().min(1).max(366).optional();

const WindowQuery = z.object({
  from: DateOnly.optional(),
  to: DateOnly.optional(),
  days: Days,
  pipelineId: z.string().uuid().optional(),
});

/** A window with no pipeline: the SLA reports are org-wide by construction. */
const DateWindowQuery = z.object({
  from: DateOnly.optional(),
  to: DateOnly.optional(),
  days: Days,
});

const ReportName = z.enum(["pipeline", "performance", "conversion", "commission"]);
type ReportName = z.infer<typeof ReportName>;

/**
 * Default window: the last 90 days, inclusive of today. An explicit `from`
 * wins over `days`; `days` wins over the default.
 */
export function resolveWindow(from?: string, to?: string, days?: number): { from: string; to: string } {
  const end = to ?? new Date().toISOString().slice(0, 10);
  if (from) return { from, to: end };
  const start = new Date(`${end}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - ((days ?? 90) - 1));
  return { from: start.toISOString().slice(0, 10), to: end };
}

/**
 * Reporting & analytics (PRD Layer 3) over the CRM object model.
 *
 * Read-only - no migration backs this module, it aggregates what Tracks A2-A4
 * already store. Distinct from the existing `/v1/analytics`, which reports on
 * CALL VOLUME and device fleet health; this reports on the pipeline.
 *
 * PERMISSIONS. Viewing requires `deal:view`; CSV export requires
 * `deal:export`. That split is the first real use of the `export` action,
 * which has existed in the grid since 0039 and gated nothing - and it is a
 * genuine distinction rather than decoration: reading a number on screen and
 * walking out with every deal's value in a file are different acts, and an
 * org that hands a contractor `view` should be able to withhold the second.
 */
@Controller("reports")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get("pipeline")
  @RequireCrmPermission("deal", "view")
  async pipeline(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = WindowQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.reports.pipeline(orgId, parsed.data.pipelineId, recordScope);
  }

  @Get("performance")
  @RequireCrmPermission("deal", "view")
  async performance(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = WindowQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { from, to } = resolveWindow(parsed.data.from, parsed.data.to, parsed.data.days);
    return this.reports.performance(orgId, from, to, recordScope);
  }

  @Get("conversion")
  @RequireCrmPermission("deal", "view")
  async conversion(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = WindowQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { from, to } = resolveWindow(parsed.data.from, parsed.data.to, parsed.data.days);
    return this.reports.conversion(orgId, from, to, parsed.data.pipelineId, recordScope);
  }

  @Get("commission")
  @RequireCrmPermission("deal", "view")
  async commission(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = WindowQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { from, to } = resolveWindow(parsed.data.from, parsed.data.to, parsed.data.days);
    return this.reports.commission(orgId, from, to, recordScope);
  }

  /**
   * ── The three Tier-1 reports from the Hawcus gap analysis ────────────────
   *
   * Same `deal:view` gate as the four above, and deliberately NOT added to
   * `ReportName`/`:report/export`: those four share one CSV shape (flat rows
   * with a stable header), and these three do not - each returns a KPI block,
   * a breakdown and a work queue. Forcing them through the same exporter
   * would either flatten away the part people need or quietly export only one
   * section of the page. A CSV for these is its own piece of work.
   */

  @Get("response-time")
  @RequireCrmPermission("deal", "view")
  async responseTime(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = DateWindowQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { from, to } = resolveWindow(parsed.data.from, parsed.data.to, parsed.data.days);
    return this.reports.responseTime(orgId, from, to, recordScope);
  }

  @Get("followup-compliance")
  @RequireCrmPermission("deal", "view")
  async followupCompliance(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = DateWindowQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { from, to } = resolveWindow(parsed.data.from, parsed.data.to, parsed.data.days);
    return this.reports.followupCompliance(orgId, from, to, recordScope);
  }

  /**
   * The team roll-up (CRM dashboard Phase 8) - one row per person, not per
   * handset. `deal:view` like its siblings; an `owned` caller is refused in
   * the service, because every row here is somebody else's work.
   */
  @Get("team")
  @RequireCrmPermission("deal", "view")
  async team(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = DateWindowQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { from, to } = resolveWindow(parsed.data.from, parsed.data.to, parsed.data.days);
    return this.reports.team(orgId, from, to, recordScope);
  }

  /** A snapshot of now, so it takes no window - see the service comment. */
  @Get("lead-aging")
  @RequireCrmPermission("deal", "view")
  async leadAging(@OrgId() orgId: string, @RecordScope() recordScope: CrmRecordScope) {
    return this.reports.leadAging(orgId, recordScope);
  }

  /**
   * The same four reports as CSV.
   *
   * A separate route rather than `?format=csv` on the four above, because
   * `CrmPermissionsGuard` reads STATIC decorator metadata: a format query
   * param could not raise the requirement from `view` to `export`. Same
   * reasoning that made A2's timeline routes nested rather than filtered.
   */
  @Get(":report/export")
  @RequireCrmPermission("deal", "export")
  @Header("Cache-Control", "no-store")
  async export(
    @OrgId() orgId: string,
    @Param("report") report: string,
    @Query() query: unknown,
    @Res() res: Response,
    @RecordScope() recordScope: CrmRecordScope,
  ): Promise<void> {
    const name = ReportName.safeParse(report);
    if (!name.success) throw new BadRequestException("unknown report");
    const parsed = WindowQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    const { from, to } = resolveWindow(parsed.data.from, parsed.data.to, parsed.data.days);
    // The export carries the SAME scope as the on-screen report. A CSV that
    // widened it would be the leak with the longest legs - a file, off the
    // platform, with no permission attached to it any more.
    const csv = await this.render(name.data, orgId, from, to, recordScope, parsed.data.pipelineId);

    res
      .status(200)
      .setHeader("Content-Type", "text/csv; charset=utf-8")
      .setHeader(
        "Content-Disposition",
        `attachment; filename="${safeFilename(`aura-${name.data}-${to}`)}.csv"`,
      )
      .send(csv);
  }

  /** Renders through the SAME service the JSON routes use - the two views of
   *  a report must never be able to disagree about the numbers. */
  private async render(
    name: ReportName,
    orgId: string,
    from: string,
    to: string,
    recordScope: CrmRecordScope = UNSCOPED,
    pipelineId?: string,
  ): Promise<string> {
    if (name === "pipeline") {
      const data = await this.reports.pipeline(orgId, pipelineId, recordScope);
      const columns: Array<CsvColumn<PipelineRow>> = [
        { header: "Stage", value: (r) => r.label },
        { header: "Deals", value: (r) => r.deals },
        { header: "Amount", value: (r) => r.amount },
        { header: "Probability", value: (r) => r.probability },
        { header: "Weighted amount", value: (r) => r.weightedAmount },
        { header: "Avg days in stage", value: (r) => r.avgDaysInStage },
      ];
      return toCsv(columns, data.rows);
    }

    if (name === "performance") {
      const data = await this.reports.performance(orgId, from, to, recordScope);
      const columns: Array<CsvColumn<PerformanceRow>> = [
        { header: "Rep", value: (r) => r.rep },
        { header: "Open deals", value: (r) => r.openDeals },
        { header: "Won", value: (r) => r.wonDeals },
        { header: "Lost", value: (r) => r.lostDeals },
        { header: "Open value", value: (r) => r.openValue },
        { header: "Won value", value: (r) => r.wonValue },
        { header: "Win rate", value: (r) => (r.winRate === null ? "" : r.winRate) },
      ];
      return toCsv(columns, data.reps);
    }

    if (name === "commission") {
      const data = await this.reports.commission(orgId, from, to, recordScope);
      const columns: Array<CsvColumn<CommissionRow>> = [
        { header: "Plan", value: (r) => r.planName },
        { header: "Metric", value: (r) => r.metric },
        { header: "Rate type", value: (r) => r.rateType },
        { header: "Rate", value: (r) => r.rate },
        { header: "Rep", value: (r) => r.rep },
        { header: "Metric total", value: (r) => r.metricTotal },
        { header: "Commission", value: (r) => r.commission },
      ];
      return toCsv(columns, data.rows);
    }

    const data = await this.reports.conversion(orgId, from, to, pipelineId, recordScope);
    const columns: Array<CsvColumn<ConversionRow>> = [
      { header: "Stage", value: (r) => r.label },
      { header: "Deals reached", value: (r) => r.reached },
      {
        header: "Conversion from previous",
        value: (r) => (r.conversionFromPrevious === null ? "" : r.conversionFromPrevious),
      },
    ];
    return toCsv(columns, data.rows);
  }
}
