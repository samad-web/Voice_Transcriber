"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button, Card, MonoLabel } from "@aura/ui";

/**
 * The route-level error boundary. Nothing caught this, so React unmounted the
 * segment and handed it here.
 *
 * ── WHY THIS FILE HAD TO EXIST ─────────────────────────────────────────────
 *
 * There was no `error.tsx` anywhere in this app. Every uncaught throw - a
 * `.map` on an undefined field, a bad date, a server action rejecting - fell
 * through to Next's built-in error page: unstyled, unbranded, no theme, no way
 * back, and in production the text "Application error: a server-side exception
 * has occurred" with no further detail. A console with a design system this
 * carefully specified had no design at all for its most alarming screen.
 *
 * It sits at `app/`, above the route groups, so (owner), (platform), (admin)
 * and (dashboard) all inherit one. A group that wants a different treatment can
 * add its own `error.tsx`; none needs to today.
 *
 * ── WHAT IT DELIBERATELY DOES NOT SHOW ─────────────────────────────────────
 *
 * Not `error.message`. In a production build React replaces the real message
 * on a server-render error with a generic string anyway, so printing it would
 * show either nothing useful or, worse, an internal detail from a client-side
 * throw. `digest` is the honest identifier: Next hashes the real error and logs
 * it server-side under the same value, so quoting it is what actually lets
 * somebody find the stack. It is only present for server errors, hence the
 * conditional.
 *
 * `reset()` re-renders the segment. Worth offering because a good share of
 * these are transient (a failed fetch during render), and worth pairing with a
 * link home because the rest are not, and a button that keeps failing with no
 * other exit is its own trap.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The browser console is the only place a client-side throw is recoverable
    // from once React has swapped in this boundary. Server errors are already
    // in the server log under the same digest.
    console.error("[route error]", error);
  }, [error]);

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <Card elevated className="max-w-md space-y-4">
        <MonoLabel>Something broke</MonoLabel>
        <p className="text-sm leading-relaxed text-text-muted">
          This page stopped part-way through loading. Nothing you were looking at was saved or
          changed by this.
        </p>

        {error.digest ? (
          <p className="text-sm leading-relaxed text-text-muted">
            If you report it, quote this reference:{" "}
            <code className="font-mono text-xs text-text">{error.digest}</code>
          </p>
        ) : null}

        {/* A Button for the action, a plain link for the exit. The kit has no
            link-as-button primitive and this is not the place to invent one. */}
        <div className="flex flex-wrap items-center gap-4">
          <Button type="button" onClick={reset}>
            Try again
          </Button>
          <Link href="/" className="text-sm text-text-muted underline underline-offset-2 hover:text-text">
            Go back to the start
          </Link>
        </div>
      </Card>
    </main>
  );
}
