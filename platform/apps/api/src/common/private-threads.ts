import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { PrincipalRequest } from "./auth-principal";

/**
 * Private threads (migration 0125): a chat that arrived on somebody's own
 * WhatsApp number is theirs, and nobody else's - not a manager's, not the
 * owner's, not the platform operator's.
 *
 * ── WHY THIS IS SEPARATE FROM THE PERMISSION GRID ───────────────────────────
 *
 * `crm-scope.ts` narrows what a ROLE may see: "all threads" or "only my own".
 * An owner's grid says "all", and it should - for every shared thread. Privacy
 * is a different question with a different answer: no role, however senior,
 * sees a private thread that is not theirs. So both predicates apply, and this
 * one is never relaxed by a grant.
 *
 * ── WHO IS LOOKING ──────────────────────────────────────────────────────────
 *
 * The signed-in person behind the request, from `principal.userId`. A request
 * with no person - the bare admin key, the operator console - has no private
 * threads of its own, so it sees none of anybody's. The predicate is written so
 * a NULL viewer matches no private row (`x = NULL` is never true) rather than
 * relying on every caller remembering to special-case it.
 *
 * ── WHAT THIS DOES NOT PROTECT AGAINST ──────────────────────────────────────
 *
 * A holder of the raw ADMIN_API_KEY can name any user in `x-caller-user-id`
 * and read as them - the same limit migration 0122's header states for the
 * call-access gate. This closes every path the CONSOLES use; it does not make
 * the root credential less of a root credential.
 *
 * ── WHY A SPEC POLICES IT ───────────────────────────────────────────────────
 *
 * A read path that forgets the predicate is not a compile error, it is a
 * disclosure. `private-threads.spec.ts` scans every API source file that
 * queries `conversations` and fails unless it references this module or sits
 * on a reviewed allowlist with the reason it may read without it.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The person reading, or null for a caller with no seat of its own. */
export function threadViewerOf(req: Pick<PrincipalRequest, "principal">): string | null {
  const id = req.principal?.userId;
  return typeof id === "string" && UUID.test(id) ? id : null;
}

/** `@ThreadViewer() viewer: string | null` - see `threadViewerOf`. */
export const ThreadViewer = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | null =>
    threadViewerOf(context.switchToHttp().getRequest<PrincipalRequest>()),
);

/**
 * Stop a departing member's own number feeding this organisation.
 *
 * Removing somebody from a team deletes their membership, not their user, so
 * nothing cascades: without this their phone would go on delivering customer
 * messages into private threads that nobody can read any more. Disabling the
 * channel makes the webhook refuse it (`resolveChannel` only accepts
 * `active`). Their existing threads stay exactly as private as they were.
 *
 * Deliberately not a relay logout: that needs the relay to answer, and a
 * removal must not fail because a third party is down. The person can unlink
 * the device from their phone; the webhook has already stopped listening.
 */
export async function retirePersonalChannel(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  orgId: string,
  userId: string,
): Promise<void> {
  await client.query(
    `UPDATE messaging_channels
        SET status = 'disabled', updated_at = now()
      WHERE org_id = $1 AND owner_user_id = $2 AND status <> 'disabled'`,
    [orgId, userId],
  );
}

/**
 * The predicate: a shared thread, or a private one that is the viewer's own.
 *
 * `paramIndex` is where the caller puts the viewer (a uuid or null) in its
 * parameter list. The `::uuid` cast is what lets a NULL viewer bind at all.
 */
export function visibleThread(alias: string, paramIndex: number): string {
  const a = alias ? `${alias}.` : "";
  return `(${a}private_to_user_id IS NULL OR ${a}private_to_user_id = $${paramIndex}::uuid)`;
}
