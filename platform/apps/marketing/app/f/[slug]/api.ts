import type { PublicWebForm } from "@aura/shared/dist/web-forms";
import { API_ORIGIN } from "@/lib/site";

/**
 * How the hosted form talks to the API. SERVER ONLY.
 *
 * ── WHY THIS APP CANNOT READ THE FORM OUT OF THE DATABASE ──────────────────
 *
 * `lib/funnel/db.ts` connects as `aura_marketing`, which holds USAGE on the
 * `marketing` schema and nothing else - deliberately, and its header spends a
 * paragraph on why there is no fallback to a role that can reach tenant
 * tables. `web_forms` is in `public`, RLS-forced, and granted to `aura_app`.
 *
 * So this app does what the /app install page already does for the release
 * manifest: it asks the API over HTTP. That is not a workaround, it is the
 * boundary working. The container that answers unauthenticated traffic from
 * the open internet holds no credential that reaches a customer's leads.
 *
 * ── AND WHY THE SUBMIT GOES THROUGH HERE TOO ───────────────────────────────
 *
 * The browser could post straight at the API. It must not, for two reasons:
 * the form's intake token would have to be in the page for that to work, and
 * the API would see every tenant's submissions arriving from one address and
 * throttle them into one bucket. Proxying costs one hop and fixes both - see
 * `submit/route.ts` on the forwarded client address.
 */

if (typeof window !== "undefined") {
  throw new Error("app/f/[slug]/api is server-only and must never be imported by a Client Component");
}

/**
 * `APP_API_ORIGIN` is `http://api:4000` in production so this stays on the
 * compose network instead of going out to the public hostname and back in
 * through nginx - the same reason, and the same variable, `lib/app-release.ts`
 * uses. It is not a credential: the two routes below are unauthenticated by
 * design.
 */
const ORIGIN = process.env.APP_API_ORIGIN?.replace(/\/+$/u, "") || API_ORIGIN;

/** A page render waits on this, so it is short. */
const READ_TIMEOUT_MS = 5000;
/** A submit is a person pressing a button; a slow one beats a lost enquiry. */
const WRITE_TIMEOUT_MS = 12_000;

export type FormLookup =
  | { state: "ok"; form: PublicWebForm }
  /** No such slug, or it is a draft, or it has closed. Indistinguishable. */
  | { state: "missing" }
  /** The API said no, or said nothing. Different page, different words. */
  | { state: "unavailable" };

export async function loadForm(slug: string): Promise<FormLookup> {
  try {
    const res = await fetch(`${ORIGIN}/v1/public/forms/${encodeURIComponent(slug)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (res.status === 404 || res.status === 400) return { state: "missing" };
    if (!res.ok) return { state: "unavailable" };
    const body = (await res.json()) as Partial<PublicWebForm>;
    // Validated rather than trusted, the same way `latestRelease` validates
    // the manifest: a 200 carrying an error page would otherwise render a form
    // with no fields and a submit button that does nothing.
    if (typeof body.slug !== "string" || !body.definition || !Array.isArray(body.definition.fields)) {
      return { state: "unavailable" };
    }
    return { state: "ok", form: body as PublicWebForm };
  } catch {
    return { state: "unavailable" };
  }
}

export interface SubmitOutcome {
  status: number;
  body: unknown;
}

/**
 * Forward one submission.
 *
 * `x-forwarded-for` carries the VISITOR'S address, not this container's, and
 * that is load-bearing rather than tidy: `main.ts` sets `trust proxy` on the
 * API, so this is what `req.ip` resolves to and what the 300/min throttle
 * counts. Drop it and every tenant's forms share one bucket - a busy afternoon
 * on one form would throttle everybody else's.
 */
export async function forwardSubmission(
  slug: string,
  payload: unknown,
  forwardedFor: string | null,
): Promise<SubmitOutcome> {
  const res = await fetch(`${ORIGIN}/v1/public/forms/${encodeURIComponent(slug)}`, {
    method: "POST",
    cache: "no-store",
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    headers: {
      "content-type": "application/json",
      ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
