import { BadRequestException, Body, Controller, Get, Put, Req, UseGuards } from "@nestjs/common";
import type { PoolClient } from "pg";
import { BusinessProfileInput, businessProfileComplete, type BusinessProfile } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

interface ProfileRow {
  name: string;
  reporting_timezone: string;
  legal_name: string | null;
  trade_name: string | null;
  gstin: string | null;
  pan: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  postal_code: string | null;
  state_code: string | null;
  country: string | null;
  base_currency: string | null;
  fy_start_month: number | null;
  contact_email: string | null;
  contact_phone: string | null;
  website: string | null;
  updated_at: Date | null;
}

/** Column per input field, for the audit line's list of what changed. */
const FIELD_COLUMNS: Array<[keyof BusinessProfileInput, keyof ProfileRow]> = [
  ["displayName", "name"],
  ["legalName", "legal_name"],
  ["tradeName", "trade_name"],
  ["gstin", "gstin"],
  ["pan", "pan"],
  ["addressLine1", "address_line1"],
  ["addressLine2", "address_line2"],
  ["city", "city"],
  ["postalCode", "postal_code"],
  ["stateCode", "state_code"],
  ["country", "country"],
  ["baseCurrency", "base_currency"],
  ["fyStartMonth", "fy_start_month"],
  ["timezone", "reporting_timezone"],
  ["contactEmail", "contact_email"],
  ["contactPhone", "contact_phone"],
  ["website", "website"],
];

/**
 * The business profile as the form reads it. $1 is the org.
 *
 * A named constant so apps/api/verify-account-storage-setup.cjs can execute
 * this exact text against a real database - typecheck cannot see SQL.
 */
export const BUSINESS_PROFILE_SELECT_SQL = `SELECT o.name, o.reporting_timezone,
            p.legal_name, p.trade_name, p.gstin, p.pan,
            p.address_line1, p.address_line2, p.city, p.postal_code, p.state_code,
            p.country, p.base_currency, p.fy_start_month,
            p.contact_email, p.contact_phone, p.website, p.updated_at
       FROM organizations o
       LEFT JOIN org_business_profile p ON p.org_id = o.id
      WHERE o.id = $1`;

/**
 * The PUT's upsert. $1 org, $2-$16 the fields in column order, $17 updated_by.
 *
 * A named constant so apps/api/verify-account-storage-setup.cjs can execute
 * this exact text against a real database - typecheck cannot see SQL.
 */
export const BUSINESS_PROFILE_UPSERT_SQL = `INSERT INTO org_business_profile
             (org_id, legal_name, trade_name, gstin, pan, address_line1, address_line2, city,
              postal_code, state_code, country, base_currency, fy_start_month,
              contact_email, contact_phone, website, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
           ON CONFLICT (org_id) DO UPDATE SET
             legal_name = EXCLUDED.legal_name, trade_name = EXCLUDED.trade_name,
             gstin = EXCLUDED.gstin, pan = EXCLUDED.pan,
             address_line1 = EXCLUDED.address_line1, address_line2 = EXCLUDED.address_line2,
             city = EXCLUDED.city, postal_code = EXCLUDED.postal_code, state_code = EXCLUDED.state_code,
             country = EXCLUDED.country, base_currency = EXCLUDED.base_currency,
             fy_start_month = EXCLUDED.fy_start_month, contact_email = EXCLUDED.contact_email,
             contact_phone = EXCLUDED.contact_phone, website = EXCLUDED.website,
             updated_by = EXCLUDED.updated_by`;

async function readProfile(client: PoolClient, orgId: string): Promise<BusinessProfile | null> {
  // LEFT JOIN: an org that has never saved the form still has a display name
  // and a timezone, and the form opens pre-filled with the defaults below.
  const {
    rows: [row],
  } = await client.query<ProfileRow>(
    BUSINESS_PROFILE_SELECT_SQL,
    [orgId],
  );
  if (!row) return null;
  const country = row.country ?? "IN";
  return {
    displayName: row.name,
    legalName: row.legal_name,
    tradeName: row.trade_name,
    gstin: row.gstin,
    pan: row.pan,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    postalCode: row.postal_code,
    stateCode: row.state_code,
    country,
    baseCurrency: row.base_currency ?? "INR",
    fyStartMonth: row.fy_start_month ?? 4,
    timezone: row.reporting_timezone,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    website: row.website,
    updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
    complete: businessProfileComplete({ legalName: row.legal_name, country, stateCode: row.state_code }),
  };
}

