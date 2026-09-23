import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { z } from "zod";
import { isCallAccessLive, callAccessBlockedReason } from "@aura/shared";
import type { PrincipalRequest } from "./auth-principal";
import { DbService } from "../db/db.service";
import { notify } from "../modules/notifications/notify";

export const CALL_CONTENT_KEY = "call_content";

/**
 * Marks a route as returning CALL CONTENT - a call row, its audio, its
 * transcript, its AI summary, its facts or its notes.
 *
 * Applied at the handler or the class. Every route carrying it is enumerated in
 * `guard-mounting.spec.ts`, which reflects over the real Nest metadata: adding
 * a new call route without this decorator moves a count there and fails, which
 * is the only reason this gate cannot quietly become a sieve.
 */
export const CallContent = () => SetMetadata(CALL_CONTENT_KEY, true);

/**
 * A tenant's recordings are not the vendor's to read (migration 0122).
 *
 * ── WHAT IT ENFORCES ──────────────────────────────────────────────────────
 *
 * On a route marked `@CallContent()`, in an org whose
 * `call_access_gate_enabled` is true, a PLATFORM OPERATOR is refused unless
 * they hold an approved grant whose window covers this instant. The refusal
 * itself raises the request and tells the org's administrator somebody
 * reached for their calls.
 *
 * ── WHO IS AN OPERATOR, EXACTLY ───────────────────────────────────────────
 *
 * The discriminator `OperatorOnlyGuard` already depends on, used the other way
 * round. Three shapes of caller arrive on these routes:
 *
 *   owner console   admin key + `x-caller-user-id` (a uuid)      -> NOT gated
 *   bearer session  no admin key, principal.userId is a uuid     -> NOT gated
 *   operator/script admin key, no caller -> userId = "admin-key" -> GATED
 *
 * The tenant's own people are deliberately untouched. What they may hear is
 * already decided by `recordings_listen`, the console persona and the
 * permission grid; a fourth axis over the same object is precisely what
 * permission-grid.md warns gives "why can't Priya hear this call" four
 * different answers.
 *
 * ── WHY A SCRIPT IS GATED TOO ─────────────────────────────────────────────
 *
 * A bare admin-key caller with no `x-operator-email` cannot be attributed to
 * anybody, so there is no grant to look up and no name to put on a request. It
 * is refused. That is the fail-closed direction and it is the honest one: if
 * we cannot say who is listening, the customer cannot have agreed to it. The
 * blast radius is small by construction - the gate is off for every org that
 * existed when 0122 ran, and on only where somebody turned it on.
 *
 * ── WHAT IT CANNOT DO ─────────────────────────────────────────────────────
 *
 * It does not constrain a holder of the raw ADMIN_API_KEY, who can forge
 * `x-caller-user-id` and present as the tenant's own owner, or write the grant
 * table directly. That credential is cross-tenant root by construction
 * (DEPLOYMENT.md §7). This closes the console path, puts every attempt in
 * front of the customer, and leaves a record. It is not a claim that the
 * vendor is technically incapable of listening, and it should never be sold
 * as one.
 */
@Injectable()
export class CallAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: DbService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const marked = this.reflector.getAllAndOverride<boolean | undefined>(CALL_CONTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!marked) return true;

    const req = context.switchToHttp().getRequest<PrincipalRequest>();
    const principal = req.principal;
    if (!principal) {
      // Guard order is wrong - this ran before AdminKeyGuard. Same reasoning
      // and status as TenantGuard's equivalent branch.
      throw new UnauthorizedException("authentication required");
    }

    // A real person inside the tenant. Not this guard's business.
    if (z.string().uuid().safeParse(principal.userId).success) return true;
    if (!principal.viaAdminKey) return true;

    const orgId = req.tenantOrgId;
    if (!orgId) {
      // `@CallContent()` on a route with no tenant pinned. A cross-tenant call
      // route would be a hole this guard could not reason about, so it is a
      // configuration error rather than something to wave through.
      throw new ForbiddenException("call content is not available across tenants");
    }

    const operatorEmail = principal.operatorEmail;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [org],
      } = await client.query<{ call_access_gate_enabled: boolean }>(
        `SELECT call_access_gate_enabled FROM organizations WHERE id = $1`,
        [orgId],
      );
      // An org we cannot read is not an org we may read calls out of.
      if (!org) throw new ForbiddenException("organization not found");
      if (!org.call_access_gate_enabled) return true;

      if (!operatorEmail) {
        // Nobody to attribute this to, so no request can be raised and no
        // grant can exist. Recorded as an anonymous attempt rather than
        // vanishing: "something with the root key reached for a customer's
        // calls" is exactly the line an audit needs to contain.
        await auditAttempt(client, orgId, null);
        throw new ForbiddenException(
          "this org's call recordings are gated by its administrator, and this request does not " +
            "say which operator is asking - use the operator console",
        );
      }

      const {
        rows: [grant],
      } = await client.query<{
        id: string;
        status: "pending" | "approved" | "denied" | "revoked";
        granted_start: Date | null;
        granted_end: Date | null;
      }>(
        // Only approved rows, newest window first. A person may hold an
        // expired grant and a live one at once - the live one must win, and
        // ordering by `granted_end` rather than `created_at` is what makes
        // that true when an older request was approved for a later window.
        `SELECT id, status, granted_start, granted_end
           FROM call_access_requests
          WHERE org_id = $1
            AND lower(btrim(requested_by_email)) = lower(btrim($2))
            AND status = 'approved'
          ORDER BY granted_end DESC
          LIMIT 1`,
        [orgId, operatorEmail],
      );

      if (
        grant &&
        isCallAccessLive(
          { status: grant.status, grantedStart: grant.granted_start, grantedEnd: grant.granted_end },
          new Date(),
        )
      ) {
        return true;
      }

      // Refused. Raise or refresh the request, and tell the administrator.
      const reason = callAccessBlockedReason(
        grant
          ? {
              status: grant.status,
              grantedStart: grant.granted_start,
              grantedEnd: grant.granted_end,
            }
          : null,
      );
      const pending = await raiseRequest(client, orgId, operatorEmail);
      await auditAttempt(client, orgId, operatorEmail);

      throw new ForbiddenException({
        statusCode: 403,
        error: "call_access_required",
        // The console renders this; a person reading it in a log should also be
        // able to act on it without opening the code.
        message:
          reason === "expired"
            ? "the access window granted for this org's call recordings has ended - a new request is with its administrator"
            : reason === "not_started"
              ? "the access window granted for this org's call recordings has not started yet"
              : reason === "denied"
                ? "this org's administrator declined access to its call recordings"
                : "this org's call recordings need its administrator's approval - a request is with them now",
        callAccess: {
          orgId,
          requestId: pending.id,
          status: pending.status,
          attempts: pending.attempts,
          blocked: reason,
        },
      });
    });
  }
}

