import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  AssignInput,
  AuthorityInput,
  CreatePositionInput,
  DottedLineInput,
  IsoDate,
  MovePositionInput,
  ResponsibilitiesInput,
  SkillsInput,
  UnassignInput,
  UpdatePositionInput,
  coversDate,
  derivePositionStatus,
  deriveHolderPresence,
  tenureMonths,
} from "@aura/shared";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { notify } from "../notifications/notify";
import {
  assertDeletable,
  closeOpenSolidLine,
  logOrgChange,
  managerOf,
  mayEditAsManager,
  orgChartSettings,
  orgToday,
  requireMember,
  requirePosition,
  rootPositionIds,
  wouldCycleInDb,
} from "./tree";

/**
 * Positions: the seats, who holds them, and what each one is for
 * (Build docs/org-chart-build-plan.md §8, milestones M3-M5).
 *
 * ── THE ROUTES, AND THE TWO THAT ARE NOT HERE ──────────────────────────────
 *
 * Read one profile; create, edit and delete a seat; move it; assign and
 * unassign a holder; replace the responsibilities, the authority table, the
 * required skills and the default KPI targets; add and end a dotted line.
 *
 * There is no `PATCH` that re-parents. §8 gives moving its own endpoint and
 * §4.3 is why: a move needs an effective date, a reason, a cycle check and a
 * subtree walk, and none of that can happen in a field assignment. A PATCH
 * that accepted `managerPositionId` would be a reorganization with no history,
 * which is the one thing §16 will not accept. `UpdatePositionInput` omits the
 * field for this reason and a test pins it.
 *
 * There is no route that sets `status` to `vacant`. A seat is emptied by
 * ending its assignment; letting a PATCH assert it would leave a live
 * assignment pointing at a seat the chart says nobody holds. Same shape as
 * `ResourceManualStatus` in the resources controller.
 *
 * ── WHO MAY DO WHAT (seeded by 0177) ───────────────────────────────────────
 *
 * `position:view` to every system role including `viewer` - §7 gives staff the
 * chart, the titles, the responsibilities and the authority table, and that is
 * the module's reason to exist. `create`/`edit`/`delete` to the three admin
 * roles only (§14: "owner/admin only").
 *
 * Scope is always `all`: `position` is in `ALL_SCOPE_ONLY_OBJECTS` and its
 * owner column is null, so no statement in this file emits an `owned` clause
 * and none should be added. §7's manager-sees-their-branch is a SUBTREE, which
 * the grid cannot express - the one place it bites is editing a direct
 * report's responsibilities, which `mayEditAsManager` answers against the
 * reporting tree and §14's org setting.
 */

const AsOfQuery = z.object({ asOf: IsoDate.optional() });

/** §9's KPI seam. `metric` is validated against the same open set `sales_targets` uses. */
const KpiDefaultsInput = z.object({
  items: z
    .array(
      z.object({
        metric: z.string().trim().regex(/^[a-z][a-z0-9_]*$/, "Use a metric key like won_value."),
        targetValue: z.number().positive(),
      }),
    )
    .max(50),
});

/** §4.3's named alternative to blocking a delete outright. */
const DeleteQuery = z.object({
  promoteReports: z.enum(["1", "true"]).optional(),
  reason: z.string().trim().max(500).optional(),
});

