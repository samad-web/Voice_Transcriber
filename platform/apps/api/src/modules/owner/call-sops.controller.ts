import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  DEFAULT_SOP_STEPS,
  MAX_SOP_STEPS,
  ScriptAdherenceMode,
  SopSteps,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OrgFeatureGuard, RequireFeature } from "../../common/org-feature.guard";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OwnerScopeGuard } from "../../common/owner-scope.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * The tenant's call SOP (migration 0091) - what a good call looks like on this
 * floor, and which version each call was judged against.
 *
 * ── WHY EDITING INSERTS INSTEAD OF UPDATING ─────────────────────────────────
 *
 * `call_sops` is keyed (id, version), the same shape `agents` has carried since
 * 0001, and `PUT` is deliberately absent from this controller. An edit is
 * `POST /:id/versions`, which writes a new row and moves the active flag.
 *
 * That is not bookkeeping. `call_sop_results.sop_version` records the exact
 * text that judged each call, so an in-place update would silently re-describe
 * February's calls as failing a rule written in March - with nothing anywhere
 * recording that the rule changed. A rep can be shown the version they were
 * scored under, which is the difference between a score they can argue with
 * and one they can only resent.
 *
 * ── EVERY ROUTE IS OWNER OR MANAGER ─────────────────────────────────────────
 *
 * Unlike the productivity read next door, which every persona may open to see
 * their own numbers. An SOP is the definition of the measure; a telecaller
 * reading it is fine in principle and editing it is not, and there is no
 * per-row narrowing to fall back on because an SOP has no owner. So the whole
 * controller carries a real `@RequireOwnerRole` rather than relying on scope.
 */

const ModeBody = z.object({ mode: ScriptAdherenceMode });

const SopBody = z.object({
  name: z.string().min(1).max(120),
  steps: SopSteps,
  /** Activate on write. The one-active-per-org unique index is what enforces it. */
  activate: z.boolean().default(true),
});

@Controller("owner/sops")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard, OwnerScopeGuard, OrgFeatureGuard)
@RequireFeature("call_sops")
export class CallSopsController {
  constructor(private readonly db: DbService) {}

