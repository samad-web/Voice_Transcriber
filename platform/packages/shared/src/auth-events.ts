import { z } from "zod";

/**
 * Sign-in history (doc 27 §5, migration 0127's `auth_events`).
 *
 * Recorded by the web tier at the moments it already controls - the sign-in
 * and sign-out server actions, the password change - rather than read out of
 * GoTrue's `auth.audit_log_entries`. The self-host README's rule is that
 * nothing couples to `auth.*` by SQL, local dev has no `auth` schema at all,
 * and GoTrue's rows cannot say which console or which workspace a sign-in went
 * to, which is the one thing a person reading this page wants to know.
 */
export const AuthEventKind = z.enum([
  "sign_in",
  "sign_in_failed",
  "sign_out",
  "sign_out_all",
  "password_changed",
]);
export type AuthEventKind = z.infer<typeof AuthEventKind>;

export const AUTH_EVENT_LABELS: Record<AuthEventKind, string> = {
  sign_in: "Signed in",
  sign_in_failed: "Failed sign-in",
  sign_out: "Signed out",
  sign_out_all: "Signed out everywhere",
  password_changed: "Password changed",
};

export const AuthEventConsole = z.enum(["owner", "operator"]);
export type AuthEventConsole = z.infer<typeof AuthEventConsole>;

/**
 * POST /v1/account/auth-events.
 *
 * NO user id in here, on purpose. Whose event it is comes from the
 * `x-caller-auth-id` header the Next server sets from a verified `getClaims()`
 * - never from a body a form could have shaped. The one exception is a failed
 * sign-in, which has no session and so no claims: it carries the email that was
 * typed, and the API resolves it to an account by a local SELECT (no GoTrue
 * call), recording nothing when it matches nobody.
 */
export const AuthEventInput = z.object({
  kind: AuthEventKind,
  /** claims.session_id, so Login activity can mark "This session". */
  sessionId: z.string().uuid().nullable(),
  console: AuthEventConsole.nullable(),
  /** The workspace whose console was entered. Display only - not a boundary. */
  orgId: z.string().uuid().nullable(),
  ip: z.string().max(64).nullable(),
  userAgent: z.string().nullable(),
  /** sign_in_failed only: the address that was typed. */
  email: z.string().trim().toLowerCase().email().max(320).nullable(),
});
export type AuthEventInput = z.infer<typeof AuthEventInput>;

/** The raw User-Agent is kept, but never more than this. */
export const AUTH_EVENT_UA_MAX = 512;

/** How far back Login activity looks, and how long the rows are kept. */
export const LOGIN_ACTIVITY_DAYS = 90;
export const AUTH_EVENT_RETENTION_DAYS = 180;
export const LOGIN_ACTIVITY_PAGE_SIZE = 50;
/** A password spray must not be able to fill the table: per account, per hour. */
export const FAILED_SIGN_IN_CAP_PER_HOUR = 20;

/** One row of GET /v1/account/login-activity. */
export interface LoginActivityRow {
  id: string;
  kind: AuthEventKind;
  sessionId: string | null;
  console: AuthEventConsole | null;
  orgName: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface LoginActivityPage {
  rows: LoginActivityRow[];
  /** Opaque keyset cursor for the next (older) page, or null at the end. */
  next: string | null;
}

/**
 * The keyset cursor: `(created_at, id)` of the last row shown, as one opaque
 * string. Keyset rather than OFFSET because a new sign-in arriving while
 * somebody pages would shift every OFFSET page by one row.
 */
export function encodeActivityCursor(createdAt: string, id: string): string {
  return `${createdAt}_${id}`;
}

export function decodeActivityCursor(cursor: string | null | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  const at = cursor.lastIndexOf("_");
  if (at <= 0) return null;
  const createdAt = cursor.slice(0, at);
  const id = cursor.slice(at + 1);
  if (!/^\d+$/.test(id) || Number.isNaN(Date.parse(createdAt))) return null;
  return { createdAt, id };
}

/** "Owner console · Acme Realty" / "Operator console". */
export function describeAuthEventWhere(console: AuthEventConsole | null, orgName: string | null): string {
  if (console === "operator") return "Operator console";
  if (console === "owner") return orgName ? `Owner console · ${orgName}` : "Owner console";
  return "—";
}
