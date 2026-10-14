import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import { tap } from "rxjs/operators";
import { DbService } from "../db/db.service";
import type { PrincipalRequest } from "./auth-principal";

/**
 * WHO LOOKED AT WHOSE TENANT (doc 49 P5-D).
 *
 * ── THE GAP ─────────────────────────────────────────────────────────────────
 *
 * `ADMIN_API_KEY` crosses tenant boundaries by design: `x-org-id` selects the
 * tenant and is trusted. There was no record of its use. So the question "did
 * anyone read that customer's calls, and who" had no answer - not a bad answer,
 * none - and that is the question a customer asks after an incident, and the
 * one a DPA makes us able to answer.
 *
 * ── WHY NOT EVERY ADMIN-KEY REQUEST ─────────────────────────────────────────
 *
 * P5-D says "every admin-key request that names an x-org-id". Taken literally
 * that is every console page load, every poll, every realtime re-check - tens
 * of thousands of rows a day, all of them a tenant's own staff using their own
 * console through a web tier that happens to hold the key. The signal anybody
 * would actually look for drowns in it, which is the same failure as filing
 * 2,792 tickets for one vendor outage.
 *
 * So two things are logged, and nothing else:
 *
 *   1. A PLATFORM OPERATOR touching a tenant. `x-operator-email` is set only
 *      when the caller is an operator rather than a member of the tenant, so
 *      its presence IS the cross-tenant condition. This is the row somebody
 *      wants.
 *   2. Any MUTATION on the admin-key path that names an org, operator or not.
 *      A write is rare, consequential, and attributable, and "who changed this
 *      tenant's settings" is as real a question as "who read their calls".
 *
 * A tenant member's ordinary GET is not logged here. It is not cross-tenant -
 * the web tier resolved that org from their own verified session - and the
 * reads that genuinely need a trail already write their own rows
 * (`recording.playback`, the call-access gate, the erasure receipt).
 *
 * ── DE-DUPLICATED, FOR THE SAME REASON ──────────────────────────────────────
 *
 * One row per (actor, org, action) per hour. An operator paging through a
 * tenant's call list would otherwise write forty identical rows, and a trail
 * nobody can read is not a trail. The hour bucket keeps "this operator was in
 * this tenant this afternoon" answerable, which is the question; "they pressed
 * next 40 times" is not.
 *
 * ── IT MUST NEVER FAIL A REQUEST ────────────────────────────────────────────
 *
 * Written AFTER the handler succeeds, outside the handler's transaction, and
 * every error is swallowed. An audit trail that can turn a working request into
 * a 500 is a liability rather than a control - and one that logs attempts that
 * then failed is actively misleading.
 */
@Injectable()
export class CrossTenantAuditInterceptor implements NestInterceptor {
  constructor(private readonly db: DbService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest<
      PrincipalRequest & { method?: string; route?: { path?: string } }
    >();

    return next.handle().pipe(
      tap({
        next: () => void this.record(req),
        // Deliberately only on success. A 403 that was correctly refused is not
        // access, and recording it as access would make the trail read as a
        // breach every time a guard did its job.
        error: () => undefined,
      }),
    );
  }

  private async record(
    req: PrincipalRequest & { method?: string; route?: { path?: string } },
  ): Promise<void> {
    try {
      const principal = req.principal;
      if (!principal?.viaAdminKey) return;

      const orgId = principal.orgId;
      // The cross-tenant admin endpoints legitimately name no org at all;
      // there is no tenant for the row to belong to, and `audit_log.org_id` is
      // NOT NULL.
      if (!orgId) return;

      const method = (req.method ?? "GET").toUpperCase();
      const mutating = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
      const operator = principal.operatorEmail;
      if (!operator && !mutating) return;

      // The route TEMPLATE, never the resolved path: a resolved path carries
      // ids, and a query string on this API can carry a phone number.
      const route = req.route?.path ?? "unrouted";
      const action = operator ? "operator.cross_tenant_access" : "admin_key.write";
      const actorId = operator ?? principal.userId ?? "admin-key";

      await this.db.adminPool().query(
        // ── THE 42P08 TRAP ────────────────────────────────────────────────
        //
        // `org_id` is uuid and `target_id` is text. Reusing ONE placeholder
        // for both - which looks obviously correct, since it is the same value
        // - fails at PREPARE with "inconsistent types deduced for parameter",
        // so the statement never runs and the route 500s on every call
        // forever. It has bitten this codebase four times.
        // `audit-param-types.spec.ts` is the gate; $2 and $6 here are
        // deliberately separate parameters carrying the same string.
        //
        // The de-dupe is in the WHERE, not in application code: two requests
        // in the same second would both pass a read-then-write check.
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         SELECT $1::uuid, $3, $4, $5, 'organization', $6::text, $7::jsonb
          WHERE NOT EXISTS (
            SELECT 1 FROM audit_log
             WHERE org_id = $1::uuid
               AND actor_id = $4
               AND action = $5
               AND meta->>'route' = $2
               AND created_at > now() - interval '1 hour'
          )`,
        [
          orgId,
          route,
          operator ? "operator" : "system",
          actorId,
          action,
          orgId,
          JSON.stringify({ route, method }),
        ],
      );
    } catch (err) {
      // Swallowed, and logged once per occurrence rather than thrown. The
      // request has already succeeded by the time this runs; failing it now
      // would mean the audit trail could take the product down, which is the
      // same trade `initErrorReporting` refuses to make.
      console.error("cross-tenant audit write failed:", err);
    }
  }
}