  /**
   * Every SOP this org has, newest version of each first, plus the catalogue
   * default for an org that has none.
   *
   * The default ships in the response rather than being written into the
   * database at provisioning time. An SOP row nobody chose would be scored
   * against from the first call - a tenant would find their reps being marked
   * against seven rules they had never seen. Offering it as a starting point
   * the console can prefill keeps the decision theirs.
   */
  @Get()
  @RequireOwnerRole("owner", "manager")
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT DISTINCT ON (id) id, version, name, steps, is_active, created_at, updated_at
           FROM call_sops
          WHERE org_id = $1
          ORDER BY id, version DESC`,
        [orgId],
      );
      const {
        rows: [org],
      } = await client.query<{ script_adherence_mode: string }>(
        `SELECT script_adherence_mode FROM organizations WHERE id = $1`,
        [orgId],
      );
      return {
        sops: rows,
        maxSteps: MAX_SOP_STEPS,
        /** A starting point to edit, never something already in force. */
        defaultSteps: DEFAULT_SOP_STEPS,
        /** Which measure is in force (0155) - 'ai' or 'sop'. */
        mode: ScriptAdherenceMode.catch("ai").parse(org?.script_adherence_mode),
      };
    });
  }

  /**
   * Choose the measure: the model's own read, or this floor's checklist (0155).
   *
   * ── WHY THE SWITCH ALSO MOVES THE ACTIVE FLAG ───────────────────────────────
   *
   * Two pieces of state could disagree - the mode, and `call_sops.is_active` -
   * and the worker reads BOTH (mode first, then the active SOP). Left
   * independent they would produce a console that says "Your call checklist"
   * over an org with nothing activated, scoring nothing and reporting nothing,
   * with no error anywhere. So this endpoint keeps them in step inside one
   * transaction:
   *
   *   -> 'sop' with no active SOP is refused, and says what to do about it.
   *      Writing a checklist is a real decision with real text in it; silently
   *      activating the LAST version somebody edited is the kind of help that
   *      scores a floor against a draft.
   *   -> 'ai' deactivates the SOP, because leaving it flagged active while
   *      nothing reads it is a trap for the next person to open this code.
   *
   * Past `call_sop_results` are untouched either way - 0091's rule: they are
   * the record of what was judged, not a live view.
   */
  @Post("mode")
  @RequireOwnerRole("owner", "manager")
  async setMode(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = ModeBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { mode } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      if (mode === "sop") {
        const {
          rows: [active],
        } = await client.query<{ id: string }>(
          `SELECT id FROM call_sops WHERE org_id = $1 AND is_active LIMIT 1`,
          [orgId],
        );
        if (!active) {
          throw new BadRequestException(
            "Write and save your call checklist first - there is nothing to score against yet.",
          );
        }
      } else {
        await client.query(
          `UPDATE call_sops SET is_active = false WHERE org_id = $1 AND is_active`,
          [orgId],
        );
      }

      await client.query(`UPDATE organizations SET script_adherence_mode = $2 WHERE id = $1`, [
        orgId,
        mode,
      ]);
      await this.audit(client, orgId, orgId, "sop.mode", { mode });
      return { mode };
    });
  }

  /** One SOP's full version history, so a score can be read against its own text. */
  @Get(":id/versions")
  @RequireOwnerRole("owner", "manager")
  async versions(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, version, name, steps, is_active, created_at
           FROM call_sops
          WHERE org_id = $1 AND id = $2
          ORDER BY version DESC`,
        [orgId, id],
      );
      if (rows.length === 0) throw new NotFoundException("SOP not found");
      return { versions: rows };
    });
  }

  @Post()
  @RequireOwnerRole("owner", "manager")
  async create(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = SopBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { name, steps, activate } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      // Deactivate first: `call_sops_one_active_per_org` is a UNIQUE index, so
      // inserting a second active row would fail rather than take over. Both
      // statements are in the transaction withOrgContext already opens, so
      // there is no window in which the org has no active SOP.
      if (activate) {
        await client.query(
          `UPDATE call_sops SET is_active = false WHERE org_id = $1 AND is_active`,
          [orgId],
        );
      }
      const {
        rows: [row],
      } = await client.query(
        `INSERT INTO call_sops (org_id, name, steps, is_active)
         VALUES ($1, $2, $3::jsonb, $4)
         RETURNING id, version, name, steps, is_active, created_at`,
        [orgId, name, JSON.stringify(steps), activate],
      );
      // Activating a checklist IS choosing to be scored against it (0155), so
      // the mode follows rather than being a second thing to remember. Without
      // this an owner can save seven steps, see them marked active, and be
      // scored by the model instead - with nothing on the screen admitting it.
      if (activate) await this.useSop(client, orgId);
      await this.audit(client, orgId, row.id, "sop.create", { version: row.version, name });
      return row;
    });
  }

  /**
   * Edit = a new version of the same SOP id.
   *
   * The version number is `max + 1` read inside the same transaction rather
   * than a sequence, because versions are per-SOP and a global sequence would
   * make v1 of the second SOP read as v14.
   */
  @Post(":id/versions")
  @RequireOwnerRole("owner", "manager")
  async addVersion(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = SopBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { name, steps, activate } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [current],
      } = await client.query<{ max: number }>(
        `SELECT max(version) AS max FROM call_sops WHERE org_id = $1 AND id = $2`,
        [orgId, id],
      );
      if (current?.max == null) throw new NotFoundException("SOP not found");

      if (activate) {
        await client.query(
          `UPDATE call_sops SET is_active = false WHERE org_id = $1 AND is_active`,
          [orgId],
        );
      }
      const {
        rows: [row],
      } = await client.query(
        `INSERT INTO call_sops (id, org_id, version, name, steps, is_active)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         RETURNING id, version, name, steps, is_active, created_at`,
        [id, orgId, Number(current.max) + 1, name, JSON.stringify(steps), activate],
      );
      if (activate) await this.useSop(client, orgId);
      await this.audit(client, orgId, id, "sop.version", { version: row.version, name });
      return row;
    });
  }

  /**
   * Stop scoring calls against any SOP.
   *
   * Existing `call_sop_results` are untouched - they are a record of what was
   * judged, not a live view - so turning scoring off hides the panel on new
   * calls without rewriting the history of old ones.
   */
  @Post("deactivate")
  @RequireOwnerRole("owner", "manager")
  async deactivate(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const res = await client.query(
        `UPDATE call_sops SET is_active = false WHERE org_id = $1 AND is_active RETURNING id`,
        [orgId],
      );
      // The mirror of `useSop`: with no checklist in force there is nothing for
      // 'sop' mode to score, so the measure falls back to the model's own read
      // rather than to nothing at all (0155).
      await client.query(
        `UPDATE organizations SET script_adherence_mode = 'ai' WHERE id = $1`,
        [orgId],
      );
      if ((res.rowCount ?? 0) > 0) {
        await this.audit(client, orgId, res.rows[0].id, "sop.deactivate", {});
      }
      return { deactivated: res.rowCount ?? 0 };
    });
  }

  /** Put this org's checklist in force as the adherence measure (0155). */
  private async useSop(
    client: Parameters<Parameters<DbService["withOrg"]>[1]>[0],
    orgId: string,
  ): Promise<void> {
    await client.query(`UPDATE organizations SET script_adherence_mode = 'sop' WHERE id = $1`, [
      orgId,
    ]);
  }

  private async audit(
    client: Parameters<Parameters<DbService["withOrg"]>[1]>[0],
    orgId: string,
    targetId: string,
    action: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
       VALUES ($1, 'user', 'owner-console', $2, 'call_sop', $3, $4::jsonb)`,
      [orgId, action, targetId, JSON.stringify(meta)],
    );
  }
}
