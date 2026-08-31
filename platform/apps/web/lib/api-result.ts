/**
 * A typed answer from the API, instead of `T | null`.
 *
 * `apiGetAs` collapses every failure - 401, 403, 500, a dead socket, an empty
 * list - into `null`, so a page cannot tell "you may not see this" from "there
 * is nothing to see" from "the API is down". That is the mechanism behind the
 * "renders only the loading skeleton, HTTP 200" bug class (road map §2.9).
 *
 * This type is the replacement. Nothing is migrated to it yet on purpose: the
 * ~35 existing call sites keep the `T | null` shape (`apiGetAs` is now a thin
 * wrapper over `apiTry`), and pages move over one at a time in Stage 2 as each
 * grows its four real states - signed-out, no access, empty, broken.
 */

/**
 * Why a request did not produce data.
 *
 *   auth      - no/expired credentials (401). The session needs renewing.
 *   forbidden - authenticated but not permitted (403). A persona/role gate.
 *   notfound  - the resource does not exist (404). Distinct from "empty list".
 *   server    - the API answered but not with data: 5xx, and any other non-2xx
 *               (400/409/422…) plus an unparseable body. The transport worked;
 *               the response did not.
 *   network   - no HTTP response at all: API down, DNS, TLS, abort.
 */
export type ApiErrorKind = "auth" | "forbidden" | "notfound" | "server" | "network";

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: ApiErrorKind; status: number; message: string };

/** Status 0 is the sentinel for "never got an HTTP response" (`kind: network`). */
export const NO_HTTP_STATUS = 0;

/**
 * HTTP status → kind. Only the three statuses the console must render
 * differently get their own kind; everything else the API can answer with is
 * `server`, since from a page's point of view the distinction between a 422 and
 * a 500 is the same "we asked wrong or it broke" state.
 */
export function classifyStatus(status: number): ApiErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "notfound";
  return "server";
}

/**
 * Drop the reason and keep the legacy shape. This is the one place the old
 * "null means anything" behaviour is produced, so a call site that still uses
 * it is easy to find and migrate.
 */
export function unwrap<T>(result: ApiResult<T>): T | null {
  return result.ok ? result.data : null;
}
