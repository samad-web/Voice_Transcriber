import { BadRequestException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { checkPhone, splitPhone, toPhoneCountry, type CountryCode, type E164Phone } from "@aura/shared/dist/phone";

/**
 * The workspace's default country (org_business_profile.country, 0126) - what
 * a number typed without a "+" is read against. Run inside `withOrg`; an org
 * that never saved its profile reads the deployment default, India.
 */
export async function orgPhoneCountry(client: PoolClient, orgId: string): Promise<CountryCode> {
  const {
    rows: [row],
  } = await client.query<{ country: string | null }>(`SELECT country FROM org_business_profile WHERE org_id = $1`, [
    orgId,
  ]);
  return toPhoneCountry(row?.country);
}

/**
 * A phone number from a console form, as E.164 - or null when it was left
 * blank - or a 400 naming `field`.
 *
 * The console's PhoneInput already sends E.164 and refuses to submit anything
 * else, so for it this is a formality. It matters for the two callers that do
 * not go through that input: an older tab re-sending a value it loaded before
 * this rule existed ("98765 43210"), and a direct API call. Both are read
 * against the workspace's own country, and both are stored in the one
 * spelling, so the same person is never two numbers.
 */
export function consolePhone(
  raw: unknown,
  field: string,
  country: CountryCode,
  opts: { bareInternational?: boolean } = {},
): E164Phone | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw new BadRequestException([{ path: [field], message: "Enter a phone number." }]);
  const check = checkPhone(raw, country);
  if (check.ok) return check.empty ? null : check.e164;
  // WhatsApp's own spelling is the full international number without the "+"
  // ("919789961631"), and the WhatsApp forms asked for exactly that before
  // this input existed. Only where the caller says that convention applies.
  if (opts.bareInternational && /^\d{8,15}$/.test(raw.replace(/[\s()-]/g, ""))) {
    const retry = checkPhone(`+${raw.replace(/[\s()-]/g, "")}`, country);
    if (retry.ok && !retry.empty) return retry.e164;
    // Any calling code, not just the workspace's: a bare international
    // number already names its own country.
    const any = checkPhone(`+${raw.replace(/[\s()-]/g, "")}`, retryCountry(raw));
    if (any.ok && !any.empty) return any.e164;
  }
  throw new BadRequestException([{ path: [field], message: check.message }]);
}

/** The country a bare international number's own calling code names. */
function retryCountry(raw: string): CountryCode {
  return splitPhone(`+${raw.replace(/[^\d]/g, "")}`, "IN").country;
}

/** A WhatsApp number, E.164; bare international digits accepted. Never null - blank is refused. */
export function whatsappPhone(raw: string, field: string, country: CountryCode): E164Phone {
  const phone = consolePhone(raw, field, country, { bareInternational: true });
  if (!phone) throw new BadRequestException([{ path: [field], message: "Enter the WhatsApp number." }]);
  return phone;
}
