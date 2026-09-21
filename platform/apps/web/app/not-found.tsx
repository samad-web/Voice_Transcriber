import type { Metadata } from "next";
import Link from "next/link";
import { Card, MonoLabel } from "@aura/ui";

/**
 * The 404. Rendered for an unmatched URL and for every `notFound()` call.
 *
 * There are 16 of those in this app - a deleted report, an invoice id that
 * isn't yours, a quotation that never existed - and until this file they all
 * landed on Next's built-in 404: black Helvetica on white, no theme, no
 * navigation, no sign it belonged to the same product. On a console that is
 * usually reached from a pasted link or a stale bookmark, that is a
 * comparatively common screen to have left undesigned.
 *
 * `robots: noindex` matches what apps/marketing already does for its own 404 -
 * the console is behind auth anyway, but a 404 is never a page worth indexing.
 *
 * Deliberately vague about WHY. A 404 here can mean "deleted", "never existed"
 * or "belongs to a workspace you're not in", and the last of those is the
 * reason this must not guess: confirming that a record exists but is somebody
 * else's is a tenant-isolation leak. `notFound()` is what the guards call
 * precisely so the three are indistinguishable, and this copy keeps them that
 * way.
 */
export const metadata: Metadata = {
  title: "Not found",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <Card elevated className="max-w-md space-y-4">
        <MonoLabel>Not found</MonoLabel>
        <p className="text-sm leading-relaxed text-text-muted">
          This page doesn&apos;t exist, or it isn&apos;t in the workspace you&apos;re signed in to.
          If you followed a link from somewhere, it may be out of date.
        </p>
        <p>
          <Link
            href="/"
            className="text-sm text-text-muted underline underline-offset-2 hover:text-text"
          >
            Go back to the start
          </Link>
        </p>
      </Card>
    </main>
  );
}
