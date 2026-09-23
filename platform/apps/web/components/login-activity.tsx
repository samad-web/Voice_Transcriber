import Link from "next/link";
import {
  AUTH_EVENT_LABELS,
  LOGIN_ACTIVITY_DAYS,
  describeAuthEventWhere,
  describeUserAgent,
  type LoginActivityPage,
} from "@aura/shared";
import { StatusChip, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "@aura/ui";
import { LoadFailure } from "@/components/load-failure";
import { LogOutEverywhereButton } from "@/components/log-out-everywhere";
import { classifyStatus, NO_HTTP_STATUS, type ApiResult } from "@/lib/api-result";
import { API_URL, personHeaders } from "@/lib/server-api";

/**
 * The deploy that started recording (doc 27 §5.4's empty state). History from
 * before it does not exist, and the page says so rather than implying the
 * person has never signed in. Update with the deploy.
 */
export const LOGIN_ACTIVITY_SINCE = "22 September 2026";

/** GET /v1/account/login-activity for ONE person, named by their verified subject. */
export async function fetchLoginActivity(
  authUserId: string,
  cursor: string | null,
): Promise<ApiResult<LoginActivityPage>> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  try {
    const res = await fetch(`${API_URL}/v1/account/login-activity${qs}`, {
      headers: personHeaders(authUserId),
      cache: "no-store",
    });
    if (!res.ok) {
      const message = (await res.text().catch(() => "")).slice(0, 300) || res.statusText;
      return { ok: false, kind: classifyStatus(res.status), status: res.status, message };
    }
    return { ok: true, data: (await res.json()) as LoginActivityPage };
  } catch (err) {
    return {
      ok: false,
      kind: "network",
      status: NO_HTTP_STATUS,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function relative(iso: string, now: number): string {
  const mins = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "Yesterday" : `${days} days ago`;
}

/**
 * The Login activity table (doc 27 §5.4), shared by both consoles.
 *
 * Grey throughout, except a FAILED sign-in, which is an error state and wears
 * the orange `danger` chip. "This session" is a grey chip on the row whose
 * session id is the one this browser holds.
 */
export async function LoginActivity({
  authUserId,
  currentSessionId,
  cursor,
  basePath,
  timeZone,
}: {
  /** From the verified session. Null only with auth unconfigured (local dev). */
  authUserId: string | null;
  currentSessionId: string | null;
  cursor: string | null;
  /** This page's own path, for the "Older" link. */
  basePath: string;
  /** The viewer's workspace reporting_timezone; IST when there is none. */
  timeZone: string;
}) {
  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-text-muted">
        Showing the last {LOGIN_ACTIVITY_DAYS} days, newest first.
      </p>
      <LogOutEverywhereButton />
    </div>
  );

  if (!authUserId) {
    return (
      <>
        {header}
        <p className="rounded-xl border border-border bg-surface px-4 py-6 text-sm text-text-muted">
          Sign-in is not configured on this console, so there is no sign-in history to show.
        </p>
      </>
    );
  }

  const result = await fetchLoginActivity(authUserId, cursor);
  if (!result.ok) {
    return (
      <>
        {header}
        <LoadFailure what="your sign-in history" failure={result} />
      </>
    );
  }

  const { rows, next } = result.data;
  if (rows.length === 0 && !cursor) {
    return (
      <>
        {header}
        <p className="rounded-xl border border-border bg-surface px-4 py-6 text-sm text-text-muted">
          No sign-ins recorded yet. Activity is recorded from {LOGIN_ACTIVITY_SINCE} onward.
        </p>
      </>
    );
  }

  // Rendered on the server, so "now" is one instant for the whole table.
  const now = Date.now();
  const exact = new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });

  return (
    <>
      {header}
      <Table caption="Sign-in history">
        <TableHead>
          <tr>
            <TableHeaderCell>When</TableHeaderCell>
            <TableHeaderCell>Event</TableHeaderCell>
            <TableHeaderCell>Device</TableHeaderCell>
            <TableHeaderCell>IP</TableHeaderCell>
            <TableHeaderCell>Where</TableHeaderCell>
          </tr>
        </TableHead>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="whitespace-nowrap">
                <time dateTime={row.createdAt} title={exact.format(new Date(row.createdAt))}>
                  {relative(row.createdAt, now)}
                </time>
              </TableCell>
              <TableCell>
                <span className="flex flex-wrap items-center gap-2">
                  {row.kind === "sign_in_failed" ? (
                    <StatusChip tone="danger">{AUTH_EVENT_LABELS[row.kind]}</StatusChip>
                  ) : (
                    <span className="text-text">{AUTH_EVENT_LABELS[row.kind]}</span>
                  )}
                  {currentSessionId && row.sessionId === currentSessionId && row.kind === "sign_in" ? (
                    <StatusChip tone="muted">This session</StatusChip>
                  ) : null}
                </span>
              </TableCell>
              <TableCell className="whitespace-nowrap text-text-muted">{describeUserAgent(row.userAgent)}</TableCell>
              <TableCell className="whitespace-nowrap font-mono text-xs text-text-muted">{row.ip ?? "—"}</TableCell>
              <TableCell className="text-text-muted">{describeAuthEventWhere(row.console, row.orgName)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {cursor || next ? (
        <div className="flex gap-3 text-sm">
          {cursor ? (
            <Link href={basePath} className="font-medium text-text underline underline-offset-2">
              Newest
            </Link>
          ) : null}
          {next ? (
            <Link
              href={`${basePath}?cursor=${encodeURIComponent(next)}`}
              className="font-medium text-text underline underline-offset-2"
            >
              Older
            </Link>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