@Controller("org-chart/positions")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class OrgChartPositionsController {
  constructor(private readonly db: DbService) {}

  /**
   * §6's profile payload: one seat, everything about it, permission-filtered.
   *
   * ── WHY THE CONTRACT TAB IS NOT IN THIS RESPONSE ───────────────────────────
   *
   * §6.3 is a tab on the same drawer, so the obvious shape is one payload with
   * a redacted contract inside it. It is a SEPARATE request to
   * `/org-chart/contracts?userId=`, guarded by `employment_contract:view`,
   * because folding it in would mean this route - which every persona may
   * call - decides whether to include somebody's salary. That decision would
   * then live in a branch in the middle of a read that is otherwise
   * unrestricted, and the failure mode of getting it wrong is a telecaller
   * receiving a payload with pay in it.
   *
   * Two routes, two grants, and the restricted one 403s before its handler
   * runs. §7's MUST is "enforce permissions server-side on every endpoint";
   * the cleanest way to honour it is for the unrestricted endpoint to have
   * nothing restricted to leak.
   */
  @Get(":id")
  @RequireCrmPermission("position", "view")
  async one(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ) {
    const parsed = AsOfQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const asOf = parsed.data.asOf ?? today;

      const position = await client.query<{
        id: string;
        title: string;
        purpose: string | null;
        level: number | null;
        status: string;
        sort_order: number;
        color_tag: string | null;
        effective_from: string;
        effective_to: string | null;
        department_id: string | null;
        department_name: string | null;
        team_id: string | null;
        team_name: string | null;
      }>(
        `SELECT p.id::text AS id, p.title, p.purpose, p.level, p.status, p.sort_order, p.color_tag,
                p.effective_from::text AS effective_from, p.effective_to::text AS effective_to,
                p.department_id::text AS department_id, d.name AS department_name,
                p.team_id::text AS team_id, t.name AS team_name
           FROM positions p
           LEFT JOIN departments d ON d.id = p.department_id
           LEFT JOIN teams t       ON t.id = p.team_id
          WHERE p.id = $1`,
        [id],
      );
      if (!position.rows[0]) throw new NotFoundException("That position does not exist.");
      const row = position.rows[0];

      const [responsibilities, authority, skills, kpiDefaults, assignments] = await Promise.all([
        client.query<{ id: string; text: string; category: string | null; sort_order: number }>(
          `SELECT id::text AS id, text, category, sort_order
             FROM position_responsibilities WHERE position_id = $1 ORDER BY sort_order, id`,
          [id],
        ),
        client.query<{
          id: string;
          action: string;
          limit_num: string | null;
          limit_percent: string | null;
          currency: string | null;
          requires_approval_from_position_id: string | null;
          approver_title: string | null;
        }>(
          `SELECT a.id::text AS id, a.action, a.limit_num::text AS limit_num,
                  a.limit_percent::text AS limit_percent, a.currency,
                  a.requires_approval_from_position_id::text AS requires_approval_from_position_id,
                  ap.title AS approver_title
             FROM position_authorities a
             LEFT JOIN positions ap ON ap.id = a.requires_approval_from_position_id
            WHERE a.position_id = $1
            ORDER BY a.action`,
          [id],
        ),
        client.query<{ id: string; skill: string; required: boolean }>(
          `SELECT id::text AS id, skill, required
             FROM position_skills WHERE position_id = $1 ORDER BY required DESC, lower(skill)`,
          [id],
        ),
        client.query<{ metric: string; target_value: string }>(
          `SELECT metric, target_value::text AS target_value
             FROM position_kpi_defaults WHERE position_id = $1 ORDER BY metric`,
          [id],
        ),
        client.query<{
          id: string;
          user_id: string;
          user_name: string | null;
          user_email: string;
          assignment_type: "primary" | "acting";
          start_date: string;
          end_date: string | null;
          reason: string | null;
        }>(
          `SELECT a.id::text AS id, a.user_id::text AS user_id, u.name AS user_name, u.email AS user_email,
                  a.assignment_type, a.start_date::text AS start_date, a.end_date::text AS end_date,
                  a.reason
             FROM position_assignments a
             JOIN users u ON u.id = a.user_id
            WHERE a.position_id = $1
            ORDER BY a.start_date DESC, a.id`,
          [id],
        ),
      ]);

      const live = assignments.rows.filter((a) => coversDate(asOf, a.start_date, a.end_date));
      const primary = live.find((a) => a.assignment_type === "primary") ?? null;
      const acting = live.filter((a) => a.assignment_type === "acting");

      /**
       * §6.1's "on probation" dot, and §6.4's gate.
       *
       * The probation DATE comes from `employment_contracts`, which this route
       * may not read the rest of - so it reads exactly one boolean out of it
       * and nothing else. That is not a redaction loophole: "is this person on
       * probation" is already visible on the chart as a status dot for every
       * persona by §3's own design, and knowing it reveals nothing about pay.
       */
      const probation = primary
        ? await client.query<{ on_probation: boolean }>(
            `SELECT (probation_end_date IS NOT NULL AND probation_end_date >= $2::date) AS on_probation
               FROM employment_contracts
              WHERE user_id = $1 AND status = 'active'
              LIMIT 1`,
            [primary.user_id, asOf],
          )
        : { rows: [] as { on_probation: boolean }[] };

      // Reports-to and direct reports, both clickable in §6.1.
      const managerPositionId = await managerOf(client, id, asOf);
      const manager = managerPositionId
        ? await client.query<{ id: string; title: string; holder: string | null }>(
            `SELECT p.id::text AS id, p.title, u.name AS holder
               FROM positions p
               LEFT JOIN position_assignments a
                 ON a.position_id = p.id AND a.assignment_type = 'primary'
                AND a.start_date <= $2::date AND (a.end_date IS NULL OR a.end_date >= $2::date)
               LEFT JOIN users u ON u.id = a.user_id
              WHERE p.id = $1`,
            [managerPositionId, asOf],
          )
        : { rows: [] as { id: string; title: string; holder: string | null }[] };

      const reports = await client.query<{ id: string; title: string; holder: string | null }>(
        `SELECT p.id::text AS id, p.title, u.name AS holder
           FROM reporting_lines rl
           JOIN positions p ON p.id = rl.position_id
           LEFT JOIN position_assignments a
             ON a.position_id = p.id AND a.assignment_type = 'primary'
            AND a.start_date <= $2::date AND (a.end_date IS NULL OR a.end_date >= $2::date)
           LEFT JOIN users u ON u.id = a.user_id
          WHERE rl.manager_position_id = $1
            AND rl.type = 'solid'
            AND rl.effective_from <= $2::date
            AND (rl.effective_to IS NULL OR rl.effective_to >= $2::date)
          ORDER BY p.sort_order, p.title`,
        [id, asOf],
      );

      const dotted = await client.query<{ id: string; title: string; direction: string }>(
        `SELECT p.id::text AS id, p.title, 'to' AS direction
           FROM reporting_lines rl JOIN positions p ON p.id = rl.manager_position_id
          WHERE rl.position_id = $1 AND rl.type = 'dotted'
            AND rl.effective_from <= $2::date
            AND (rl.effective_to IS NULL OR rl.effective_to >= $2::date)
         UNION ALL
         SELECT p.id::text AS id, p.title, 'from' AS direction
           FROM reporting_lines rl JOIN positions p ON p.id = rl.position_id
          WHERE rl.manager_position_id = $1 AND rl.type = 'dotted'
            AND rl.effective_from <= $2::date
            AND (rl.effective_to IS NULL OR rl.effective_to >= $2::date)`,
        [id, asOf],
      );

      const status = derivePositionStatus(
        row.status as "filled" | "vacant" | "frozen",
        assignments.rows.map((a) => ({
          assignmentType: a.assignment_type,
          startDate: a.start_date,
          endDate: a.end_date,
        })),
        asOf,
      );

      return {
        asOf,
        position: {
          id: row.id,
          title: row.title,
          purpose: row.purpose,
          level: row.level,
          status,
          storedStatus: row.status,
          sortOrder: row.sort_order,
          colorTag: row.color_tag,
          effectiveFrom: row.effective_from,
          effectiveTo: row.effective_to,
          departmentId: row.department_id,
          departmentName: row.department_name,
          teamId: row.team_id,
          teamName: row.team_name,
        },
        holder: primary
          ? {
              assignmentId: primary.id,
              userId: primary.user_id,
              name: primary.user_name,
              email: primary.user_email,
              startDate: primary.start_date,
              tenureMonths: tenureMonths(primary.start_date, asOf),
              presence: deriveHolderPresence({
                hasHolder: true,
                onProbation: probation.rows[0]?.on_probation ?? false,
              }),
            }
          : null,
        acting: acting.map((a) => ({
          assignmentId: a.id,
          userId: a.user_id,
          name: a.user_name,
          email: a.user_email,
          startDate: a.start_date,
          endDate: a.end_date,
        })),
        reportsTo: manager.rows[0] ?? null,
        directReports: reports.rows,
        dottedLines: dotted.rows,
        responsibilities: responsibilities.rows.map((r) => ({
          id: r.id,
          text: r.text,
          category: r.category,
          sortOrder: r.sort_order,
        })),
        /**
         * `limit_num` arrives as TEXT and is converted here.
         *
         * `numeric` comes back from `pg` as a string, which is correct - a
         * numeric wider than a double cannot round-trip through a JS number.
         * An authority limit is a few figures, so `Number` is safe, and
         * `authorityVerdict` compares numbers. `money.ts` is where arithmetic
         * on money belongs; this is a comparison, not arithmetic.
         */
        authority: authority.rows.map((a) => ({
          id: a.id,
          action: a.action,
          limitNum: a.limit_num === null ? null : Number(a.limit_num),
          limitPercent: a.limit_percent === null ? null : Number(a.limit_percent),
          currency: a.currency,
          requiresApprovalFromPositionId: a.requires_approval_from_position_id,
          approverTitle: a.approver_title,
        })),
        skills: skills.rows,
        kpiDefaults: kpiDefaults.rows.map((k) => ({
          metric: k.metric,
          targetValue: Number(k.target_value),
        })),
        /** §6.5's timeline is a separate page of `GET /org-chart/changes`. */
        assignmentHistory: assignments.rows.map((a) => ({
          id: a.id,
          userId: a.user_id,
          name: a.user_name,
          assignmentType: a.assignment_type,
          startDate: a.start_date,
          endDate: a.end_date,
          reason: a.reason,
        })),
      };
    });
  }

  @Post()
  @RequireCrmPermission("position", "create")
  async create(@Req() req: PrincipalRequest, @OrgId() orgId: string, @Body() body: unknown) {
    const parsed = CreatePositionInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const effectiveFrom = input.effectiveFrom ?? today;

      /**
       * §4.3: one root. A create with no manager is refused once a root
       * exists, and §5.3's first-run state is the only legitimate way to make
       * one - "Create your first position (the owner/root)".
       *
       * Checked against the EFFECTIVE DATE rather than today, because a seat
       * created to start next month must be judged against the tree as it will
       * be then. A root abolished on 30 June means a create effective 1 July
       * is a legitimate new root.
       */
      if (!input.managerPositionId) {
        const roots = await rootPositionIds(client, effectiveFrom);
        if (roots.length > 0) {
          throw new ConflictException(
            "This chart already has a top position. Choose the manager this new position reports to.",
          );
        }
      } else {
        await requirePosition(client, input.managerPositionId);
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO positions
           (org_id, title, department_id, team_id, level, purpose, sort_order, color_tag, effective_from)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 0), $8, $9::date)
         RETURNING id::text AS id`,
        [
          orgId,
          input.title,
          input.departmentId ?? null,
          input.teamId ?? null,
          input.level ?? null,
          input.purpose ?? null,
          input.sortOrder ?? null,
          input.colorTag ?? null,
          effectiveFrom,
        ],
      );
      const id = inserted.rows[0].id;

      if (input.managerPositionId) {
        await client.query(
          `INSERT INTO reporting_lines (org_id, position_id, manager_position_id, type, effective_from)
           VALUES ($1, $2, $3, 'solid', $4::date)`,
          [orgId, id, input.managerPositionId, effectiveFrom],
        );
      }

      await logOrgChange(client, orgId, actor, {
        entity: "position",
        entityId: id,
        action: "create",
        after: { title: input.title, managerPositionId: input.managerPositionId ?? null },
        effectiveDate: effectiveFrom,
      });

      return { id, effectiveFrom };
    });
  }

  @Patch(":id")
  @RequireCrmPermission("position", "edit")
  async update(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = UpdatePositionInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const before = await client.query<Record<string, unknown>>(
        `SELECT title, purpose, level, status, sort_order, color_tag,
                department_id::text AS department_id, team_id::text AS team_id
           FROM positions WHERE id = $1`,
        [id],
      );
      if (!before.rows[0]) throw new NotFoundException("That position does not exist.");

      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      if (input.title !== undefined) set("title", input.title);
      if (input.purpose !== undefined) set("purpose", input.purpose);
      if (input.level !== undefined) set("level", input.level);
      if (input.sortOrder !== undefined) set("sort_order", input.sortOrder);
      if (input.colorTag !== undefined) set("color_tag", input.colorTag);
      if (input.status !== undefined) set("status", input.status);
      if (input.departmentId !== undefined) set("department_id", input.departmentId);
      if (input.teamId !== undefined) set("team_id", input.teamId);

      params.push(id);
      await client.query(
        `UPDATE positions SET ${sets.join(", ")} WHERE id = $${params.length}`,
        params,
      );

      await logOrgChange(client, orgId, actor, {
        entity: "position",
        entityId: id,
        action: "update",
        before: before.rows[0],
        after: input,
      });
      return { ok: true };
    });
  }

  /**
   * §4.3: a delete is REFUSED while the seat still has reports.
   *
   * `?promoteReports=1` is §4.3's named alternative, and it is an opt-in
   * rather than the default because silently re-parenting six people onto
   * somebody's grandparent changes who they report to - and whoever is
   * deleting a duplicate seat has no idea they just did that.
   *
   * ── DELETE, AND WHEN NOT TO USE IT ─────────────────────────────────────────
   *
   * This is for a seat created in error. A seat that really existed and was
   * ABOLISHED gets `effective_to` instead (a PATCH), which keeps it on every
   * as-of view before that date - §16 requires the historical chart to be
   * reproducible, and a deleted row is not. The console offers "close this
   * position" first and puts delete behind it.
   */
  @Delete(":id")
  @RequireCrmPermission("position", "delete")
  async remove(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ) {
    const parsed = DeleteQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const promote = parsed.data.promoteReports === "1" || parsed.data.promoteReports === "true";
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const position = await requirePosition(client, id);
      const reports = await assertDeletable(client, id, today);

      if (reports.length > 0 && !promote) {
        throw new ConflictException(
          `${position.title} still has ${reports.length} position(s) reporting to it. Move them first, or delete with "promote reports to parent".`,
        );
      }

      if (reports.length > 0) {
        const parent = await managerOf(client, id, today);
        if (!parent) {
          // Promoting the reports of a ROOT would leave several roots behind,
          // which §4.3 forbids and `rootsOf` would then report as broken data.
          throw new ConflictException(
            "This is the top position. Move its reports under a new top position before deleting it.",
          );
        }
        for (const reportId of reports) {
          await closeOpenSolidLine(client, reportId, today);
          await client.query(
            `INSERT INTO reporting_lines (org_id, position_id, manager_position_id, type, effective_from)
             VALUES ($1, $2, $3, 'solid', $4::date)`,
            [orgId, reportId, parent, today],
          );
          await logOrgChange(client, orgId, actor, {
            entity: "reporting_line",
            entityId: reportId,
            action: "move",
            before: { managerPositionId: id },
            after: { managerPositionId: parent },
            reason: parsed.data.reason ?? `Promoted when ${position.title} was deleted.`,
            effectiveDate: today,
          });
        }
      }

      // The line by which THIS seat reported cascades (0177's FK). The lines
      // by which others reported to it are gone by now, either because there
      // were none or because they were just re-pointed above.
      await client.query("DELETE FROM positions WHERE id = $1", [id]);

      await logOrgChange(client, orgId, actor, {
        entity: "position",
        entityId: id,
        action: "delete",
        before: { title: position.title },
        reason: parsed.data.reason ?? null,
        effectiveDate: today,
      });
      return { ok: true, promoted: reports.length };
    });
  }

  /**
   * §5.2's drag-and-drop, and §8's `POST /:id/move`.
   *
   * Four things happen in ONE transaction, which §12 requires ("a move either
   * fully applies or not at all"): the cycle is refused, the old solid line is
   * closed the day before the effective date, the new one is inserted, and
   * both logs are written. The subtree is NOT touched - §4.3: "Moves of a
   * branch move the whole subtree; the subtree's own lines stay unchanged",
   * which falls out of the tree being made of edges rather than paths.
   */
  @Post(":id/move")
  @RequireCrmPermission("position", "edit")
  async move(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = MovePositionInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const position = await requirePosition(client, id);
      const currentManager = await managerOf(client, id, input.effectiveDate);

      if (input.newManagerPositionId === null) {
        // Promoting a seat to root is only legal if it already is one -
        // otherwise the chart gains a second root, which §4.3 forbids.
        const roots = await rootPositionIds(client, input.effectiveDate);
        if (!roots.includes(id)) {
          throw new ConflictException(
            "A chart has one top position. Move the current top position first, or choose a manager for this one.",
          );
        }
        return { ok: true, unchanged: true };
      }

      if (input.newManagerPositionId === currentManager) {
        // Not an error, and deliberately not a no-op write either: writing a
        // new line here would close and reopen an identical line, putting a
        // meaningless "moved" entry in §6.5's timeline on every accidental
        // drop-back.
        return { ok: true, unchanged: true };
      }

      const target = await requirePosition(client, input.newManagerPositionId);

      if (await wouldCycleInDb(client, id, input.newManagerPositionId, input.effectiveDate)) {
        throw new ConflictException(
          `${target.title} reports to ${position.title}, so ${position.title} cannot report to it. Move ${target.title} out first.`,
        );
      }

      await closeOpenSolidLine(client, id, input.effectiveDate);
      await client.query(
        `INSERT INTO reporting_lines (org_id, position_id, manager_position_id, type, effective_from)
         VALUES ($1, $2, $3, 'solid', $4::date)`,
        [orgId, id, input.newManagerPositionId, input.effectiveDate],
      );

      await logOrgChange(client, orgId, actor, {
        entity: "reporting_line",
        entityId: id,
        action: "move",
        before: { managerPositionId: currentManager },
        after: { managerPositionId: input.newManagerPositionId },
        reason: input.reason ?? null,
        effectiveDate: input.effectiveDate,
      });

      await this.announceReportingChange(client, orgId, actor, {
        positionId: id,
        positionTitle: position.title,
        newManagerPositionId: input.newManagerPositionId,
        effectiveDate: input.effectiveDate,
      });

      return { ok: true, effectiveDate: input.effectiveDate };
    });
  }

  /** §5.2's dotted-line reporting: secondary, unlimited, effective-dated. */
  @Post(":id/dotted-lines")
  @RequireCrmPermission("position", "edit")
  async addDottedLine(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = DottedLineInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const effectiveFrom = parsed.data.effectiveFrom ?? today;
      if (parsed.data.managerPositionId === id) {
        throw new BadRequestException("A position cannot also report to itself.");
      }
      await requirePosition(client, id);
      await requirePosition(client, parsed.data.managerPositionId);

      const existing = await client.query(
        `SELECT 1 FROM reporting_lines
          WHERE position_id = $1 AND manager_position_id = $2 AND type = 'dotted'
            AND effective_to IS NULL`,
        [id, parsed.data.managerPositionId],
      );
      if (existing.rowCount && existing.rowCount > 0) {
        throw new ConflictException("That dotted line already exists.");
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO reporting_lines (org_id, position_id, manager_position_id, type, effective_from)
         VALUES ($1, $2, $3, 'dotted', $4::date)
         RETURNING id::text AS id`,
        [orgId, id, parsed.data.managerPositionId, effectiveFrom],
      );

      await logOrgChange(client, orgId, actor, {
        entity: "reporting_line",
        entityId: id,
        action: "create",
        after: { managerPositionId: parsed.data.managerPositionId, type: "dotted" },
        reason: parsed.data.reason ?? null,
        effectiveDate: effectiveFrom,
      });
      return { id: inserted.rows[0].id };
    });
  }

  /** Ends a dotted line rather than deleting it - §4.3: never overwrite history. */
  @Delete(":id/dotted-lines/:managerId")
  @RequireCrmPermission("position", "edit")
  async endDottedLine(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("managerId", ParseUUIDPipe) managerId: string,
  ) {
    const actor = auditActor(req);
    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const { rowCount } = await client.query(
        `UPDATE reporting_lines
            SET effective_to = $3::date
          WHERE position_id = $1 AND manager_position_id = $2
            AND type = 'dotted' AND effective_to IS NULL`,
        [id, managerId, today],
      );
      if (!rowCount) throw new NotFoundException("That dotted line is not there.");
      await logOrgChange(client, orgId, actor, {
        entity: "reporting_line",
        entityId: id,
        action: "delete",
        before: { managerPositionId: managerId, type: "dotted" },
        effectiveDate: today,
      });
      return { ok: true };
    });
  }

  /**
   * §8's `POST /:id/assign` - put somebody in the seat.
   *
   * ── WHAT "REPLACE" MEANS HERE ──────────────────────────────────────────────
   *
   * §8 says "assign or replace holder". A replacement ENDS the outgoing
   * primary assignment the day before the new one starts and inserts a new
   * row; it never updates the old row's `user_id`. §4.3: never overwrite
   * history - and an updated row would make the chart claim the new person
   * held the seat for the departed person's whole tenure.
   *
   * The unique index `position_assignments_one_open_primary` is the backstop,
   * and the ORDER below is what keeps the insert from colliding with it.
   */
  @Post(":id/assign")
  @RequireCrmPermission("position", "edit")
  async assign(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = AssignInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const startDate = input.startDate ?? today;
      const type = input.assignmentType ?? "primary";
      const position = await requirePosition(client, id);
      const person = await requireMember(client, input.userId);

      /**
       * A FROZEN seat may not be filled. §10 lists "active assignment on a
       * frozen position" as a data fault to alert on, and the cheapest place
       * to prevent it is the route that would create it.
       */
      const frozen = await client.query<{ frozen: boolean }>(
        "SELECT status = 'frozen' AS frozen FROM positions WHERE id = $1",
        [id],
      );
      if (frozen.rows[0]?.frozen) {
        throw new ConflictException(
          `${position.title} is frozen. Unfreeze it before assigning somebody to it.`,
        );
      }

      let replaced: { id: string; userId: string } | null = null;
      if (type === "primary") {
        const outgoing = await client.query<{ id: string; user_id: string }>(
          `UPDATE position_assignments
              SET end_date = ($2::date - 1)
            WHERE position_id = $1 AND assignment_type = 'primary' AND end_date IS NULL
            RETURNING id::text AS id, user_id::text AS user_id`,
          [id, startDate],
        );
        if (outgoing.rows[0]) {
          replaced = { id: outgoing.rows[0].id, userId: outgoing.rows[0].user_id };
        }
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO position_assignments
           (org_id, position_id, user_id, assignment_type, start_date, end_date, reason)
         VALUES ($1, $2, $3, $4, $5::date, $6::date, $7)
         RETURNING id::text AS id`,
        [orgId, id, input.userId, type, startDate, input.endDate ?? null, input.reason ?? null],
      );

      // The seat is held again, so the stored hint catches up. `derivePosition
      // Status` does not trust it, but a `vacant` left behind would make the
      // vacancy sweep's own cheap pre-filter miss.
      await client.query("UPDATE positions SET status = 'filled' WHERE id = $1 AND status <> 'frozen'", [id]);

      const seeded = await this.seedKpiTargets(client, orgId, id, input.userId, startDate);

      await logOrgChange(client, orgId, actor, {
        entity: "assignment",
        entityId: inserted.rows[0].id,
        action: "assign",
        before: replaced ? { userId: replaced.userId } : undefined,
        after: { userId: input.userId, assignmentType: type, positionId: id },
        reason: input.reason ?? null,
        effectiveDate: startDate,
      });

      await notify(
        client,
        orgId,
        {
          userId: input.userId,
          kind: "reporting_change",
          title: `You have been assigned to ${position.title}`,
          body:
            type === "acting"
              ? `Acting from ${startDate}. Open the organization chart to see what the role covers.`
              : `From ${startDate}. Open the organization chart to see what the role covers.`,
          linkPath: `/owner/org-chart?position=${id}`,
          dedupeKey: `org_chart_assign:${inserted.rows[0].id}`,
        },
        actor.type === "user" ? actor.id : null,
      );

      return {
        id: inserted.rows[0].id,
        holder: { userId: person.id, name: person.name, email: person.email },
        replacedAssignmentId: replaced?.id ?? null,
        kpiTargetsSeeded: seeded,
      };
    });
  }

  /** §8's `POST /:id/unassign` - end the assignment, making the seat vacant. */
  @Post(":id/unassign")
  @RequireCrmPermission("position", "edit")
  async unassign(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = UnassignInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const endDate = parsed.data.endDate ?? today;
      const type = parsed.data.assignmentType ?? "primary";
      const position = await requirePosition(client, id);

      const ended = await client.query<{ id: string; user_id: string }>(
        `UPDATE position_assignments
            SET end_date = $3::date, reason = COALESCE($4, reason)
          WHERE position_id = $1 AND assignment_type = $2 AND end_date IS NULL
          RETURNING id::text AS id, user_id::text AS user_id`,
        [id, type, endDate, parsed.data.reason ?? null],
      );
      if (!ended.rows[0]) {
        throw new NotFoundException(`${position.title} has no current ${type} holder to remove.`);
      }

      if (type === "primary") {
        await client.query(
          "UPDATE positions SET status = 'vacant' WHERE id = $1 AND status <> 'frozen'",
          [id],
        );
      }

      await logOrgChange(client, orgId, actor, {
        entity: "assignment",
        entityId: ended.rows[0].id,
        action: "unassign",
        before: { userId: ended.rows[0].user_id, positionId: id },
        reason: parsed.data.reason ?? null,
        effectiveDate: endDate,
      });

      return { ok: true, endDate, assignmentId: ended.rows[0].id };
    });
  }

  @Put(":id/responsibilities")
  @RequireCrmPermission("position", "edit")
  async setResponsibilities(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = ResponsibilitiesInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      await requirePosition(client, id);
      const before = await client.query<{ text: string }>(
        "SELECT text FROM position_responsibilities WHERE position_id = $1 ORDER BY sort_order",
        [id],
      );
      await client.query("DELETE FROM position_responsibilities WHERE position_id = $1", [id]);
      for (const [index, item] of parsed.data.items.entries()) {
        await client.query(
          `INSERT INTO position_responsibilities (org_id, position_id, text, category, sort_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [orgId, id, item.text, item.category ?? null, index],
        );
      }
      await logOrgChange(client, orgId, actor, {
        entity: "responsibility",
        entityId: id,
        action: "update",
        before: before.rows.map((r) => r.text),
        after: parsed.data.items.map((i) => i.text),
      });
      return { ok: true, count: parsed.data.items.length };
    });
  }

  /**
   * The one route a MANAGER may reach without `position:edit`, when §14's
   * `managerEditsReports` is on and the seat is one of their direct reports.
   *
   * ── WHY IT IS A SECOND ROUTE AND NOT A BRANCH IN THE ONE ABOVE ────────────
   *
   * `@RequireCrmPermission` is a route-level guard: it refuses before the
   * handler runs, so a handler cannot "also allow" somebody the guard denied.
   * Expressing §14 inside the route above would mean dropping its guard to
   * `view` and re-implementing the admin check by hand - which is how a route
   * that looks guarded stops being.
   *
   * So the admin path keeps a real `position:edit` guard, and this one is
   * gated on `position:view` (which every persona has) plus an explicit
   * relationship check that is the entire authorization. `ENFORCED_PERMISSIONS`
   * is unaffected: both pairs are already listed.
   */
  @Put(":id/responsibilities/as-manager")
  @RequireCrmPermission("position", "view")
  async setResponsibilitiesAsManager(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = ResponsibilitiesInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const actor = auditActor(req);
    const userId = req.principal?.userId;
    if (!userId) throw new ForbiddenException("Only a signed-in person can do this.");

    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const allowed = await mayEditAsManager(client, { userId, positionId: id, asOf: today });
      if (!allowed) {
        const settings = await orgChartSettings(client);
        throw new ForbiddenException(
          settings.managerEditsReports
            ? "You can only change the responsibilities of your own direct reports."
            : "Managers cannot change responsibilities in this workspace. An owner can turn that on in the organization chart settings.",
        );
      }
      const before = await client.query<{ text: string }>(
        "SELECT text FROM position_responsibilities WHERE position_id = $1 ORDER BY sort_order",
        [id],
      );
      await client.query("DELETE FROM position_responsibilities WHERE position_id = $1", [id]);
      for (const [index, item] of parsed.data.items.entries()) {
        await client.query(
          `INSERT INTO position_responsibilities (org_id, position_id, text, category, sort_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [orgId, id, item.text, item.category ?? null, index],
        );
      }
      await logOrgChange(client, orgId, actor, {
        entity: "responsibility",
        entityId: id,
        action: "update",
        before: before.rows.map((r) => r.text),
        after: parsed.data.items.map((i) => i.text),
        reason: "Edited by the manager of this position.",
      });
      return { ok: true, count: parsed.data.items.length };
    });
  }

  @Put(":id/authority")
  @RequireCrmPermission("position", "edit")
  async setAuthority(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = AuthorityInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      await requirePosition(client, id);

      /**
       * A nominated approver must exist, and must not be the seat itself.
       *
       * Self-approval is the one that matters: "approve a refund over ₹10,000
       * with the approval of … yourself" is a limit that reads as a control
       * and is none, and §9 routes real finance approvals through this table.
       */
      for (const item of parsed.data.items) {
        if (!item.requiresApprovalFromPositionId) continue;
        if (item.requiresApprovalFromPositionId === id) {
          throw new BadRequestException(
            "A position cannot be its own approver. Leave the approver blank to escalate up the reporting line.",
          );
        }
        await requirePosition(client, item.requiresApprovalFromPositionId);
      }

      const before = await client.query<Record<string, unknown>>(
        "SELECT action, limit_num::text, limit_percent::text, currency FROM position_authorities WHERE position_id = $1 ORDER BY action",
        [id],
      );
      await client.query("DELETE FROM position_authorities WHERE position_id = $1", [id]);
      for (const item of parsed.data.items) {
        await client.query(
          `INSERT INTO position_authorities
             (org_id, position_id, action, limit_num, limit_percent, currency,
              requires_approval_from_position_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            orgId,
            id,
            item.action,
            item.limitNum ?? null,
            item.limitPercent ?? null,
            item.currency ?? null,
            item.requiresApprovalFromPositionId ?? null,
          ],
        );
      }
      await logOrgChange(client, orgId, actor, {
        entity: "authority",
        entityId: id,
        action: "update",
        before: before.rows,
        after: parsed.data.items,
      });
      return { ok: true, count: parsed.data.items.length };
    });
  }

  @Put(":id/skills")
  @RequireCrmPermission("position", "edit")
  async setSkills(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = SkillsInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      await requirePosition(client, id);
      await client.query("DELETE FROM position_skills WHERE position_id = $1", [id]);
      // Deduplicated here rather than relying on the unique index to throw: a
      // list typed by hand with "Hindi" twice is a slip, not a conflict worth
      // a 409.
      const seen = new Set<string>();
      for (const item of parsed.data.items) {
        const key = item.skill.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        await client.query(
          "INSERT INTO position_skills (org_id, position_id, skill, required) VALUES ($1, $2, $3, $4)",
          [orgId, id, item.skill, item.required ?? true],
        );
      }
      await logOrgChange(client, orgId, actor, {
        entity: "skill",
        entityId: id,
        action: "update",
        after: parsed.data.items,
      });
      return { ok: true, count: seen.size };
    });
  }

  /** §9's KPI templates: the targets a new holder of this seat is given. */
  @Put(":id/kpi-defaults")
  @RequireCrmPermission("position", "edit")
  async setKpiDefaults(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = KpiDefaultsInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      await requirePosition(client, id);
      await client.query("DELETE FROM position_kpi_defaults WHERE position_id = $1", [id]);
      for (const item of parsed.data.items) {
        await client.query(
          `INSERT INTO position_kpi_defaults (org_id, position_id, metric, target_value)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (org_id, position_id, metric) DO UPDATE SET target_value = EXCLUDED.target_value`,
          [orgId, id, item.metric, item.targetValue],
        );
      }
      await logOrgChange(client, orgId, actor, {
        entity: "position",
        entityId: id,
        action: "update",
        after: { kpiDefaults: parsed.data.items },
      });
      return { ok: true, count: parsed.data.items.length };
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // §9's integrations, both fail-soft
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * §9: "assigning a person to the position prefills their KPI set and
   * targets."
   *
   * Writes into `sales_targets` (0050), which is this platform's existing
   * target record, rather than into a second targets table. A KPI that lives
   * in two tables is a number the scorecard and the chart disagree about.
   *
   * ── EVERY WAY THIS DECLINES TO ACT, AND WHY ───────────────────────────────
   *
   * · no `position_kpi_defaults` rows: nothing to prefill, which is the
   *   normal case for a business that has not set any up.
   * · a target the person ALREADY has for this period: left alone.
   *   `ON CONFLICT DO NOTHING` on 0050's own unique index. Overwriting would
   *   let a mid-quarter seat change silently rewrite somebody's number -
   *   and a target is what their incentive is computed against.
   * · the period is the CALENDAR MONTH containing the start date, because
   *   that is the grain `sales_targets` is read at elsewhere.
   *
   * §9 requires integrations to be "optional and fail-soft". This one cannot
   * fail soft by catching an error - `sales_targets` is core and its absence
   * would mean a broken schema - so "soft" here means it never refuses the
   * assignment it is attached to.
   */
  private async seedKpiTargets(
    client: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }> },
    orgId: string,
    positionId: string,
    userId: string,
    startDate: string,
  ): Promise<number> {
    const { rowCount } = await client.query(
      `INSERT INTO sales_targets (org_id, owner_user_id, period_start, period_end, metric, target_value, notes)
       SELECT $1,
              $2,
              date_trunc('month', $3::date)::date,
              (date_trunc('month', $3::date) + interval '1 month - 1 day')::date,
              k.metric,
              k.target_value,
              'Prefilled from the position''s default targets.'
         FROM position_kpi_defaults k
        WHERE k.position_id = $4
          AND NOT EXISTS (
            SELECT 1 FROM sales_targets t
             WHERE t.org_id = $1
               AND t.owner_user_id = $2
               AND t.metric = k.metric
               AND t.period_start = date_trunc('month', $3::date)::date
          )`,
      [orgId, userId, startDate, positionId],
    );
    return rowCount ?? 0;
}

  /**
   * §10: "Reporting-line or assignment change affecting a user (notify the
   * person and their manager)."
   *
   * The MANAGER half is the one that is easy to skip and worst to miss:
   * somebody acquiring a report without being told is how a new joiner's first
   * week has nobody in it. So this notifies the holder of the moved seat AND
   * the holder of its new manager seat.
   *
   * A vacant seat on either end simply produces fewer notifications, rather
   * than an error - which is also §9's "reroute needed" condition, raised by
   * the worker's sweep rather than here: a move is not the moment to tell
   * somebody their new manager's chair is empty, and the sweep already looks
   * for exactly that.
   */
  private async announceReportingChange(
    /**
     * Typed structurally rather than as `PoolClient`, so this method is
     * callable from a test with a two-line fake - the same shape `notify`
     * itself takes, widened by the one `rows` read below. `pg`'s own
     * `QueryResult` carries both, so a real client satisfies it.
     */
    client: {
      query: (
        sql: string,
        params?: unknown[],
      ) => Promise<{ rows: { user_id: string }[]; rowCount: number | null }>;
    },
    orgId: string,
    actor: { type: string; id: string },
    input: {
      positionId: string;
      positionTitle: string;
      newManagerPositionId: string;
      effectiveDate: string;
    },
  ): Promise<void> {
    const holders = await client.query(
      `SELECT a.user_id::text AS user_id
         FROM position_assignments a
        WHERE a.position_id = ANY($1::uuid[])
          AND a.assignment_type = 'primary'
          AND a.end_date IS NULL`,
      [[input.positionId, input.newManagerPositionId]],
    );
    const actorUserId = actor.type === "user" ? actor.id : null;
    for (const { user_id: userId } of holders.rows) {
      await notify(
        client,
        orgId,
        {
          userId,
          kind: "reporting_change",
          title: `Reporting line changed for ${input.positionTitle}`,
          body: `Effective ${input.effectiveDate}.`,
          linkPath: `/owner/org-chart?position=${input.positionId}`,
          // One notification per (position, effective date) per person. A
          // correction made twice in a day must not ring twice.
          dedupeKey: `org_chart_move:${input.positionId}:${input.effectiveDate}`,
        },
        actorUserId,
      );
    }
  }
}
