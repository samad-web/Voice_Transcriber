import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { CrossTenant, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const AddOperator = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  note: z.string().trim().max(200).optional(),
  /** Who granted it, for the standing-privileges list. */
  addedBy: z.string().trim().toLowerCase().email().max(200),
});

/**
 * The platform's own staff list (migration 0089).
 *
 * ── WHERE THE REAL CHECK LIVES, AND WHY IT IS NOT HERE ───────────────────
 *
 * "Only the root operator may change this list" is enforced in the web tier,
 * in `requireMax()`, because that is the only layer that knows WHICH human is
 * asking. Every console request reaches this API on one shared `ADMIN_API_KEY`
 * and is minted `platform_admin`; the API cannot tell one operator from
 * another, and a header claiming an identity would be forgeable by anyone
 * already holding that key. Pretending otherwise here would be security
 * theatre - so this controller is honest about being an admin-key surface, the
 * same as every other route under /admin.
 *
 * What this layer CAN enforce is the invariant that does not depend on knowing
 * the caller: the root address is not a row. It cannot be added and it cannot
 * be deleted, whoever is asking, because the root is defined by the
 * environment and a row carrying it would be a second, deletable copy of an
 * identity that must have exactly one source. That check is below, and it is
 * the reason a compromised console still cannot orphan the platform.
 */
@Controller("admin/operators")
@UseGuards(AdminKeyGuard, TenantGuard)
// A platform operator belongs to no org, so there is no tenant for TenantGuard
// to scope these to - the same reason /admin/tenants carries this.
@CrossTenant()
export class OperatorsController {
  constructor(private readonly db: DbService) {}

  /** The root, from the environment. Never read from the table. */
  private root(): string {
    return (process.env.PLATFORM_ROOT_OPERATOR_EMAIL ?? "").trim().toLowerCase();
  }

  /**
   * The added superadmins, newest first.
   *
   * `root` rides along so the console can render "you are the root" without a
   * second source of truth, and so a list that is empty for the WRONG reason -
   * nobody configured a root at all - is visible rather than silent.
   */
  @Get()
  async list() {
    const { rows } = await this.db
      .adminPool()
      .query<{ email: string; added_by: string; note: string | null; created_at: string }>(
        `SELECT email, added_by, note, created_at
           FROM platform_operators
          ORDER BY created_at DESC`,
      );
    return { operators: rows, root: this.root() || null };
  }

  @Post()
  async add(@Body() body: unknown) {
    const parsed = AddOperator.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { email, note, addedBy } = parsed.data;

    // The root is not a row - see the class header. Refused rather than
    // silently ignored, because "I added them and they are not in the list" is
    // the kind of confusion that ends with someone editing the table by hand.
    if (email === this.root()) {
      throw new ForbiddenException(
        "That address is the root operator, which is configured in the environment and cannot be added here.",
      );
    }

    const { rows } = await this.db.adminPool().query<{ email: string }>(
      `INSERT INTO platform_operators (email, added_by, note)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET note = EXCLUDED.note
       RETURNING email`,
      [email, addedBy, note ?? null],
    );
    return { operator: rows[0] };
  }

  /**
   * Revoke a superadmin.
   *
   * A hard DELETE, not a `revoked_at` column: this table IS the authorization,
   * and a revoked row that still exists is one forgotten `WHERE` clause away
   * from being an active one. The history that matters - who granted what, and
   * when - is on the rows that are still standing.
   */
  @Delete(":email")
  async remove(@Param("email") rawEmail: string) {
    const email = rawEmail.trim().toLowerCase();
    if (email === this.root()) {
      throw new ForbiddenException(
        "The root operator cannot be removed here - it is configured in the environment.",
      );
    }

    const { rowCount } = await this.db
      .adminPool()
      .query(`DELETE FROM platform_operators WHERE email = $1`, [email]);
    // 200 either way: the caller asked for that address to hold no privilege,
    // and it does not. A 404 would only distinguish "already gone" from "never
    // there", which changes nothing they would do next.
    return { removed: (rowCount ?? 0) > 0 };
  }
}
