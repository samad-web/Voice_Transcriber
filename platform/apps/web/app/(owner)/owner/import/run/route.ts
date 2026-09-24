import { NextResponse } from "next/server";
import { IMPORT_RUN_MAX_BYTES } from "@aura/shared";
import { getOwner } from "@/lib/owner-context";
import { API_URL, orgHeaders } from "@/lib/server-api";
import type { ImportJob } from "../actions";

/**
 * "Start import" - the one import call that carries the rows.
 *
 * ── WHY A ROUTE HANDLER AND NOT A SERVER ACTION (X7) ────────────────────────
 *
 * It was `runImportAction`, and a Server Action's body is capped at 1 MB
 * (`serverActions.bodySizeLimit`), which a 5,000-row contact file passes
 * easily - the import failed well under the row limit the wizard advertises.
 * Raising that cap is a GLOBAL setting in next.config.ts: every action on the
 * console would accept 8 MB to let this one do so. A route handler has no such
 * cap of its own, so the larger limit lives here, on this one path, and is
 * enforced here.
 *
 * The cap is `IMPORT_RUN_MAX_BYTES` (8 MB), the same number the API's
 * route-scoped parser enforces, and below the 10 MB at which Next's middleware
 * silently TRUNCATES a body it clones (`middlewareClientMaxBodySize`) - past
 * that this handler would receive broken JSON instead of a size it could name.
 *
 * ── WHAT A SERVER ACTION DID FOR FREE, DONE BY HAND ─────────────────────────
 *
 *  - The tenant, persona and user come from the session (`getOwner`), never
 *    the request - same as `ownerHeaders()` in every action file. The API's
 *    OwnerRoleGuard then decides whether this persona may import at all.
 *  - CSRF. A Server Action refuses a POST whose Origin is not this host; this
 *    does the same check, and also requires `application/json`, which a
 *    cross-site form cannot send without a CORS preflight nothing here answers.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 });
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 415 });
  }
  // Refused before reading when the browser said how big it is - it always
  // does for a fetch with a string body.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > IMPORT_RUN_MAX_BYTES) return tooLarge();

  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Not signed in as an instance owner" }, { status: 401 });
  }

  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > IMPORT_RUN_MAX_BYTES) return tooLarge();
  try {
    JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "The import could not be read. Try again, or split the file." }, { status: 400 });
  }

  let res: Response;
  try {
    // Forwarded as the bytes that arrived: the API validates the shape itself
    // (zod), and re-serialising several MB only to send the same thing costs
    // memory and time for nothing.
    res = await fetch(`${API_URL}/v1/import/run`, {
      method: "POST",
      headers: orgHeaders(owner.membership.orgId, { ownerRole: owner.membership.ownerRole, userId: owner.userId }),
      cache: "no-store",
      body,
    });
  } catch {
    return NextResponse.json({ error: "API unreachable" }, { status: 502 });
  }

  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    const message = (detail as { message?: unknown })?.message ?? detail;
    return NextResponse.json(
      { error: typeof message === "string" ? message : `API ${res.status}` },
      { status: res.status === 413 ? 413 : res.status >= 500 ? 502 : res.status },
    );
  }
  const data = (await res.json()) as { job: ImportJob };
  return NextResponse.json({ job: data.job }, { headers: { "cache-control": "no-store" } });
}

function tooLarge() {
  const mb = Math.round(IMPORT_RUN_MAX_BYTES / 1024 / 1024);
  return NextResponse.json(
    { error: `This import is larger than ${mb} MB. Split the file and import it in batches.` },
    { status: 413 },
  );
}

/**
 * The Origin check a Server Action makes: the browser's Origin must name the
 * host this request arrived on. `x-forwarded-host` first, because behind nginx
 * `host` is the upstream's address - the same order Next's own action check
 * uses, which is known to hold in production.
 */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host.split(",")[0].trim();
  } catch {
    return false;
  }
}
