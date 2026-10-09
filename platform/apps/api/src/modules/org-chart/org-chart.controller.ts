import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import {
  DepartmentInput,
  IsoDate,
  OrgChartSettingsInput,
  OrgChangeAction,
  OrgChangeEntity,
  TeamInput,
  childMapOf,
  defaultCollapsed,
  depthMapOf,
  derivePositionStatus,
  deriveHolderPresence,
  dottedLinesAsOf,
  integrityProblems,
  parentMapAsOf,
  rootsOf,
  spanOfControlFlags,
  tenureMonths,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import {
  CrmPermissionsGuard,
  RequireCrmPermission,
  hasCrmGrant,
} from "../../common/crm-permissions.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { renderOrgChartPdf } from "./org-chart-pdf";
import { holdersAsOf, loadChartRows, logOrgChange, orgChartSettings, orgToday } from "./tree";

/**
 * The chart itself: the read every screen starts from, the directory, the
 * analytics, the history and the export
 * (Build docs/org-chart-build-plan.md §5, §6.5, §6.6, §8, §11).
 *
 * ── ONE READ, THREE VIEWS ──────────────────────────────────────────────────
 *
 * `GET /org-chart` serves the tree, the horizontal tree, the list/directory
 * and the PDF. §5.2 lists them as four features; they are one payload and four
 * renderings of it, which is the only arrangement in which "export the current
 * view" can be literally true. The layout maths lives in `@aura/shared` so the
 * browser and the PDF renderer call the same function - see `layoutTree`'s
 * header for why that is not a convenience.
 *
 * ── `asOf` IS THE WHOLE OF TIME TRAVEL ─────────────────────────────────────
 *
 * §5.2's time travel is this one query parameter. There is no separate
 * historical table and no snapshot: the effective dating on `positions`,
 * `reporting_lines` and `position_assignments` IS the history, and §16's
 * acceptance - "as-of view reproduces historical structure correctly" - holds
 * because the live view and the historical one run the same code path with a
 * different date. A snapshot table would have been a second source of truth
 * that drifts, and the first time anybody noticed would be a dispute about who
 * approved something.
 *
 * Read-only in the past is enforced by the CONSOLE (§5.2: "read-only in that
 * mode with a clear banner") rather than here, and that is a real limitation
 * stated rather than hidden: an API caller may still write with an effective
 * date in the past, which is sometimes exactly right - recording a move that
 * happened last week is a backfill, not a mistake. ORG_CHART_DECISIONS.md §6
 * records it.
 */

const ChartQuery = z.object({
  asOf: IsoDate.optional(),
  /** §5.2's filters, applied in the browser; passed through so a PDF can match. */
  departmentId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
});

const DirectoryQuery = z.object({
  asOf: IsoDate.optional(),
  q: z.string().trim().max(200).optional(),
  departmentId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
  status: z.enum(["filled", "vacant", "frozen"]).optional(),
  employmentType: z
    .enum(["full_time", "part_time", "contract", "probation", "intern"])
    .optional(),
});

const ChangesQuery = z.object({
  entity: OrgChangeEntity.optional(),
  entityId: z.string().trim().max(64).optional(),
  action: OrgChangeAction.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
});

const ExportQuery = z.object({
  asOf: IsoDate.optional(),
  /** A branch rather than the whole chart - §5.2's "selected branch". */
  rootPositionId: z.string().uuid().optional(),
  orientation: z.enum(["vertical", "horizontal"]).optional(),
});

@Controller("org-chart")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class OrgChartController {
  constructor(private readonly db: DbService) {}

  /**
   * §8's `GET /org/chart` - flat positions, assignments and reporting lines.
   *
   * ── WHAT IS DELIBERATELY NOT IN THIS PAYLOAD ───────────────────────────────
   *
   * No purpose text, no responsibilities, no authority rows, no contracts.
   * §12's budget is "under ~300 KB for 500 nodes" with "details fetched lazily
   * on node open", and the budget is the lesser reason: every persona can call
   * this route, so the surest way to honour §7's "no sensitive fields in the
   * chart payload for unauthorized roles" is for the payload to have no
   * sensitive fields in it at all. A redaction branch here would be one `if`
   * standing between a telecaller and the whole company's pay.
   *
   * `collapsed` is computed SERVER-side (§5.1/§14: collapse beyond level 3 over
   * ~50 nodes) so the first paint is already folded. Computing it in the
   * browser would render the whole tree once and then collapse it, which is
   * the layout thrash §12's "no layout jump on load" rules out.
   */
  @Get()
  @RequireCrmPermission("position", "view")
  async chart(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = ChartQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const asOf = parsed.data.asOf ?? today;
      const settings = await orgChartSettings(client);
      const rows = await loadChartRows(client, asOf);
      const holders = holdersAsOf(rows.assignments, asOf);

      /**
       * Who is away today, from the attendance module - if this tenant has it.
       *
       * §3 wants an `on_leave` status dot; §9 requires every integration to be
       * "optional and fail-soft". Attendance is a module (0140) a tenant may
       * not have switched on, and leave is only meaningful for TODAY - an
       * as-of chart of last March must not claim somebody is on leave now.
       *
       * So: only for the live view, and a failure is swallowed. A chart that
       * will not draw because the attendance tables are missing is a far worse
       * outcome than a chart with no leave dots.
       */
      const onLeave = asOf === today ? await this.resolveOnLeave(client, today) : new Set<string>();

      const nodes = rows.positions
        .filter((p) => !parsed.data.departmentId || p.departmentId === parsed.data.departmentId)
        .filter((p) => !parsed.data.teamId || p.teamId === parsed.data.teamId)
        .map((p) => {
          const held = holders.get(p.id);
          const primary = held?.primary ?? null;
          const status = derivePositionStatus(
            p.storedStatus,
            rows.assignments
              .filter((a) => a.positionId === p.id)
              .map((a) => ({
                assignmentType: a.assignmentType,
                startDate: a.startDate,
                endDate: a.endDate,
              })),
            asOf,
          );
          return {
            id: p.id,
            title: p.title,
            sortOrder: p.sortOrder,
            level: p.level,
            departmentId: p.departmentId,
            departmentName: p.departmentName,
            departmentColorTag: p.departmentColorTag,
            teamId: p.teamId,
            teamName: p.teamName,
            colorTag: p.colorTag,
            status,
            /** §3's one-line subtitle under the job title. */
            subtitle: p.teamName ?? p.departmentName,
            holder: primary
              ? {
                  userId: primary.userId,
                  name: primary.userName,
                  email: primary.userEmail,
                  startDate: primary.startDate,
                  tenureMonths: tenureMonths(primary.startDate, asOf),
                }
              : null,
            acting:
              held?.acting.map((a) => ({ userId: a.userId, name: a.userName })) ?? [],
            presence: deriveHolderPresence({
              hasHolder: !!primary,
              onLeave: primary ? onLeave.has(primary.userId) : false,
            }),
          };
        });

      const parents = parentMapAsOf(rows.lines, asOf);
      const children = childMapOf(nodes, parents);

      return {
        asOf,
        today,
        /** §5.2's banner: is the reader looking at the past or the future? */
        isHistorical: asOf < today,
        isFuture: asOf > today,
        settings,
        nodes,
        /**
         * The EDGES, as flat rows resolved for this date. Sent rather than
         * left to the browser so the directory and the PDF do not each have to
         * re-resolve them - and so a payload captured in a bug report contains
         * the tree the reader actually saw.
         */
        solidLines: [...parents.entries()]
          .filter(([positionId]) => nodes.some((n) => n.id === positionId))
          .map(([positionId, managerPositionId]) => ({ positionId, managerPositionId })),
        dottedLines: [...dottedLinesAsOf(rows.lines, asOf).entries()].flatMap(
          ([positionId, managers]) => managers.map((managerPositionId) => ({ positionId, managerPositionId })),
        ),
        roots: rootsOf(nodes, parents),
        collapsed: [
          ...defaultCollapsed(nodes, parents, children, {
            beyondLevel: settings.collapseBeyondLevel,
          }),
        ],
        /**
         * §10's "missing data" alerts, computed on read.
         *
         * Sent to every reader rather than only to owners: a chart with two
         * roots renders as two trees, and the person most likely to notice is
         * whoever is looking at it. The console shows it as a banner the owner
         * can act on and everybody else can at least understand.
         */
        problems: integrityProblems(nodes, rows.lines, asOf),
      };
    });
  }

  /**
   * §6.6's list/directory view: one row per seat, sortable and exportable.
   *
   * ── WHY THIS IS A SEPARATE ROUTE FROM THE CHART ────────────────────────────
   *
   * It is the same data, so the obvious call is to let the browser build the
   * table from the chart payload - and that is exactly what the console does
   * for the table it shows. This route exists for the half the chart payload
   * deliberately lacks: §6.6 lists `employment_type` as a column, and
   * `status` as a filter value that includes employment state.
   *
   * `employment_type` comes from `employment_contracts`, which this route may
   * not otherwise read - so it reads ONE column, and only for a caller who
   * holds `employment_contract:view`. Everybody else gets the same rows with
   * the column absent, which is `redactContract`'s rule applied to a list: an
   * absent key says "you may not see this", where a null would say "there is
   * nothing to see".
   */
  @Get("directory")
  @RequireCrmPermission("position", "view")
  async directory(@Req() req: PrincipalRequest, @OrgId() orgId: string, @Query() query: unknown) {
    const parsed = DirectoryQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const q = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const asOf = q.asOf ?? today;
      const maySeeEmployment = await this.mayReadContracts(client, orgId, req);

      const rows = await loadChartRows(client, asOf);
      const holders = holdersAsOf(rows.assignments, asOf);
      const parents = parentMapAsOf(rows.lines, asOf);
      const byId = new Map(rows.positions.map((p) => [p.id, p]));

      /**
       * The employment type per USER, read in one query rather than per row.
       *
       * Only when the caller may see it - the query is not issued at all
       * otherwise, which is the difference between a redaction and a filter.
       * A filtered response still put the value on a wire and in a log.
       */
      const employmentByUser = new Map<string, string>();
      if (maySeeEmployment && q.employmentType !== undefined) {
        // Narrowed server-side when it is also the filter, so the pagination
        // below counts what the reader will see.
      }
      if (maySeeEmployment) {
        const types = await client.query<{ user_id: string; employment_type: string }>(
          `SELECT user_id::text AS user_id, employment_type
             FROM employment_contracts
            WHERE status = 'active'`,
        );
        for (const row of types.rows) employmentByUser.set(row.user_id, row.employment_type);
      }

      const needle = q.q?.toLowerCase();
      const list = rows.positions
        .map((p) => {
          const held = holders.get(p.id);
          const primary = held?.primary ?? null;
          const managerId = parents.get(p.id) ?? null;
          const status = derivePositionStatus(
            p.storedStatus,
            rows.assignments
              .filter((a) => a.positionId === p.id)
              .map((a) => ({
                assignmentType: a.assignmentType,
                startDate: a.startDate,
                endDate: a.endDate,
              })),
            asOf,
          );
          const employmentType = primary ? employmentByUser.get(primary.userId) : undefined;
          return {
            positionId: p.id,
            title: p.title,
            departmentId: p.departmentId,
            department: p.departmentName,
            teamId: p.teamId,
            team: p.teamName,
            status,
            holderUserId: primary?.userId ?? null,
            holderName: primary?.userName ?? null,
            holderEmail: primary?.userEmail ?? null,
            startDate: primary?.startDate ?? null,
            tenureMonths: primary ? tenureMonths(primary.startDate, asOf) : null,
            managerPositionId: managerId,
            managerTitle: managerId ? (byId.get(managerId)?.title ?? null) : null,
            // Absent, not null, when the reader may not see it.
            ...(maySeeEmployment ? { employmentType: employmentType ?? null } : {}),
          };
        })
        .filter((row) => (q.departmentId ? row.departmentId === q.departmentId : true))
        .filter((row) => (q.teamId ? row.teamId === q.teamId : true))
        .filter((row) => (q.status ? row.status === q.status : true))
        .filter((row) =>
          q.employmentType && maySeeEmployment
            ? (row as { employmentType?: string | null }).employmentType === q.employmentType
            : true,
        )
        .filter((row) =>
          needle
            ? [row.title, row.holderName, row.department, row.team]
                .filter((v): v is string => !!v)
                .some((v) => v.toLowerCase().includes(needle))
            : true,
        )
        .sort((a, b) => a.title.localeCompare(b.title));

      return { asOf, total: list.length, rows: list, employmentVisible: maySeeEmployment };
    });
  }

  /**
   * §11's owner analytics.
   *
   * ── "NUMBERS RECONCILE WITH UNDERLYING ROWS" (M8's acceptance) ─────────────
   *
   * Every figure here is computed from the SAME `loadChartRows` the chart
   * draws from, through the same shared functions. That is the whole technique:
   * a second set of SQL aggregates would be a second definition of "vacant",
   * and the first time the chart said 42 and the analytics page said 43,
   * nobody would be able to say which was right.
   *
   * `timeToFill` is the one figure here that reads the change log rather than
   * the tree, because it is a question about the past: the gap between a seat
   * going vacant and being filled again exists nowhere else.
   */
  @Get("analytics")
  @RequireCrmPermission("position", "view")
  async analytics(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = ChartQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const asOf = parsed.data.asOf ?? today;
      const settings = await orgChartSettings(client);
      const rows = await loadChartRows(client, asOf);
      const holders = holdersAsOf(rows.assignments, asOf);
      const parents = parentMapAsOf(rows.positions.length ? rows.lines : [], asOf);
      const children = childMapOf(rows.positions, parents);
      const depths = depthMapOf(rows.positions, parents);

      const statusOf = (id: string) =>
        derivePositionStatus(
          rows.positions.find((p) => p.id === id)?.storedStatus ?? "filled",
          rows.assignments
            .filter((a) => a.positionId === id)
            .map((a) => ({
              assignmentType: a.assignmentType,
              startDate: a.startDate,
              endDate: a.endDate,
            })),
          asOf,
        );

      const byDepartment = new Map<string, { name: string; filled: number; vacant: number; frozen: number }>();
      for (const p of rows.positions) {
        const key = p.departmentId ?? "none";
        const held = byDepartment.get(key) ?? {
          name: p.departmentName ?? "No department",
          filled: 0,
          vacant: 0,
          frozen: 0,
        };
        held[statusOf(p.id)] += 1;
        byDepartment.set(key, held);
      }

      const vacancies = rows.positions.filter((p) => statusOf(p.id) === "vacant");
      const filled = rows.positions.filter((p) => statusOf(p.id) === "filled");

      /**
       * Tenure, from the LIVE primary assignment's start date.
       *
       * Not from the contract's `start_date`, which would be the more
       * intuitive source and is the wrong one: somebody promoted last month
       * has five years with the business and one month in the seat, and this
       * figure sits beside span of control and vacancy rate - all statements
       * about SEATS. The profile drawer shows the person's own joining date.
       */
      const tenures = filled
        .map((p) => {
          const primary = holders.get(p.id)?.primary;
          return primary ? tenureMonths(primary.startDate, asOf) : null;
        })
        .filter((m): m is number => m !== null)
        .sort((a, b) => a - b);

      const timeToFill = await client.query<{ avg_days: string | null; filled_count: string }>(
        /**
         * Average days from a seat falling vacant to being filled again.
         *
         * Reads `org_change_log`, pairing each `assign` with the `unassign`
         * that preceded it on the same position. `DISTINCT ON` takes the
         * nearest preceding one, so a seat filled, emptied and filled twice
         * contributes two gaps rather than one wrong one.
         *
         * Only closed gaps count. A seat vacant RIGHT NOW has no fill date,
         * and including today as its end would drag the average down every
         * morning - "average time to fill" would then improve while nothing
         * was filled.
         */
        `WITH assigns AS (
           SELECT entity_id, effective_date, after->>'positionId' AS position_id
             FROM org_change_log
            WHERE entity = 'assignment' AND action = 'assign' AND effective_date IS NOT NULL
         ),
         unassigns AS (
           SELECT effective_date, before->>'positionId' AS position_id
             FROM org_change_log
            WHERE entity = 'assignment' AND action = 'unassign' AND effective_date IS NOT NULL
         ),
         gaps AS (
           SELECT DISTINCT ON (a.entity_id)
                  a.effective_date - u.effective_date AS days
             FROM assigns a
             JOIN unassigns u
               ON u.position_id = a.position_id
              AND u.effective_date <= a.effective_date
            ORDER BY a.entity_id, u.effective_date DESC
         )
         SELECT avg(days)::numeric(10,1)::text AS avg_days, count(*)::text AS filled_count FROM gaps`,
      );

      return {
        asOf,
        settings,
        headcount: {
          positions: rows.positions.length,
          filled: filled.length,
          vacant: vacancies.length,
          frozen: rows.positions.filter((p) => statusOf(p.id) === "frozen").length,
          /**
           * PEOPLE, which is not the same as filled seats: one person can hold
           * a seat and act in another. A business counting staff from the
           * chart needs the distinct-people number, and reporting only
           * "filled" would overcount them.
           */
          people: new Set(
            [...holders.values()].flatMap((h) => [
              ...(h.primary ? [h.primary.userId] : []),
              ...h.acting.map((a) => a.userId),
            ]),
          ).size,
        },
        byDepartment: [...byDepartment.entries()].map(([id, v]) => ({
          departmentId: id === "none" ? null : id,
          ...v,
          total: v.filled + v.vacant + v.frozen,
        })),
        spanOfControl: {
          flags: spanOfControlFlags(children, {
            max: settings.spanOfControlMax,
            min: settings.spanOfControlMin,
          }),
          managers: [...children.entries()].map(([positionId, reports]) => ({
            positionId,
            title: rows.positions.find((p) => p.id === positionId)?.title ?? positionId,
            directReports: reports.length,
          })),
        },
        layers: rows.positions.length === 0 ? 0 : Math.max(...[...depths.values()]) + 1,
        vacancyRate: rows.positions.length === 0 ? 0 : vacancies.length / rows.positions.length,
        vacancies: vacancies.map((p) => ({
          positionId: p.id,
          title: p.title,
          department: p.departmentName,
          directReports: (children.get(p.id) ?? []).length,
        })),
        tenure: {
          /**
           * MEDIAN, not mean. One twenty-year founder in a team of six
           * new joiners makes a mean tenure that describes nobody.
           */
          medianMonths: tenures.length === 0 ? null : tenures[Math.floor(tenures.length / 2)],
          buckets: [
            { label: "Under 6 months", count: tenures.filter((m) => m < 6).length },
            { label: "6-12 months", count: tenures.filter((m) => m >= 6 && m < 12).length },
            { label: "1-3 years", count: tenures.filter((m) => m >= 12 && m < 36).length },
            { label: "Over 3 years", count: tenures.filter((m) => m >= 36).length },
          ],
        },
        timeToFill: {
          averageDays:
            timeToFill.rows[0]?.avg_days === null || timeToFill.rows[0]?.avg_days === undefined
              ? null
              : Number(timeToFill.rows[0].avg_days),
          sample: Number(timeToFill.rows[0]?.filled_count ?? 0),
        },
      };
    });
  }

  /** §6.5's timeline and §8's `GET /org/changes`. */
  @Get("changes")
  @RequireCrmPermission("position", "view")
  async changes(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = ChangesQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const q = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (clause: string, value: unknown) => {
        params.push(value);
        where.push(clause.replace("$?", `$${params.length}`));
      };
      if (q.entity) add("entity = $?", q.entity);
      if (q.entityId) add("entity_id = $?", q.entityId);
      if (q.action) add("action = $?", q.action);

      const limit = q.limit ?? 50;
      const offset = q.offset ?? 0;
      params.push(limit, offset);

      const { rows } = await client.query<{
        id: string;
        actor_type: string;
        actor_id: string;
        actor_name: string | null;
        entity: string;
        entity_id: string;
        action: string;
        before: unknown;
        after: unknown;
        reason: string | null;
        effective_date: string | null;
        at: string;
      }>(
        /**
         * The actor's NAME, resolved where there is one to resolve.
         *
         * `actor_id` is a `users.id` for a person, an EMAIL for a platform
         * operator and the literal "admin-key" for a script (see
         * `auditActor`). So the join is guarded by `actor_type = 'user'` and
         * the cast is inside that branch - casting an email to uuid is an
         * error, not a null, and it would take the whole history page down.
         */
        `SELECT l.id::text AS id, l.actor_type, l.actor_id,
                CASE WHEN l.actor_type = 'user' THEN u.name ELSE l.actor_id END AS actor_name,
                l.entity, l.entity_id, l.action, l.before, l.after, l.reason,
                l.effective_date::text AS effective_date, l.at::text AS at
           FROM org_change_log l
           LEFT JOIN users u
             ON l.actor_type = 'user'
            AND u.id = CASE WHEN l.actor_type = 'user' THEN l.actor_id::uuid ELSE NULL END
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY l.at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      return {
        changes: rows.map((r) => ({
          id: r.id,
          actorType: r.actor_type,
          actorId: r.actor_id,
          actorName: r.actor_name,
          entity: r.entity,
          entityId: r.entity_id,
          action: r.action,
          before: r.before,
          after: r.after,
          reason: r.reason,
          effectiveDate: r.effective_date,
          at: r.at,
        })),
        limit,
        offset,
      };
    });
  }

  /**
   * §5.2's PDF export.
   *
   * ── WHY THE PDF IS MADE HERE AND THE PNG IN THE BROWSER ───────────────────
   *
   * The PNG is the live SVG serialised onto a canvas, in the console: it is
   * pixel-for-pixel what the person is looking at, including whatever they had
   * collapsed, which is what "export the current view" means.
   *
   * The PDF is vector, with selectable text, printable at A3 - and `pdfkit` is
   * already a dependency here (the call-insights export uses it). Doing it in
   * the browser would mean a new client-side PDF library, and `pnpm --filter`
   * adding one to `apps/web` has orphaned `next` in a sibling package in this
   * repo before.
   *
   * The two agree because `layoutTree` is shared: the renderer below calls the
   * same function the canvas does, with the same node size. It is the reason
   * that function has no DOM dependency.
   */
  @Get("export.pdf")
  @RequireCrmPermission("position", "view")
  async exportPdf(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const parsed = ExportQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    const { buffer, filename } = await this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const asOf = parsed.data.asOf ?? today;
      const rows = await loadChartRows(client, asOf);
      const holders = holdersAsOf(rows.assignments, asOf);
      const orgName = await client.query<{ name: string }>(
        "SELECT name FROM organizations WHERE id = current_setting('app.org_id', true)::uuid",
      );
      return renderOrgChartPdf({
        orgName: orgName.rows[0]?.name ?? "Organization",
        asOf,
        isHistorical: asOf < today,
        orientation: parsed.data.orientation ?? "vertical",
        rootPositionId: parsed.data.rootPositionId ?? null,
        positions: rows.positions.map((p) => ({
          id: p.id,
          title: p.title,
          sortOrder: p.sortOrder,
          subtitle: p.teamName ?? p.departmentName,
          holderName: holders.get(p.id)?.primary?.userName ?? null,
          status: derivePositionStatus(
            p.storedStatus,
            rows.assignments
              .filter((a) => a.positionId === p.id)
              .map((a) => ({
                assignmentType: a.assignmentType,
                startDate: a.startDate,
                endDate: a.endDate,
              })),
            asOf,
          ),
        })),
        lines: rows.lines,
      });
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", String(buffer.length));
    res.end(buffer);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // §14's settings
  // ─────────────────────────────────────────────────────────────────────────

  @Get("settings")
  @RequireCrmPermission("position", "view")
  async readSettings(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, (client) => orgChartSettings(client));
  }

  @Put("settings")
  @RequireCrmPermission("position", "edit")
  async writeSettings(@Req() req: PrincipalRequest, @OrgId() orgId: string, @Body() body: unknown) {
    const parsed = OrgChartSettingsInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const before = await orgChartSettings(client);
      if (
        input.spanOfControlMin != null &&
        input.spanOfControlMax != null &&
        input.spanOfControlMin > input.spanOfControlMax
      ) {
        throw new BadRequestException("The smallest team cannot be larger than the largest.");
      }

      /**
       * `COALESCE($n, column)` per field, so an omitted key keeps what is
       * stored and an explicit `null` RESETS to the shared default.
       *
       * Those are two different intentions and both are reachable, which is
       * the whole reason `OrgChartSettingsInput` uses `.nullable().optional()`
       * rather than `.partial()` - a kept `.default()` would have made
       * "omitted" silently mean "reset".
       */
      await client.query(
        `INSERT INTO org_chart_settings
           (org_id, collapse_beyond_level, vacancy_alert_days, span_of_control_max,
            span_of_control_min, manager_edits_reports)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (org_id) DO UPDATE SET
           collapse_beyond_level = CASE WHEN $7 THEN EXCLUDED.collapse_beyond_level ELSE org_chart_settings.collapse_beyond_level END,
           vacancy_alert_days    = CASE WHEN $8 THEN EXCLUDED.vacancy_alert_days    ELSE org_chart_settings.vacancy_alert_days END,
           span_of_control_max   = CASE WHEN $9 THEN EXCLUDED.span_of_control_max   ELSE org_chart_settings.span_of_control_max END,
           span_of_control_min   = CASE WHEN $10 THEN EXCLUDED.span_of_control_min  ELSE org_chart_settings.span_of_control_min END,
           manager_edits_reports = CASE WHEN $11 THEN EXCLUDED.manager_edits_reports ELSE org_chart_settings.manager_edits_reports END`,
        [
          orgId,
          input.collapseBeyondLevel ?? null,
          input.vacancyAlertDays ?? null,
          input.spanOfControlMax ?? null,
          input.spanOfControlMin ?? null,
          input.managerEditsReports ?? null,
          "collapseBeyondLevel" in input,
          "vacancyAlertDays" in input,
          "spanOfControlMax" in input,
          "spanOfControlMin" in input,
          "managerEditsReports" in input,
        ],
      );

      const after = await orgChartSettings(client);
      await logOrgChange(client, orgId, actor, {
        entity: "position",
        entityId: orgId,
        action: "update",
        before,
        after,
        reason: "Organization chart settings changed.",
      });
      return after;
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Departments and teams
  // ─────────────────────────────────────────────────────────────────────────

  @Get("departments")
  @RequireCrmPermission("position", "view")
  async listDepartments(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const departments = await client.query<{
        id: string;
        name: string;
        color_tag: string | null;
        parent_department_id: string | null;
        positions: string;
      }>(
        `SELECT d.id::text AS id, d.name, d.color_tag,
                d.parent_department_id::text AS parent_department_id,
                count(p.id)::text AS positions
           FROM departments d
           LEFT JOIN positions p ON p.department_id = d.id
          GROUP BY d.id
          ORDER BY d.name`,
      );
      const teams = await client.query<{
        id: string;
        name: string;
        department_id: string | null;
        lead_position_id: string | null;
        positions: string;
      }>(
        `SELECT t.id::text AS id, t.name, t.department_id::text AS department_id,
                t.lead_position_id::text AS lead_position_id, count(p.id)::text AS positions
           FROM teams t
           LEFT JOIN positions p ON p.team_id = t.id
          GROUP BY t.id
          ORDER BY t.name`,
      );
      return {
        departments: departments.rows.map((d) => ({
          id: d.id,
          name: d.name,
          colorTag: d.color_tag,
          parentDepartmentId: d.parent_department_id,
          positions: Number(d.positions),
        })),
        teams: teams.rows.map((t) => ({
          id: t.id,
          name: t.name,
          departmentId: t.department_id,
          leadPositionId: t.lead_position_id,
          positions: Number(t.positions),
        })),
      };
    });
  }

  @Post("departments")
  @RequireCrmPermission("position", "create")
  async createDepartment(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Body() body: unknown,
  ) {
    const parsed = DepartmentInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      try {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO departments (org_id, name, color_tag, parent_department_id)
           VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
          [orgId, parsed.data.name, parsed.data.colorTag ?? null, parsed.data.parentDepartmentId ?? null],
        );
        await logOrgChange(client, orgId, actor, {
          entity: "department",
          entityId: rows[0].id,
          action: "create",
          after: { name: parsed.data.name },
        });
        return { id: rows[0].id };
      } catch (err) {
        // 23505: the case-insensitive unique index. "Sales" and "sales" are
        // one department, and the person creating the second will not be the
        // person who notices.
        if ((err as { code?: string }).code === "23505") {
          throw new ConflictException(`There is already a department called ${parsed.data.name}.`);
        }
        throw err;
      }
    });
  }

  @Patch("departments/:id")
  @RequireCrmPermission("position", "edit")
  async updateDepartment(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = DepartmentInput.partial().safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    if (Object.keys(parsed.data).length === 0) throw new BadRequestException("Nothing to change.");
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      if (parsed.data.parentDepartmentId === id) {
        throw new BadRequestException("A department cannot be inside itself.");
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      if (parsed.data.name !== undefined) set("name", parsed.data.name);
      if (parsed.data.colorTag !== undefined) set("color_tag", parsed.data.colorTag);
      if (parsed.data.parentDepartmentId !== undefined) {
        set("parent_department_id", parsed.data.parentDepartmentId);
      }
      params.push(id);
      const { rowCount } = await client.query(
        `UPDATE departments SET ${sets.join(", ")} WHERE id = $${params.length}`,
        params,
      );
      if (!rowCount) throw new NotFoundException("That department does not exist.");
      await logOrgChange(client, orgId, actor, {
        entity: "department",
        entityId: id,
        action: "update",
        after: parsed.data,
      });
      return { ok: true };
    });
  }

  /**
   * Deleting a department does NOT delete its positions.
   *
   * 0177's FK is `ON DELETE SET NULL`, so the seats survive with no department
   * - which is the only safe default. A CASCADE here would mean deleting
   * "Commercial" removed forty seats, their reporting lines and their
   * assignment history on one click.
   */
  @Delete("departments/:id")
  @RequireCrmPermission("position", "delete")
  async deleteDepartment(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const actor = auditActor(req);
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{ name: string }>(
        "DELETE FROM departments WHERE id = $1 RETURNING name",
        [id],
      );
      if (!rows[0]) throw new NotFoundException("That department does not exist.");
      await logOrgChange(client, orgId, actor, {
        entity: "department",
        entityId: id,
        action: "delete",
        before: { name: rows[0].name },
      });
      return { ok: true };
    });
  }

  @Post("teams")
  @RequireCrmPermission("position", "create")
  async createTeam(@Req() req: PrincipalRequest, @OrgId() orgId: string, @Body() body: unknown) {
    const parsed = TeamInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      try {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO teams (org_id, name, department_id, lead_position_id)
           VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
          [orgId, parsed.data.name, parsed.data.departmentId ?? null, parsed.data.leadPositionId ?? null],
        );
        await logOrgChange(client, orgId, actor, {
          entity: "team",
          entityId: rows[0].id,
          action: "create",
          after: { name: parsed.data.name },
        });
        return { id: rows[0].id };
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new ConflictException(`There is already a team called ${parsed.data.name}.`);
        }
        throw err;
      }
    });
  }

  @Patch("teams/:id")
  @RequireCrmPermission("position", "edit")
  async updateTeam(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = TeamInput.partial().safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    if (Object.keys(parsed.data).length === 0) throw new BadRequestException("Nothing to change.");
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      if (parsed.data.name !== undefined) set("name", parsed.data.name);
      if (parsed.data.departmentId !== undefined) set("department_id", parsed.data.departmentId);
      if (parsed.data.leadPositionId !== undefined) set("lead_position_id", parsed.data.leadPositionId);
      params.push(id);
      const { rowCount } = await client.query(
        `UPDATE teams SET ${sets.join(", ")} WHERE id = $${params.length}`,
        params,
      );
      if (!rowCount) throw new NotFoundException("That team does not exist.");
      await logOrgChange(client, orgId, actor, {
        entity: "team",
        entityId: id,
        action: "update",
        after: parsed.data,
      });
      return { ok: true };
    });
  }

  @Delete("teams/:id")
  @RequireCrmPermission("position", "delete")
  async deleteTeam(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const actor = auditActor(req);
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{ name: string }>(
        "DELETE FROM teams WHERE id = $1 RETURNING name",
        [id],
      );
      if (!rows[0]) throw new NotFoundException("That team does not exist.");
      await logOrgChange(client, orgId, actor, {
        entity: "team",
        entityId: id,
        action: "delete",
        before: { name: rows[0].name },
      });
      return { ok: true };
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * May this caller read employment data?
   *
   * Asks the SAME grid the contracts controller's guard asks, through
   * `hasCrmGrant` - rather than inferring it from the persona, which would be
   * a second authorization model for the same question and would disagree with
   * the first the moment an owner changed a grid cell.
   */
  private async mayReadContracts(
    client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    orgId: string,
    req: PrincipalRequest,
  ): Promise<boolean> {
    const userId = req.principal?.userId;
    /**
     * No `users` row means no grant to look up, so the column stays hidden.
     *
     * That covers the bare admin key and the operator console, and hiding
     * `employment_type` from an operator is the right default: 0122 made call
     * CONTENT need a client's explicit approval, and a staff member's contract
     * terms are at least as personal. An operator who needs it has the
     * tenant's own console.
     */
    if (!userId) return false;
    return hasCrmGrant(client, orgId, userId, "employment_contract", "view");
  }

  /**
   * Who is on leave today, if this tenant has the attendance module.
   *
   * §9's fail-soft rule, applied literally: a missing table (42P01) or any
   * other failure returns an empty set, and the chart draws without leave
   * dots. The alternative - a chart that will not render because a module the
   * tenant never bought is absent - is the outcome §9 exists to forbid.
   */
  private async resolveOnLeave(
    client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: { user_id: string }[] }> },
    today: string,
  ): Promise<Set<string>> {
    try {
      const { rows } = await client.query(
        `SELECT DISTINCT t.user_id::text AS user_id
           FROM attendance_days d
           JOIN telecallers t ON t.id = d.telecaller_id
          WHERE d.work_date = $1::date
            AND d.status IN ('on_leave', 'holiday', 'absent')
            AND t.user_id IS NOT NULL`,
        [today],
      );
      return new Set(rows.map((r) => r.user_id));
    } catch {
      return new Set<string>();
    }
  }
}
