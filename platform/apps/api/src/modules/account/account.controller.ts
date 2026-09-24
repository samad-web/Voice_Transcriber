import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Patch,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { consolePhone, orgPhoneCountry } from "../../common/console-phone";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const UUID = z.string().uuid();

/** `users` is shared across orgs, so a name is the person's, not the workspace's. */
const ProfileInput = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(80),
});

/**
 * Empty clears it. No `.default()` anywhere, and no `.partial()` - a PATCH that
 * named one field must never write another (the zod partial/default trap).
 */
const PhoneInput = z.object({
  phone: z
    .string()
    .trim()
    .max(40)
    .nullable()
    .transform((v) => (v ? v : null)),
});

/** The last four digits, for an audit line that says what changed without keeping the number. */
function lastFour(phone: string | null): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits ? digits.slice(-4) : null;
}

/**
 * A person's OWN profile, in the workspace they are signed in to (doc 27 §4.2).
 *
 * ── WHO "ME" IS ────────────────────────────────────────────────────────────
 *
 * The caller is `principal.userId`, which AdminKeyGuard takes from the
 * `x-caller-user-id` header the Next server sets from the verified session
 * (`lib/server-api.ts`). Never from a body: there is no route here that takes
 * a user id at all, so there is nothing to point at somebody else. A bare
 * admin key names no person (`userId === "admin-key"`) and is refused - a
 * profile with nobody behind it has nothing to show.
 *
 * ── NO PERSONA GUARD, ON PURPOSE ───────────────────────────────────────────
 *
 * Every persona has a profile. OwnerRoleGuard would express nothing here, and
 * the only thing to protect - that you edit your own row and nobody else's -
 * is in every WHERE clause below.
 *
 * ── THE PHONE ──────────────────────────────────────────────────────────────
 *
 * `memberships.phone` is where call-access approval codes are sent (0122), so
 * changing it is security-relevant. The web tier calls PATCH /account/phone
 * only from a server action that has just re-checked the person's password
 * against GoTrue; this route cannot see a password (the API never holds the
 * Supabase session), so it records the change - old and new last four digits
 * - and that audit line is its own part of the control.
 *
 * Email is deliberately NOT editable here: changing it needs auth email, and
 * no SMTP is configured on this platform.
 */
@Controller("account")
@UseGuards(AdminKeyGuard, TenantGuard)
export class AccountController {
  constructor(private readonly db: DbService) {}

  private caller(req: PrincipalRequest): string {
    const userId = req.principal?.userId;
    const parsed = UUID.safeParse(userId);
    if (!parsed.success) throw new ForbiddenException("a signed-in person is required");
    return parsed.data;
  }

  @Get("profile")
  async profile(@OrgId() orgId: string, @Req() req: PrincipalRequest) {
    const userId = this.caller(req);
    return this.db.withOrg(orgId, async (client) => {
      // `users` carries no RLS (it spans orgs); the membership join under
      // withOrg is what proves this person belongs to THIS workspace.
      const {
        rows: [row],
      } = await client.query<{
        name: string | null;
        email: string;
        phone: string | null;
        job_title: string | null;
        staff_code: string | null;
      }>(
        `SELECT u.name, u.email, m.phone, m.job_title, m.staff_code
           FROM memberships m
           JOIN users u ON u.id = m.user_id
          WHERE m.user_id = $1 AND m.org_id = $2
          LIMIT 1`,
        [userId, orgId],
      );
      if (!row) throw new NotFoundException("no membership in this workspace");
      return {
        name: row.name,
        email: row.email,
        phone: row.phone,
        jobTitle: row.job_title,
        staffCode: row.staff_code,
      };
    });
  }

  @Patch("profile")
  async updateProfile(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const userId = this.caller(req);
    const parsed = ProfileInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      // Same transaction as the audit line, and gated on a membership in this
      // org so a user id that belongs elsewhere changes nothing.
      const { rowCount } = await client.query(
        `UPDATE users u SET name = $2, updated_at = now()
          WHERE u.id = $1
            AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.org_id = $3)`,
        [userId, parsed.data.name, orgId],
      );
      if (!rowCount) throw new NotFoundException("no membership in this workspace");
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'account.name_changed', 'user', $2)`,
        [orgId, userId],
      );
      return { name: parsed.data.name };
    });
  }

  @Patch("phone")
  async updatePhone(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const userId = this.caller(req);
    const parsed = PhoneInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      // Stored as E.164 and valid for its country: this is the number a
      // call-access code is sent to, and a typo here locks the person out.
      const next = consolePhone(parsed.data.phone, "phone", await orgPhoneCountry(client, orgId));
      // FOR UPDATE so the "old" digits in the audit line are the ones this
      // write actually replaced, not a value a concurrent save already changed.
      const {
        rows: [current],
      } = await client.query<{ phone: string | null }>(
        `SELECT phone FROM memberships WHERE user_id = $1 AND org_id = $2 FOR UPDATE`,
        [userId, orgId],
      );
      if (!current) throw new NotFoundException("no membership in this workspace");

      await client.query(
        `UPDATE memberships SET phone = $3, updated_at = now() WHERE user_id = $1 AND org_id = $2`,
        [userId, orgId, next],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, 'account.phone_changed', 'user', $2, $3::jsonb)`,
        [orgId, userId, JSON.stringify({ oldLast4: lastFour(current.phone), newLast4: lastFour(next) })],
      );
      return { phone: next };
    });
  }
}
