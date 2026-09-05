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
  Post,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { CrossTenant, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { SupabaseAdminService } from "../owner/supabase-admin.service";

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
  constructor(
    private readonly db: DbService,
    private readonly supabase: SupabaseAdminService,
  ) {}

  /** The root, from the environment. Never read from the table. */
  private root(): string {
    return (process.env.PLATFORM_ROOT_OPERATOR_EMAIL ?? "").trim().toLowerCase();
  }

  /**
   * Refuse any address that is not already platform staff.
   *
   * The two login routes below mint and reset Supabase credentials, and this is
   * the fence around them. It is the same species of check as "the root is not
   * a row": an invariant that holds without knowing which human is calling, so
   * it survives the fact that every console request arrives on one shared
   * `ADMIN_API_KEY`.
   *
   * What it buys: the admin key cannot be pointed at this route to create a
   * confirmed Supabase account for an arbitrary address. Appointing somebody is
   * a separate, deliberate step that the root operator takes first, so the set
   * of addresses these routes can touch is exactly the set already visible on
   * the Superadmins page - auditable, and shorter than "anyone".
   */
  private async assertPlatformStaff(email: string): Promise<void> {
    if (email && email === this.root()) return;
    const { rowCount } = await this.db
      .adminPool()
      .query(`SELECT 1 FROM platform_operators WHERE email = $1`, [email]);
    if ((rowCount ?? 0) === 0) {
      throw new ForbiddenException(
        `${email} is not a superadmin - appoint them first, then create their login.`,
      );
    }
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
   * Give a superadmin a console login, with a password shown once.
   *
   * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
   *
   * Appointing somebody writes a row that says an address MAY use this console.
   * It does not make that address able to sign in, and until this route existed
   * nothing in the product did: the console authenticates with
   * `signInWithPassword` and offers no magic link, no OTP, no invite mail and no
   * password-reset flow, so a freshly appointed superadmin had a grant they
   * could not use and the only remedy was the Supabase dashboard.
   *
   * The tenant side has had this since owner accounts existed
   * (`OwnerAccountsService.addOwner`). What is deliberately NOT reused is the
   * membership half of it: an owner account inserts into `users` and
   * `memberships`, which would make platform staff an owner of somebody's
   * tenant. A superadmin is a Supabase auth user and nothing else - the
   * authorization already lives in `platform_operators`, and `getPrincipal`
   * resolves an account with no membership at all to `kind: "operator"`, which
   * is exactly what this is meant to produce.
   */
  @Post(":email/login")
  async createLogin(@Param("email") rawEmail: string) {
    const email = this.parseEmail(rawEmail);
    await this.assertPlatformStaff(email);

    if (await this.supabase.findUserByEmail(email)) {
      throw new ConflictException(
        `${email} already has a login - reset the password instead of creating a second one.`,
      );
    }

    const password = SupabaseAdminService.generatePassword();
    try {
      await this.supabase.createUser(email, password, { platform_operator: true });
    } catch (err) {
      // The lookup above says no account exists and Supabase says one does.
      // That is a race, or a lookup that walked past it - either way the
      // caller's next move is "reset", not "try again", so say so.
      const message = err instanceof Error ? err.message : String(err);
      if (/already been registered|already registered|already exists/i.test(message)) {
        throw new ConflictException(
          `${email} already has a login - reset the password instead of creating a second one.`,
        );
      }
      throw err;
    }

    return { email, password };
  }

  /**
   * A new password for a superadmin who already has a login.
   *
   * Reachable for the ROOT as well as for appointed staff, which is the whole
   * reason `assertPlatformStaff` treats the root address as staff despite it
   * having no row: the one account that can appoint everybody else must be able
   * to recover its own sign-in, and there is no self-service reset anywhere in
   * this product to fall back on.
   *
   * Supabase leaves existing sessions alone on a password change, so this does
   * not sign anyone out - it changes what they will need at the next sign-in.
   * The console says so before it asks, because a root who resets their own
   * password and loses the string has locked themselves out of their own
   * platform.
   */
  @Post(":email/password")
  async resetLoginPassword(@Param("email") rawEmail: string) {
    const email = this.parseEmail(rawEmail);
    await this.assertPlatformStaff(email);

    const existing = await this.supabase.findUserByEmail(email);
    if (!existing) {
      throw new NotFoundException(
        `${email} has no login yet - create one instead of resetting it.`,
      );
    }

    const password = SupabaseAdminService.generatePassword();
    await this.supabase.setPassword(existing.id, password);
    return { email, password };
  }

  /**
   * A path segment is whatever the caller typed - validate before it reaches a
   * query or Supabase.
   *
   * No `decodeURIComponent` here: Express has already decoded the segment, and
   * decoding twice would corrupt any address containing a literal percent. The
   * `DELETE` route below takes the same value the same way.
   */
  private parseEmail(raw: string): string {
    const parsed = z.string().trim().toLowerCase().email().max(200).safeParse(raw ?? "");
    if (!parsed.success) throw new BadRequestException("That is not an email address");
    return parsed.data;
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
