import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { AUTH_ENABLED } from "@/lib/supabase/config";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in — Aura Platform" };

const HIGHLIGHTS = [
  "Call capture across your enrolled device fleet",
  "Diarized transcripts with AI intent + sentiment",
  "CRM dispatch, retention policy and audit trail",
];

/**
 * Sign-in page. Single column on phones; the brand panel appears alongside the
 * form from lg up rather than stacking on top of it, so the form stays above
 * the fold on short viewports.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <main className="flex min-h-dvh items-center justify-center p-4 sm:p-6">
      <div className="grid w-full max-w-md grid-cols-1 items-center gap-6 lg:max-w-4xl lg:grid-cols-2 lg:gap-8">
        {/* Brand panel — desktop only; phones get the compact header in the card. */}
        <div className="hidden flex-col gap-6 pr-2 lg:flex">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 select-none items-center justify-center rounded-md bg-text text-2xl font-semibold text-bg">
              A
            </div>
            <div>
              <h1 className="text-xl leading-tight font-semibold text-text">Aura Platform</h1>
              <MonoLabel className="mt-1">Call intelligence</MonoLabel>
            </div>
          </div>

          {/* The brand line. Kept verbatim; only the type it is set in changed —
              the brutalist uppercase display face is retired (doc 16 §1.2). */}
          <p className="text-4xl leading-tight font-semibold tracking-tight text-text xl:text-5xl">
            Every call,
            <br />
            accounted for.
          </p>

          <ul className="space-y-2.5">
            {HIGHLIGHTS.map((h) => (
              <li key={h} className="flex items-start gap-2.5 text-sm text-text-muted">
                {/* Decorative bullet: aria-hidden so the list is read as three
                    items, not three items each prefixed by a graphic. */}
                <span
                  aria-hidden="true"
                  className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                />
                <span>{h}</span>
              </li>
            ))}
          </ul>
        </div>

        <Card shadow className="w-full space-y-5">
          {/* Compact brand lockup — the panel above replaces it from lg up. */}
          <div className="flex items-center gap-3 lg:hidden">
            <div className="flex h-10 w-10 shrink-0 select-none items-center justify-center rounded-md bg-text text-xl font-semibold text-bg">
              A
            </div>
            <div>
              <h1 className="text-sm leading-tight font-semibold text-text">Aura Platform</h1>
              <MonoLabel className="mt-0.5">Call intelligence</MonoLabel>
            </div>
          </div>

          <div className="hidden lg:block">
            <h2 className="text-2xl leading-tight font-semibold text-text">Sign in</h2>
            <MonoLabel className="mt-1">Workspace access</MonoLabel>
          </div>

          {AUTH_ENABLED ? null : (
            <p className="rounded-md border border-warning bg-warning-subtle p-3 text-sm leading-relaxed text-warning-text">
              Supabase auth not configured — set NEXT_PUBLIC_SUPABASE_URL and
              NEXT_PUBLIC_SUPABASE_ANON_KEY, then restart the web app.
            </p>
          )}

          <LoginForm next={next} configured={AUTH_ENABLED} />
        </Card>
      </div>
    </main>
  );
}
