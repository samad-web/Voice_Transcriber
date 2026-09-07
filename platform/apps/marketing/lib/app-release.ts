import { API_ORIGIN } from "./site";

/**
 * What build the fleet is currently offered, read from `GET /v1/app/latest`.
 *
 * ── WHY THE ORIGIN IS OVERRIDABLE ────────────────────────────────────────
 *
 * `APP_API_ORIGIN` is set to `http://api:4000` in production so this call goes
 * over the compose network instead of out to the public hostname and back in
 * through nginx. The public URL would probably work - but "probably" depends on
 * the host hairpinning its own address, which is not a property worth betting a
 * page on when the internal name costs one line of YAML.
 *
 * It is NOT a secret and NOT a credential: this endpoint is unauthenticated by
 * design (the person installing has no login yet), so nothing here weakens the
 * rule that the marketing container never loads `.env.production`.
 */
const ORIGIN = process.env.APP_API_ORIGIN?.replace(/\/+$/, "") || API_ORIGIN;

export interface AppRelease {
  versionName: string;
  versionCode: number;
  sizeBytes: number;
  sha256: string;
  notes?: string;
}

/**
 * Null on ANY failure, and the page must render without it.
 *
 * The download button is a plain link to an endpoint that resolves the newest
 * build server-side, so it keeps working when this call does not. Version, size
 * and digest are confirmation, not function - and a page that 500s because the
 * API is briefly unreachable would take away the one thing a technician
 * standing in a shop actually needs.
 */
export async function latestRelease(): Promise<AppRelease | null> {
  try {
    const res = await fetch(`${ORIGIN}/v1/app/latest`, {
      cache: "no-store",
      // Shorter than any sensible page budget: this is an enhancement, and a
      // hanging upstream must not hold the response open.
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;

    const body = (await res.json()) as Partial<AppRelease>;
    // Validated rather than trusted. A 200 carrying an error page, or a future
    // rename of these fields, would otherwise render "undefined MB" next to a
    // download button - worse than showing nothing.
    if (typeof body.versionName !== "string" || typeof body.versionCode !== "number") return null;
    if (typeof body.sizeBytes !== "number" || typeof body.sha256 !== "string") return null;

    return {
      versionName: body.versionName,
      versionCode: body.versionCode,
      sizeBytes: body.sizeBytes,
      sha256: body.sha256,
      ...(typeof body.notes === "string" && body.notes ? { notes: body.notes } : {}),
    };
  } catch {
    return null;
  }
}

/** Megabytes the way a phone reports them - decimal, one place. */
export function formatSize(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
