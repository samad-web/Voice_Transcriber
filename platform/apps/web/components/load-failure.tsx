import Link from "next/link";
import { ErrorBanner } from "@aura/ui";
import type { ApiErrorKind, ApiResult } from "@/lib/api-result";

/**
 * "This panel could not load."
 *
 * ── WHY IT REPLACES 51 HAND-WRITTEN CARDS ──────────────────────────────────
 *
 * Every page under /owner had grown its own copy of
 * `<Card><MonoLabel>Data unavailable</MonoLabel><p>The platform API did not
 * answer…</p></Card>`. Fifty-one of them, none carrying `role="alert"`, none
 * able to say what went wrong - and the operator console's variant told the
 * reader to run `pnpm --filter @aura/api dev`, a developer instruction shipped
 * to production.
 *
 * The duplication was the visible problem; the reason it could not be fixed in
 * place is the real one. Those cards render from `ownerGet`'s `null`, which is
 * all that survives of a 403, a 500 and a dead socket alike - so no rewording
 * could have made them more truthful. `ownerTry` (lib/owner-context.ts) keeps
 * the reason, and this component is what spends it.
 *
 * ── WHY ErrorBanner AND NOT A Card ─────────────────────────────────────────
 *
 * A failed load is a failure, so it takes the surface the system already
 * reserves for one: `role="alert"`, announced once, and the error tone - which
 * in this console is ORANGE, not red. Red means MISSED (packages/ui/src/
 * state.tsx), and a failed panel painted red would compete with the number an
 * owner opens this console to find. Wrapping ErrorBanner rather than restyling
 * a Card also means this can never drift from the "Error" chip beside it.
 *
 * ── WHY THE SERVER'S OWN MESSAGE IS SHOWN ──────────────────────────────────
 *
 * Only for `server` and `network`, the two kinds where the text is actionable
 * ("connect ECONNREFUSED", "column leads.score does not exist") and the reader
 * is an administrator of their own workspace. For `auth`/`forbidden`/`notfound`
 * the kind already says everything true, and the API's own phrasing there tends
 * to be worse than ours. This matches what 246 `useAlert` call sites already do
 * with `res.error`, so the console does not keep two policies on that question.
 */

/** The headline per kind. Second person, no jargon, never blames the reader. */
function headline(kind: ApiErrorKind, what: string): string {
  switch (kind) {
    case "auth":
      return "Your session has ended";
    case "forbidden":
      return `You don't have access to ${what}`;
    case "notfound":
      return `${what} no longer exists`;
    case "network":
      return `Couldn't reach the server`;
    case "server":
      return `Couldn't load ${what}`;
  }
}

/** What the reader can actually do about it. Omitted when there is nothing. */
function remedy(kind: ApiErrorKind): string | null {
  switch (kind) {
    case "auth":
      return null; // the sign-in link below is the remedy
    case "forbidden":
      return "Ask an owner of this workspace to grant you access.";
    case "notfound":
      return "It may have been deleted. Check the list it was in.";
    case "network":
      return "Check your connection and try again. If it persists, contact your provider.";
    case "server":
      return "Try again in a moment. If it persists, contact your provider with the detail above.";
  }
}

export function LoadFailure({
  /** The thing that failed to load, lowercase, as it reads mid-sentence: "contacts". */
  what,
  failure,
}: {
  what: string;
  /** The failed arm of an ApiResult. Pass the result itself and narrow at the call site. */
  failure: Extract<ApiResult<unknown>, { ok: false }>;
}) {
  const detail =
    failure.kind === "server" || failure.kind === "network" ? failure.message.trim() : "";
  const help = remedy(failure.kind);

  return (
    <ErrorBanner>
      <p className="font-medium">{headline(failure.kind, what)}</p>

      {detail ? (
        // `break-words`: an unparsed HTML error page or a long driver message
        // has no spaces to wrap at and would otherwise widen the whole banner.
        <p className="mt-1 break-words">
          {detail}
          {/* The status is the one fact that makes a support conversation short.
              Suppressed for `network`, where it is the 0 sentinel and means
              "there was no response", which the headline already said. */}
          {failure.status > 0 ? ` (HTTP ${failure.status})` : null}
        </p>
      ) : null}

      {help ? <p className="mt-1">{help}</p> : null}

      {failure.kind === "auth" ? (
        <p className="mt-1">
          <Link href="/login" className="underline underline-offset-2">
            Sign in again
          </Link>
        </p>
      ) : null}
    </ErrorBanner>
  );
}
