import { BadRequestException, Body, Controller, Get, NotFoundException, Put, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { canonicalTimeZone, timeZoneSpellings } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const TimeSettingsInput = z.object({
  timezone: z.string().trim().min(1).max(64),
});

/**
 * The first of `candidates` the database knows, in the caller's order of
 * preference - or null. Pure, so the choice is testable without a database.
 *
 * Why there can be more than one candidate: IANA renamed zones (Kiev -> Kyiv
 * in 2022) and a Postgres built against older tzdata knows only the old name,
 * while ICU on the web tier may offer only the new one. The zone is the same;
 * storing whichever spelling THIS database accepts is what keeps the 0090
 * trigger from refusing a perfectly real place.
 */
export function chooseZoneSpelling(candidates: readonly string[], known: readonly string[]): string | null {
  const available = new Set(known);
  return candidates.find((c) => available.has(c)) ?? null;
}

/**
 * The workspace clock (Build docs/30): the one time zone every time in the
 * console is shown in, and every "today", "overdue" and daily bucket is cut on.
 *
 * ── OWNER AND MANAGER, BOTH HALVES ──────────────────────────────────────────
 *
 * The business profile keeps its owner-only write; this does not. A manager
 * runs the floor whose "today" this is, and the request that created this
 * route named both personas. The persona comes from `memberships` via
 * OwnerRoleGuard - not from @RequireOrgRole, which the admin key's
 * platform_admin waves through (see business-profile.controller.ts).
 *
 * ── WHAT A CHANGE MOVES ─────────────────────────────────────────────────────
 *
 * Nothing stored. Every instant stays the instant it was; dates (due_on,
 * invoice due dates) stay the dates they were. What moves is where midnight
 * falls - so overdue counts, daily charts and report windows re-cut on the
 * next read. The picker says so before the save, and the audit line records
 * both zones so "why did Tuesday's numbers change" has an answer.
 */
@Controller("owner/time-settings")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
export class TimeSettingsController {
  constructor(private readonly db: DbService) {}

  @Get()
  @RequireOwnerRole("owner", "manager")
  async get(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<{ reporting_timezone: string }>(
        `SELECT reporting_timezone FROM organizations WHERE id = $1`,
        [orgId],
      );
      if (!row) throw new NotFoundException("organization not found");
      return { timezone: canonicalTimeZone(row.reporting_timezone) ?? row.reporting_timezone };
    });
  }

  @Put()
  @RequireOwnerRole("owner", "manager")
  async put(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = TimeSettingsInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const canonical = canonicalTimeZone(parsed.data.timezone);
    if (!canonical) {
      throw new BadRequestException([{ path: ["timezone"], message: "Choose a time zone from the list." }]);
    }
    const actor = req.principal?.userId ?? "unknown";

    return this.db.withOrg(orgId, async (client) => {
      const candidates = timeZoneSpellings(canonical);
      const { rows: known } = await client.query<{ name: string }>(
        `SELECT name FROM pg_timezone_names WHERE name = ANY($1::text[])`,
        [candidates],
      );
      const stored = chooseZoneSpelling(
        candidates,
        known.map((k) => k.name),
      );
      if (!stored) {
        throw new BadRequestException([
          { path: ["timezone"], message: "This server does not recognise that time zone yet. Choose a nearby city." },
        ]);
      }

      const {
        rows: [before],
      } = await client.query<{ reporting_timezone: string }>(
        `SELECT reporting_timezone FROM organizations WHERE id = $1`,
        [orgId],
      );
      if (!before) throw new NotFoundException("organization not found");

      // Same zone in either spelling: nothing to write and nothing to audit.
      if (canonicalTimeZone(before.reporting_timezone) === canonical) {
        return { timezone: canonical, changed: false };
      }

      await client.query(
        `UPDATE organizations SET reporting_timezone = $2, updated_at = now() WHERE id = $1`,
        [orgId, stored],
      );
      // Zone names are not personal data, so unlike the business profile's
      // audit line this one records the values - "from IST to GST" is the
      // whole explanation for a report that re-cut its days.
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, 'org.timezone_updated', 'organization', $3, $4::jsonb)`,
        [orgId, actor, orgId, JSON.stringify({ from: before.reporting_timezone, to: stored })],
      );
      return { timezone: canonical, changed: true };
    });
  }
}
