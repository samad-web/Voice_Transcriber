import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { NumberKey } from "./vault.service";

/**
 * The one console route that turns a stored digest back into a customer's
 * phone number (migration 0157, Build docs/39 §2.1).
 *
 * ── WHY THIS IS THE NARROWEST ROUTE IN THE API ──────────────────────────────
 *
 * 0006 removed full counterparty numbers from the schema deliberately. 0157
 * puts them back for one purpose - a dialer has to have something to dial -
 * and everything about the way it does that is a fence around this handler:
 * its own table with its own grants, written only for a tenant that turned
 * 0011's switch on, a consent basis on every row, and TWO routes in the entire
 * API permitted to serve `e164`. This is one; the handset's
 * `GET /device/dialer/next` (P1, not built) is the other, and
 * `e164-disclosure.spec.ts` greps the source tree to keep it at that.
 *
 * ── `contact_number:view`, NOT `dnc:view` ───────────────────────────────────
 *
 * §31 is explicit, and corrects its own first draft: maintaining a
 * do-not-call list and reading a customer's phone number are different trust
 * decisions, and collapsing them would have made the stricter one
 * unreachable. 0158 seeds `contact_number:view` to the three admin roles and
 * `workspace_member` - the telecaller who actually has to ring the person -
 * and deliberately NOT to `viewer`, which is the one place in 0157/0158 that
 * departs from 0041's "a viewer always gets view". Granting it later is one
 * click; withdrawing it after a read-only auditor exported somebody's number
 * is too late.
 *
 * ── THE DISCLOSURE IS RECORDED BEFORE IT IS SERVED ──────────────────────────
 *
 * The audit row is written INSIDE the same `withOrg` transaction as the read,
 * so a trail that cannot be written is a number that is not disclosed. §2.1
 * asks for `auth_events` (0127) and that is not possible: see
 * AUDIT_REVEAL_SQL.
 *
 * ── ONE NUMBER, NEVER A LIST ────────────────────────────────────────────────
 *
 * The response is `{ numberKey, e164 }` and the route takes a single key. Not
 * a batch, not an embellishment of a list endpoint, and no `?keys=` form: a
 * disclosure that can be asked for a thousand at a time is an export, one
 * audit row per thousand is not a trail, and the campaign preview that WOULD
 * want a thousand is specified to count rather than to read (§11, "Counts
 * only; never numbers").
 */

/**
 * The disclosure trail.
 *
 * ── WHY `audit_log` AND NOT `auth_events` ───────────────────────────────────
 *
 * §2.1, 0157's header and this build's brief all say to write an `auth_events`
 * row and not to invent a second audit table. The second half is honoured; the
 * first cannot be, and the reason is in 0127:
 *
 *  - `auth_events.kind` is `CHECK (kind IN ('sign_in','sign_in_failed',
 *    'sign_out','sign_out_all','password_changed'))` and no migration from
 *    0127 to 0158 widens it. Inserting a sixth kind throws 23514 at runtime -
 *    the CHECK/zod drift failure 0158's own header spends a paragraph on.
 *  - that table is admin-pool only (RLS forced with NO policy, `aura_app`
 *    revoked outright), so a route running inside `withOrg` cannot write it at
 *    all and would have to leave the transaction to try.
 *  - it is keyed on the PERSON (`auth_user_id`) and 0127 names its org column
 *    `console_org_id` specifically so that nothing reads it as a tenant
 *    boundary. A tenant asking "who looked up our customers' numbers" cannot
 *    be answered from a table scoped to individuals across every workspace.
 *
 * `audit_log` is not a second audit table - it is the FIRST one, from
 * 0001_init, org-scoped, append-only (UPDATE and DELETE revoked from
 * `aura_app`), and already the home of every other sensitive disclosure in
 * this codebase including 0122's call-access trail. `action` is an open text
 * column, so no CHECK moves. Written with `auditActor`, so an operator acting
 * through the admin key lands as `operator` with their email rather than as a
 * user called "admin-key".
 */
export const AUDIT_REVEAL_SQL = `INSERT INTO audit_log
       (org_id, actor_type, actor_id, action, target_type, target_id, meta)
     VALUES ($1, $2, $3, 'contact_number.revealed', 'contact_number', $4, $5::jsonb)`;

/** The org's switch, the row, and nothing else. One round trip at Seoul latency. */
export const REVEAL_LOOKUP_SQL = `SELECT o.store_full_number,
            n.e164, n.source, n.consent_basis
       FROM organizations o
       LEFT JOIN contact_numbers n ON n.org_id = o.id AND n.number_key = $1
      WHERE o.id = $2`;

interface RevealRow {
  store_full_number: boolean | null;
  e164: string | null;
  source: string | null;
  consent_basis: string | null;
}

@Controller("numbers")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class NumbersController {
  constructor(private readonly db: DbService) {}

  /**
   * Reveal the number behind a key.
   *
   * 404 for an unknown key AND for a key with no vault row - the two are
   * indistinguishable on purpose, so guessing keys discloses nothing about
   * which ones the vault holds.
   *
   * 403 when the tenant is not on `store_full_number`. The vault writes
   * nothing while that switch is off, so normally there is no row to find -
   * but an operator who switches it back off is withdrawing permission to keep
   * callable numbers, and reads have to stop on the same breath. 0011's
   * contract is about the whole subsystem, not only about writes.
   */
  @Get(":numberKey/reveal")
  @RequireCrmPermission("contact_number", "view")
  async reveal(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("numberKey") numberKey: string,
  ): Promise<{ numberKey: string; e164: string }> {
    const key = NumberKey.safeParse(numberKey);
    if (!key.success) throw new BadRequestException(key.error.issues);
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<RevealRow>(REVEAL_LOOKUP_SQL, [key.data, orgId]);

      if (!row) throw new NotFoundException("organization not found");
      if (row.store_full_number !== true) {
        throw new ForbiddenException({
          code: "numbers_not_stored",
          message: "This workspace does not keep callable phone numbers. An operator can switch that on.",
        });
      }
      if (!row.e164) throw new NotFoundException({ code: "no_number", message: "No number on file." });

      // Before the value leaves the transaction. A trail that fails to write
      // rolls the read back with it, which is the only ordering in which
      // "every reveal is audited" is a property rather than a hope.
      await client.query(AUDIT_REVEAL_SQL, [
        orgId,
        actor.type,
        actor.id,
        key.data,
        // The basis and the source, never the number: an audit row that
        // repeated the digits would put them in a second table with different
        // grants and defeat the vault.
        JSON.stringify({ source: row.source, consentBasis: row.consent_basis }),
      ]);

      return { numberKey: key.data, e164: row.e164 };
    });
  }
}