type Queryable = {
  query: <R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: R[]; rowCount: number | null }>;
};

/**
 * Insert the pending request, or bump the one already there.
 *
 * The partial unique index in 0122 (`call_access_requests_one_open`) is what
 * makes this idempotent: one console page fans out to the list, the detail,
 * the audio and the transcript at once, and without the collapse the customer
 * would get four alerts for one glance. The FIRST insert notifies; the rest
 * only move `attempts` and `last_attempt_at`, which is the number the
 * administrator actually wants to see ("they have tried eleven times").
 */
async function raiseRequest(
  client: Queryable,
  orgId: string,
  operatorEmail: string,
): Promise<{ id: string; status: string; attempts: number }> {
  const {
    rows: [row],
  } = await client.query<{ id: string; status: string; attempts: number; inserted: boolean }>(
    `INSERT INTO call_access_requests
       (org_id, requested_by_email, reason, requested_start, requested_end)
     VALUES ($1, $2,
             'Opened from the operator console without a standing grant.',
             now(), now() + interval '24 hours')
     ON CONFLICT (org_id, lower(btrim(requested_by_email))) WHERE status = 'pending'
     DO UPDATE SET attempts        = call_access_requests.attempts + 1,
                   last_attempt_at = now(),
                   updated_at      = now()
     RETURNING id, status, attempts, (xmax = 0) AS inserted`,
    [orgId, operatorEmail],
  );

  if (row?.inserted) {
    await notifyAdministrators(client, orgId, operatorEmail, row.id);
  }
  return { id: row.id, status: row.status, attempts: row.attempts };
}

/**
 * Tell whoever is designated, or every owner when nobody is.
 *
 * Resolved at notify time rather than stored per request, so appointing a new
 * owner does not leave yesterday's alert addressed to somebody who has left.
 * `dedupeKey` is the request id: a sweep-shaped notification that must collapse
 * to one row per request, exactly what 0048's ON CONFLICT is for.
 */
async function notifyAdministrators(
  client: Queryable,
  orgId: string,
  operatorEmail: string,
  requestId: string,
): Promise<void> {
  const { rows: admins } = await client.query<{ user_id: string }>(
    `SELECT m.user_id
       FROM memberships m
       JOIN organizations o ON o.id = m.org_id
      WHERE m.org_id = $1
        AND m.status = 'active'
        AND (
          -- A named administrator, when there is one...
          (o.call_access_admin_user_id IS NOT NULL AND m.user_id = o.call_access_admin_user_id)
          -- ...otherwise everybody holding the owner persona.
          OR (o.call_access_admin_user_id IS NULL AND m.owner_role = 'owner')
        )`,
    [orgId],
  );

  for (const admin of admins) {
    await notify(client, orgId, {
      userId: admin.user_id,
      kind: "call_access_requested",
      title: "Someone requested access to your call recordings",
      body:
        `${operatorEmail} is asking to view this organisation's call logs, recordings and ` +
        `transcripts. Nobody outside your team can see them until you approve, and any approval ` +
        `ends at the time you set.`,
      // No basePath: the bell renders this through next/link, which adds
      // `/admin` itself. "/admin/owner/…" became "/admin/admin/owner/…", a 404
      // in production (doc 28 §4.4). stored-links.spec.ts now forbids the form.
      linkPath: "/owner/call-access",
      dedupeKey: `call_access:${requestId}`,
    });
  }
}

/**
 * The attempt, in the append-only ledger.
 *
 * Written whether or not a request row could be raised, and written for the
 * anonymous case especially - a refusal that left no trace would make the one
 * attempt worth investigating the one nobody can find.
 */
async function auditAttempt(
  client: Queryable,
  orgId: string,
  operatorEmail: string | null,
): Promise<void> {
  await client.query(
    // `org_id` (uuid) and `target_id` (text) are SEPARATE params even though
    // they carry the same value. Reusing one `$N` across two columns of
    // different types makes Postgres infer a single type for it and throw
    // 42P08 "inconsistent types" - a runtime-only failure, on the error path,
    // which is the worst possible place to find one.
    `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
     VALUES ($1, 'operator', $2, 'call_access.denied', 'organization', $3, $4)`,
    [
      orgId,
      operatorEmail ?? "unattributed-admin-key",
      orgId,
      JSON.stringify({ operatorEmail, at: new Date().toISOString() }),
    ],
  );
}
