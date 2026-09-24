import { z } from "zod";
import type { PrincipalRequest } from "./auth-principal";

/** `audit_log.actor_type`'s vocabulary for a principal-bearing request (see 0122's column comment). */
export type AuditActorType = "user" | "operator" | "system";

export interface AuditActor {
  type: AuditActorType;
  id: string;
}

/**
 * WHO did it, for an `audit_log` row written by a principal-bearing route.
 *
 * ── WHY THIS EXISTS (doc 31 §2 X9) ───────────────────────────────────────
 *
 * About sixty audit writers hard-coded `actor_type = 'user'` and passed
 * `req.principal?.userId ?? "dev-admin"`. The fallback never fired - every
 * route runs AdminKeyGuard first, which always sets a principal - but the
 * value it guarded against was the wrong one anyway: a platform operator
 * acting on a tenant through the operator console has no `users` row, so
 * `principal.userId` is the literal "admin-key", and every such write landed
 * as a USER called "admin-key". The one actor a customer most needs to name
 * in their own audit trail - the vendor - was the one it could not.
 *
 *  - A real person (the owner console proxying with `x-caller-user-id`, or a
 *    Bearer session): `user`, their users.id.
 *  - The operator console (bare admin key + `x-operator-email`): `operator`,
 *    their email - the form 0122's call-access trail already writes.
 *  - The bare key with nobody named (ops scripts, e2e harnesses): `system`,
 *    "admin-key" - honest about there being no person to name.
 */
export function auditActor(req: PrincipalRequest): AuditActor {
  const principal = req.principal;
  const userId = z.string().uuid().safeParse(principal?.userId);
  if (userId.success) return { type: "user", id: userId.data };
  if (principal?.operatorEmail) return { type: "operator", id: principal.operatorEmail };
  return { type: "system", id: principal?.userId || "admin-key" };
}
