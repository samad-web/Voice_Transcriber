import { BadRequestException, Body, Controller, Get, NotFoundException, Put, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { canonicalTimeZone, timeZoneSpellings } from "@aura/shared";
import { isPhoneCountry } from "@aura/shared/dist/phone";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const TimeSettingsInput = z.object({
  timezone: z.string().trim().min(1).max(64),
});

/** Every ISO 4217 code this runtime knows - the same list the console's picker offers. */
const KNOWN_CURRENCIES = new Set<string>(
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : ["INR", "USD", "EUR", "GBP", "AED"],
);

const RegionSettingsInput = z.object({
  country: z
    .string()
    .trim()
    .toUpperCase()
    .refine(isPhoneCountry, "Choose a country from the list."),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .refine((c) => KNOWN_CURRENCIES.has(c), "Choose a currency from the list."),
});

/**
 * Can the region move to `country`? Pure, so the rule is testable without a
 * database. A GSTIN is an Indian registration; the business profile refuses
 * one on a non-Indian business, and this must not be the back door that
 * produces exactly that row.
 */
export function regionChangeProblem(country: string, stored: { gstin: string | null }): string | null {
  if (country !== "IN" && stored.gstin) {
    return "Your business profile has a GSTIN, which only applies in India. Remove it on the Business profile page first.";
  }
  return null;
}

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
      } = await client.query<{ reporting_timezone: string; country: string | null; base_currency: string | null }>(
        `SELECT o.reporting_timezone, p.country, p.base_currency
           FROM organizations o
           LEFT JOIN org_business_profile p ON p.org_id = o.id
          WHERE o.id = $1`,
        [orgId],
      );
      if (!row) throw new NotFoundException("organization not found");
      return {
        timezone: canonicalTimeZone(row.reporting_timezone) ?? row.reporting_timezone,
        country: row.country ?? "IN",
        currency: row.base_currency ?? "INR",
      };
    });
  }

  /**
   * The workspace's country and currency (the "location" half of Time &
   * location). They are org_business_profile's own `country` and
   * `base_currency` columns (0126) - not a second copy - so the business
   * profile, invoices and every phone field read one answer.
   *
   * OWNER ONLY, unlike the zone. These are the same two columns the business
   * profile's owner-only PUT writes, and the currency is what the business
   * bills in; a manager reads them on the page but cannot change them.
   *
   * Outside India the GST state means nothing, so it is cleared - the same
   * rule the business profile's own transform applies. A stored GSTIN blocks
   * the move instead, because clearing a legal registration silently is not
   * this page's call.
   */
  @Put("region")
  @RequireOwnerRole("owner")
  async putRegion(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = RegionSettingsInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { country, currency } = parsed.data;
    const actor = req.principal?.userId ?? "unknown";
    const actorUuid = /^[0-9a-f-]{36}$/i.test(actor) ? actor : null;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [before],
      } = await client.query<{ country: string | null; base_currency: string | null; gstin: string | null }>(
        `SELECT p.country, p.base_currency, p.gstin
           FROM organizations o
           LEFT JOIN org_business_profile p ON p.org_id = o.id
          WHERE o.id = $1`,
        [orgId],
      );
      if (!before) throw new NotFoundException("organization not found");
      const problem = regionChangeProblem(country, before);
      if (problem) throw new BadRequestException([{ path: ["country"], message: problem }]);

      const from = { country: before.country ?? "IN", currency: before.base_currency ?? "INR" };
      if (from.country === country && from.currency === currency) {
        return { country, currency, changed: false };
      }

      // Upsert: an org that never saved its business profile has no row, and
      // every other column takes its default.
      await client.query(
        `INSERT INTO org_business_profile (org_id, country, base_currency, state_code, updated_by)
         VALUES ($1, $2, $3, NULL, $4)
         ON CONFLICT (org_id) DO UPDATE SET
           country = EXCLUDED.country,
           base_currency = EXCLUDED.base_currency,
           state_code = CASE WHEN EXCLUDED.country = 'IN' THEN org_business_profile.state_code END,
           updated_at = now(),
           updated_by = EXCLUDED.updated_by`,
        [orgId, country, currency, actorUuid],
      );
      // Country and currency codes are not personal data; record both sides.
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, 'org.region_updated', 'organization', $3, $4::jsonb)`,
        [orgId, actor, orgId, JSON.stringify({ from, to: { country, currency } })],
      );
      return { country, currency, changed: true };
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
