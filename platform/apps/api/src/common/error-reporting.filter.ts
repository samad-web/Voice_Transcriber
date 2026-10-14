import { ArgumentsHost, Catch, HttpException, HttpStatus } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import { captureError } from "@aura/shared";
import type { PrincipalRequest } from "./auth-principal";

/**
 * Report the 500s, and only the 500s (doc 49 P2-A).
 *
 * ── WHAT IT DOES NOT CHANGE ─────────────────────────────────────────────────
 *
 * The response. It extends Nest's own `BaseExceptionFilter` and delegates to it
 * unchanged, so every status code, body and header is exactly what it was
 * before this file existed. The only new behaviour is a side effect on the way
 * past. A filter that is also an error handler is a filter that can turn a
 * handled 404 into a 500, and this one must never be able to.
 *
 * ── WHY ONLY 5xx ────────────────────────────────────────────────────────────
 *
 * A 4xx is the API working: a caller sent something wrong and was told so. The
 * API refuses thousands of them a day by design - every guard, every zod
 * parse, every 403 from the permission grid - and reporting those would bury
 * the one that matters under the ones that do not. A 5xx is the opposite: it is
 * always ours, and there is no such thing as an expected one.
 *
 * One deliberate exception: a 429. It is a 4xx, so it is not reported, which is
 * right - the rate limiter working is not an incident.
 *
 * ── WHAT IT ATTACHES, AND WHAT IT CANNOT ────────────────────────────────────
 *
 * The method and route TEMPLATE (`/v1/calls/:id`), never the resolved URL: a
 * resolved path carries ids, and a query string on this API can carry a phone
 * number (`?q=...`). The tenant goes on as an id. Nothing else - no body, no
 * headers, no params. `captureError`'s event is built from an allowlist, so
 * even a careless addition here cannot put a request body on the wire.
 */
@Catch()
export class ErrorReportingFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    try {
      const status =
        exception instanceof HttpException
          ? exception.getStatus()
          : HttpStatus.INTERNAL_SERVER_ERROR;

      if (status >= 500) {
        const http = host.switchToHttp();
        const req = http.getRequest<
          PrincipalRequest & { method?: string; route?: { path?: string }; originalUrl?: string }
        >();
        // `req.route.path` is the TEMPLATE express matched. When there is no
        // route (a 404 reaching here, or a parse failure before routing) there
        // is nothing safe to name, so nothing is named - the resolved URL is
        // never a fallback.
        const route = req?.route?.path ?? "unrouted";
        const where = `${req?.method ?? "?"} ${route}`;
        captureError(exception, {
          where,
          orgId: req?.principal?.orgId ?? null,
          // Groups by endpoint and error, so one broken route is one issue
          // however many callers hit it.
          fingerprint: `api:${where}:${exception instanceof Error ? exception.name : "unknown"}`,
        });
      }
    } catch {
      // Reporting is a side effect of handling an error. It must not be able to
      // become one, and it must not be able to stop the response below.
    }

    super.catch(exception, host);
  }
}