/**
 * The tenant's business profile (doc 27 §4.3, migration 0126).
 *
 * ── OWNER EDITS, MANAGER READS ─────────────────────────────────────────────
 *
 * roles.ts describes a manager as "no billing or branding", and a business's
 * legal identity sits with those. So the read is owner+manager and the write
 * is owner alone - enforced by OwnerRoleGuard, which reads the persona from
 * `memberships` itself. NOT `@RequireOrgRole`: the admin key makes every
 * console request `platform_admin`, which that guard waves straight through.
 *
 * ── ONE TRANSACTION, THREE PLACES ──────────────────────────────────────────
 *
 * The display name and the timezone stay on `organizations`, where the
 * sidebar, the tenant switcher and every report already read them. The PUT
 * writes those two and upserts the profile row in one withOrg transaction, so
 * a timezone the database refuses (its trigger checks pg_timezone_names) rolls
 * the whole save back rather than half-applying it.
 *
 * The audit line lists the changed field NAMES, never their values: a GSTIN or
 * a phone number in audit_log is a copy of it nobody will ever think to erase.
 */
@Controller("owner/business-profile")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
export class BusinessProfileController {
  constructor(private readonly db: DbService) {}

  @Get()
  @RequireOwnerRole("owner", "manager")
  async get(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => ({ profile: await readProfile(client, orgId) }));
  }

  @Put()
  @RequireOwnerRole("owner")
  async put(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = BusinessProfileInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    const actor = req.principal?.userId ?? "unknown";
    const actorUuid = /^[0-9a-f-]{36}$/i.test(actor) ? actor : null;

    try {
      return await this.db.withOrg(orgId, async (client) => {
        const before = await readProfile(client, orgId);

        // COALESCE: the console's form no longer sends the zone - the Time
        // zone page owns it (Build docs/30, time-settings.controller.ts) - so
        // an absent zone means "leave it", never "clear it". An API caller
        // that does send one still sets it, through the same trigger.
        await client.query(
          `UPDATE organizations
              SET name = $2, reporting_timezone = COALESCE($3, reporting_timezone), updated_at = now()
            WHERE id = $1`,
          [orgId, p.displayName, p.timezone ?? null],
        );
        await client.query(
          BUSINESS_PROFILE_UPSERT_SQL,
          [
            orgId,
            p.legalName,
            p.tradeName,
            p.gstin,
            p.pan,
            p.addressLine1,
            p.addressLine2,
            p.city,
            p.postalCode,
            p.stateCode,
            p.country,
            p.baseCurrency,
            p.fyStartMonth,
            p.contactEmail,
            p.contactPhone,
            p.website,
            actorUuid,
          ],
        );

        const after = await readProfile(client, orgId);
        const changed = before && after
          ? FIELD_COLUMNS.map(([field]) => field).filter(
              (field) => (before as unknown as Record<string, unknown>)[field] !== (after as unknown as Record<string, unknown>)[field],
            )
          : FIELD_COLUMNS.map(([field]) => field);

        await client.query(
          `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
           VALUES ($1, 'user', $2, 'org.business_profile_updated', 'organization', $3, $4::jsonb)`,
          [orgId, actor, orgId, JSON.stringify({ fields: changed })],
        );
        return { profile: after };
      });
    } catch (err) {
      // The reporting_timezone trigger (0090) raises for a zone Postgres does
      // not know. That is the caller's input, not a server fault.
      if (err instanceof Error && /reporting_timezone/.test(err.message)) {
        throw new BadRequestException([{ path: ["timezone"], message: "Choose a timezone from the list." }]);
      }
      throw err;
    }
  }
}
